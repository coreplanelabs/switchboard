import { z } from "zod";
import { authorize } from "../authz/authorize.js";
import { predicateFor } from "../authz/predicate.js";
import type { Action, Actor, Resource } from "../authz/types.js";
import { CommandError, commandDefiner, wrapUntrusted, type Caller, type CommandDef, type CommandRegistry, type JsonValue } from "../commandRegistry.js";
import type { RunEvent } from "../runEvents.js";
import { RUN_ID_PATTERN, RUN_LIST_MAX_LIMIT } from "../runRecord.js";
import { MAX_EVENTS_PAGE, type Result, type RunRecordView, type RunsService } from "../runsService.js";

// The `runs.*` registrations (#157 R8/R9): thin wrappers that translate typed
// arguments/options plus the resolved caller into `RunsService` calls.
// Everything a surface can learn about a run comes through here. Two rules the
// service does not enforce because they are about the CALLER, not the run:
//   - what the caller may SEE is the authorization policy (authorization.md
//     items 5–7, R1/R5/R6): a point read authorizes `runs:read` (or `runs:write`
//     for `stop`) against the run's own attributes — channel, user, stamped
//     visibility — and a deny is `not_found`, byte-identical to a missing run
//     (KTD8; the reason goes to the audit line only); a list hands the store
//     `predicateFor(actor, "runs:read", "run")` so nothing is loaded and
//     filtered afterwards. No channel id is compared by hand here.
//   - stored free text (message bodies, tool summaries) leaves wrapped as
//     untrusted content (KTD17). `runs.list` carries none of it by construction.
// None of these commands starts a run (KTD16); `runs.stop` only ends one.
// Surface forms (derived): `runs get <id> [--include messages]`,
// `runs events <id> [--after-seq n] [--limit n]`, `runs friction <id>`,
// `runs stop <id> --mode soft|hard`, `runs list [--status …] [--agent …] …`.

/** One denied point read, for the audit line: who, what, why — never which run
 *  (existence is not revealed even to the log, and the reason is a bare token). */
export interface RunReadDenied {
  commandId: string;
  actorId: string;
  action: Action;
  reason: string;
}

export interface RunsCommandDeps {
  /** Resolved on first use: the CLI opens the run store lazily behind an async config open. */
  runs(): Promise<RunsService>;
  /** Where a denied point read is recorded (KTD8). Default: one JSON line on `console.log`. */
  denied?: (entry: RunReadDenied) => void;
}

const defineCommand = commandDefiner<RunsCommandDeps>();

const runId = z.string().regex(RUN_ID_PATTERN);
const positiveInt = z.coerce.number().int().positive();
const idArg = { name: "id", schema: runId, describe: "run id" } as const;

function unwrap<T>(res: Result<T>): T {
  if (res.ok) return res.value;
  throw new CommandError(res.error, res.error === "not_found" ? "run not found" : "run already finished");
}

/** The run as a typed `Resource`: exactly the attributes the policy rows read.
 *  A view without the stamp is `unknown` — never public. */
function runResource(view: RunRecordView): Resource {
  return {
    type: "run",
    id: view.id,
    channelId: view.channelId ?? "",
    userId: view.userId ?? "",
    ...(view.repo !== undefined ? { repo: view.repo } : {}),
    channelVisibility: view.channelVisibility ?? "unknown",
  };
}

const logDenied = (entry: RunReadDenied): void => console.log(JSON.stringify({ audit: "authz", ...entry }));

/** The run as this caller may see it — ONE fetch serves both the authorization
 *  and the payload. `authorize(actor, action, run)` decides on the run's own
 *  attributes (R1); a deny is the same `not_found` an unknown id gives, so
 *  existence is never revealed (KTD8), and its reason reaches the audit line only. */
async function getVisibleRun(runs: RunsService, id: string, caller: Caller, action: Action, deps: RunsCommandDeps, commandId: string, opts: { include?: "messages" } = {}): Promise<RunRecordView> {
  const view = unwrap(await runs.getRun(id, opts));
  const actor: Actor = caller.actor;
  const decision = authorize(actor, action, runResource(view));
  if (!decision.allow) {
    (deps.denied ?? logDenied)({ commandId, actorId: actor.id, action, reason: decision.reason });
    throw new CommandError("not_found", "run not found");
  }
  return view;
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
  action: "runs:read",
  effect: "read",
  describe: "List runs (live and persisted, newest first) — metadata only, never message text.",
  handler: async ({ options, caller, deps }) => {
    // The policy, compiled for this actor, is the store's filter (R6); the
    // `channel` option is a plain filter the caller asked for on top of it.
    const visibleTo = predicateFor(caller.actor, "runs:read", "run");
    return asJson(await (await deps.runs()).listRuns({ ...options, visibleTo }));
  },
});

export const runsGet = defineCommand({
  id: "runs.get",
  args: [idArg],
  options: z.object({ include: z.enum(["messages"]).optional().describe("add the run's events, free text wrapped as untrusted content") }),
  action: "runs:read",
  effect: "read",
  surfaces: { chat: false },
  describe: "One run's record; `--include messages` adds its events with free text wrapped as untrusted content.",
  handler: async ({ args, options, caller, deps }) => {
    const view = await getVisibleRun(await deps.runs(), args.id, caller, "runs:read", deps, "runs.get", options.include ? { include: options.include } : {});
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
  action: "runs:read",
  effect: "read",
  surfaces: { chat: false },
  describe: "A page of one run's events after `--after-seq` (server-capped); free text wrapped as untrusted content.",
  handler: async ({ args, options, caller, deps }) => {
    const runs = await deps.runs();
    await getVisibleRun(runs, args.id, caller, "runs:read", deps, "runs.events");
    const page = unwrap(await runs.getRunEvents(args.id, { afterSeq: options.afterSeq, limit: options.limit }));
    return asJson({ ...page, events: page.events.map(wrapEvent) });
  },
});

export const runsFriction = defineCommand({
  id: "runs.friction",
  args: [idArg],
  action: "runs:read",
  effect: "read",
  surfaces: { chat: false },
  describe: "One run's friction diagnosis (live: computed now; persisted: as stored).",
  handler: async ({ args, caller, deps }) => {
    const runs = await deps.runs();
    await getVisibleRun(runs, args.id, caller, "runs:read", deps, "runs.friction");
    return asJson(unwrap(await runs.getRunFriction(args.id)));
  },
});

export const runsStop = defineCommand({
  id: "runs.stop",
  args: [idArg],
  options: z.object({ mode: z.enum(["soft", "hard"]).describe("soft = finish the current step; hard = abort now") }),
  action: "runs:write",
  effect: "write",
  describe: "Request a live run to stop (`--mode soft` = finish the current step; `hard` = abort now). Records the caller as the actor.",
  handler: async ({ args, options, caller, deps }) => {
    const runs = await deps.runs();
    await getVisibleRun(runs, args.id, caller, "runs:write", deps, "runs.stop");
    return asJson(unwrap(await runs.stopRun(args.id, options.mode, { kind: caller.kind, id: caller.id })));
  },
});

export const runsCommands: readonly CommandDef<RunsCommandDeps>[] = [runsList, runsGet, runsEvents, runsFriction, runsStop] as unknown as CommandDef<RunsCommandDeps>[];

export function registerRunsCommands<D extends RunsCommandDeps>(registry: CommandRegistry<D>): void {
  for (const cmd of runsCommands) registry.register(cmd as unknown as CommandDef<D>);
}
