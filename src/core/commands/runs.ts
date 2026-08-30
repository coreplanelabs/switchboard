import { z } from "zod";
import { CommandError, commandDefiner, wrapUntrusted, type Caller, type CommandDef, type CommandRegistry, type JsonValue } from "../commandRegistry.js";
import type { RunEvent } from "../runEvents.js";
import { RUN_ID_PATTERN, RUN_LIST_MAX_LIMIT } from "../runRecord.js";
import { MAX_EVENTS_PAGE, type Result, type RunRecordView, type RunsService } from "../runsService.js";

// The `runs.*` registrations (#157 R8/R9): thin wrappers that translate a parsed
// input plus the resolved caller into `RunsService` calls. Everything a surface
// can learn about a run comes through here. Two rules the service does not
// enforce because they are about the CALLER, not the run:
//   - a channel-pinned caller (`caller.channel`, a namespaced id such as
//     `http:ops`) sees only runs whose `channelId` equals the pin — other runs
//     are `not_found`, never revealed (KTD10);
//   - stored free text (message bodies, tool summaries) leaves wrapped as
//     untrusted content (KTD17). `runs.list` carries none of it by construction.
// None of these commands starts a run (KTD16); `runs.stop` only ends one.

export interface RunsCommandDeps {
  runs: RunsService;
}

const defineCommand = commandDefiner<RunsCommandDeps>();

const runId = z.string().regex(RUN_ID_PATTERN);
const positiveInt = z.coerce.number().int().positive();

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
  input: z.object({
    status: z.enum(["active", "finished", "all"]),
    agent: z.string().min(1).optional(),
    /** Platform-namespaced channel id (`slack:C0123`, `http:ops`). */
    channel: z.string().min(1).optional(),
    sinceMs: z.coerce.number().int().nonnegative().optional(),
    limit: positiveInt.max(RUN_LIST_MAX_LIMIT).optional(),
    before: z.coerce.number().int().nonnegative().optional(),
    beforeId: runId.optional(),
  }),
  scope: "runs:read",
  chatGate: "operator",
  effect: "read",
  describe: "List runs (live and persisted, newest first) — metadata only, never message text.",
  handler: async ({ input, caller, deps }) => {
    let channel = input.channel;
    if (caller.channel !== undefined) {
      // Pinned callers may only ever ask about their own channel.
      if (channel !== undefined && channel !== caller.channel) return { runs: [] };
      channel = caller.channel;
    }
    const { channel: _ignored, ...rest } = input;
    return asJson(await deps.runs.listRuns({ ...rest, ...(channel !== undefined ? { channel } : {}) }));
  },
});

export const runsGet = defineCommand({
  id: "runs.get",
  input: z.object({ id: runId, include: z.enum(["messages"]).optional() }),
  scope: "runs:read",
  chatGate: "operator",
  effect: "read",
  surfaces: { chat: false },
  describe: "One run's record; `include=messages` adds its events with free text wrapped as untrusted content.",
  handler: async ({ input, caller, deps }) => {
    const view = await getVisibleRun(deps.runs, input.id, caller, input.include ? { include: input.include } : {});
    if (view.events) view.events = view.events.map(wrapEvent);
    return asJson(view);
  },
});

export const runsEvents = defineCommand({
  id: "runs.events",
  input: z.object({ id: runId, afterSeq: z.coerce.number().int().nonnegative().optional(), limit: positiveInt.max(MAX_EVENTS_PAGE).optional() }),
  scope: "runs:read",
  chatGate: "operator",
  effect: "read",
  surfaces: { chat: false },
  describe: "A page of one run's events after `afterSeq` (server-capped); free text wrapped as untrusted content.",
  handler: async ({ input, caller, deps }) => {
    await assertVisible(deps.runs, input.id, caller);
    const page = unwrap(await deps.runs.getRunEvents(input.id, { afterSeq: input.afterSeq, limit: input.limit }));
    return asJson({ ...page, events: page.events.map(wrapEvent) });
  },
});

export const runsFriction = defineCommand({
  id: "runs.friction",
  input: z.object({ id: runId }),
  scope: "runs:read",
  chatGate: "operator",
  effect: "read",
  surfaces: { chat: false },
  describe: "One run's friction diagnosis (live: computed now; persisted: as stored).",
  handler: async ({ input, caller, deps }) => {
    await assertVisible(deps.runs, input.id, caller);
    return asJson(unwrap(await deps.runs.getRunFriction(input.id)));
  },
});

export const runsStop = defineCommand({
  id: "runs.stop",
  input: z.object({ id: runId, mode: z.enum(["soft", "hard"]) }),
  scope: "runs:write",
  chatGate: "operator",
  effect: "write",
  describe: "Request a live run to stop (`soft` = finish the current step; `hard` = abort now). Records the caller as the actor.",
  handler: async ({ input, caller, deps }) => {
    await assertVisible(deps.runs, input.id, caller);
    return asJson(unwrap(await deps.runs.stopRun(input.id, input.mode, { kind: caller.kind, id: caller.id })));
  },
});

export const runsCommands: readonly CommandDef<RunsCommandDeps, z.ZodType>[] = [runsList, runsGet, runsEvents, runsFriction, runsStop];

export function registerRunsCommands<D extends RunsCommandDeps>(registry: CommandRegistry<D>): void {
  for (const cmd of runsCommands) registry.register(cmd as unknown as CommandDef<D, z.ZodType>);
}
