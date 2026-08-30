import { z } from "zod";
import { CommandError, commandDefiner, wrapUntrusted, type Caller, type CommandDef, type CommandRegistry, type JsonValue } from "../commandRegistry.js";
import type { RunEvent } from "../runEvents.js";
import { RUN_ID_PATTERN, RUN_LIST_MAX_LIMIT } from "../runRecord.js";
import { MAX_EVENTS_PAGE, type Result, type RunRecordView, type RunsService } from "../runsService.js";

// The `runs.*` registrations (#157 R8/R9): thin wrappers that translate typed
// arguments/options plus the resolved caller into `RunsService` calls.
// Everything a surface can learn about a run comes through here. Two rules the
// service does not enforce because they are about the CALLER, not the run:
//   - a channel-pinned caller (`caller.channel`, a namespaced id such as
//     `http:ops`) sees only runs whose `channelId` equals the pin — other runs
//     are `not_found`, never revealed (KTD10);
//   - stored free text (message bodies, tool summaries) leaves wrapped as
//     untrusted content (KTD17). `runs.list` carries none of it by construction.
// None of these commands starts a run (KTD16); `runs.stop` only ends one.
// Surface forms (derived): `runs get <id> [--include messages]`,
// `runs events <id> [--after-seq n] [--limit n]`, `runs friction <id>`,
// `runs stop <id> --mode soft|hard`, `runs list [--status …] [--agent …] …`.

export interface RunsCommandDeps {
  runs: RunsService;
}

const defineCommand = commandDefiner<RunsCommandDeps>();

const runId = z.string().regex(RUN_ID_PATTERN);
const positiveInt = z.coerce.number().int().positive();
const idArg = { name: "id", schema: runId, describe: "run id" } as const;

function unwrap<T>(res: Result<T>): T {
  if (res.ok) return res.value;
  throw new CommandError(res.error, res.error === "not_found" ? "run not found" : "run already finished");
}

/** The run as this caller may see it — ONE fetch serves both the visibility check
 *  and the payload. A channel-pinned caller's run must sit in its channel; any
 *  other run (or none) is the same `not_found`, so existence is never revealed. */
async function getVisibleRun(runs: RunsService, id: string, caller: Caller, opts: { include?: "messages" } = {}): Promise<RunRecordView> {
  const view = unwrap(await runs.getRun(id, opts));
  if (caller.channel !== undefined && view.channelId !== caller.channel) throw new CommandError("not_found", "run not found");
  return view;
}

/** For the commands whose payload is not the run view (events, friction, stop):
 *  a pinned caller must be able to see the run before the real read/write; an
 *  unpinned caller skips the lookup — the payload call's own `not_found` covers it. */
async function assertVisible(runs: RunsService, id: string, caller: Caller): Promise<void> {
  if (caller.channel !== undefined) await getVisibleRun(runs, id, caller);
}

function wrapEvent(e: RunEvent): RunEvent {
  switch (e.type) {
    case "input":
    case "context":
    case "assistant":
    case "answer":
      return { ...e, text: wrapUntrusted(e.text) };
    case "tool_call":
    case "tool_result":
      return { ...e, summary: wrapUntrusted(e.summary) };
    case "run_note":
      return { ...e, summary: wrapUntrusted(e.summary) };
    default:
      return e;
  }
}

const asJson = (v: unknown): JsonValue => v as JsonValue;

export const runsList = defineCommand({
  id: "runs.list",
  options: z.object({
    status: z.enum(["active", "finished", "all"]).default("active").describe("which runs: live (default), persisted, or both"),
    agent: z.string().min(1).optional().describe("only runs of this agent"),
    channel: z.string().min(1).optional().describe("only runs in this platform-namespaced channel (`slack:C0123`, `http:ops`)"),
    sinceMs: z.coerce.number().int().nonnegative().optional().describe("only runs started at or after this epoch ms"),
    limit: positiveInt.max(RUN_LIST_MAX_LIMIT).optional().describe(`page size (max ${RUN_LIST_MAX_LIMIT})`),
    before: z.coerce.number().int().nonnegative().optional().describe("page cursor: runs finished before this epoch ms"),
    beforeId: runId.optional().describe("page cursor tie-breaker: the last id of the previous page"),
  }),
  scope: "runs:read",
  chatGate: "operator",
  effect: "read",
  describe: "List runs (live and persisted, newest first) — metadata only, never message text.",
  handler: async ({ options, caller, deps }) => {
    let channel = options.channel;
    if (caller.channel !== undefined) {
      // Pinned callers may only ever ask about their own channel.
      if (channel !== undefined && channel !== caller.channel) return { runs: [] };
      channel = caller.channel;
    }
    const { channel: _ignored, ...rest } = options;
    return asJson(await deps.runs.listRuns({ ...rest, ...(channel !== undefined ? { channel } : {}) }));
  },
});

export const runsGet = defineCommand({
  id: "runs.get",
  args: [idArg],
  options: z.object({ include: z.enum(["messages"]).optional().describe("add the run's events, free text wrapped as untrusted content") }),
  scope: "runs:read",
  chatGate: "operator",
  effect: "read",
  surfaces: { chat: false },
  describe: "One run's record; `--include messages` adds its events with free text wrapped as untrusted content.",
  handler: async ({ args, options, caller, deps }) => {
    const view = await getVisibleRun(deps.runs, args.id, caller, options.include ? { include: options.include } : {});
    if (view.events) view.events = view.events.map(wrapEvent);
    return asJson(view);
  },
});

export const runsEvents = defineCommand({
  id: "runs.events",
  args: [idArg],
  options: z.object({
    afterSeq: z.coerce.number().int().nonnegative().optional().describe("events with seq greater than this"),
    limit: positiveInt.max(MAX_EVENTS_PAGE).optional().describe(`page size (max ${MAX_EVENTS_PAGE})`),
  }),
  scope: "runs:read",
  chatGate: "operator",
  effect: "read",
  surfaces: { chat: false },
  describe: "A page of one run's events after `--after-seq` (server-capped); free text wrapped as untrusted content.",
  handler: async ({ args, options, caller, deps }) => {
    await assertVisible(deps.runs, args.id, caller);
    const page = unwrap(await deps.runs.getRunEvents(args.id, { afterSeq: options.afterSeq, limit: options.limit }));
    return asJson({ ...page, events: page.events.map(wrapEvent) });
  },
});

export const runsFriction = defineCommand({
  id: "runs.friction",
  args: [idArg],
  scope: "runs:read",
  chatGate: "operator",
  effect: "read",
  surfaces: { chat: false },
  describe: "One run's friction diagnosis (live: computed now; persisted: as stored).",
  handler: async ({ args, caller, deps }) => {
    await assertVisible(deps.runs, args.id, caller);
    return asJson(unwrap(await deps.runs.getRunFriction(args.id)));
  },
});

export const runsStop = defineCommand({
  id: "runs.stop",
  args: [idArg],
  options: z.object({ mode: z.enum(["soft", "hard"]).describe("soft = finish the current step; hard = abort now") }),
  scope: "runs:write",
  chatGate: "operator",
  effect: "write",
  describe: "Request a live run to stop (`--mode soft` = finish the current step; `hard` = abort now). Records the caller as the actor.",
  handler: async ({ args, options, caller, deps }) => {
    await assertVisible(deps.runs, args.id, caller);
    return asJson(unwrap(await deps.runs.stopRun(args.id, options.mode, { kind: caller.kind, id: caller.id })));
  },
});

export const runsCommands: readonly CommandDef<RunsCommandDeps>[] = [runsList, runsGet, runsEvents, runsFriction, runsStop] as unknown as CommandDef<RunsCommandDeps>[];

export function registerRunsCommands<D extends RunsCommandDeps>(registry: CommandRegistry<D>): void {
  for (const cmd of runsCommands) registry.register(cmd as unknown as CommandDef<D>);
}
