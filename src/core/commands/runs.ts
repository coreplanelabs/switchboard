import { z } from "zod";
import { authorize } from "../authz/authorize.js";
import { allOf, ownedBy, predicateFor } from "../authz/predicate.js";
import type { Action, Actor } from "../authz/types.js";
import {
  CommandError,
  commandDefiner,
  flag,
  renderCompact,
  renderRunLine,
  wrapUntrusted,
  type Caller,
  type CommandDef,
  type CommandRegistry,
  type JsonObject,
  type JsonValue,
} from "../commandRegistry.js";
import { UNIT_KEY_PATTERN } from "../coordinator/contract.js";
import { parsePullRequestRef, PULL_REQUEST_REF_PATTERN, type FindingRow } from "../findingsLedger.js";
import type { RunEvent } from "../runEvents.js";
import { SEARCH_MAX_HITS } from "../runLedger/sessionLog.js";
import { RUN_ID_PATTERN, RUN_LIST_MAX_LIMIT, SESSION_KEY_PATTERN } from "../runRecord.js";
import {
  MAX_EVENTS_PAGE,
  runResource,
  type FindingsLedgerView,
  type Result,
  type RunRecordView,
  type RunsService,
} from "../runsService.js";
import { systemClock } from "../trace/clock.js";
import { unwrapUntrusted } from "../untrusted.js";

// The `runs.*` registrations: thin wrappers that translate typed
// arguments/options plus the resolved caller into `RunsService` calls.
// Everything a surface can learn about a run comes through here. Two rules the
// service does not enforce because they are about the CALLER, not the run:
//   - what the caller may SEE is the authorization policy (authorization.md
//     items 5–7): a point read authorizes `runs:read` (or `runs:write`
//     for `stop`) against the run's own attributes — channel, user, stamped
//     visibility — and a deny is `not_found`, byte-identical to a missing run
//     (the reason goes to the audit line only); a list hands the store
//     `predicateFor(actor, "runs:read", "run")` so nothing is loaded and
//     filtered afterwards. No channel id is compared by hand here.
//   - stored free text (message bodies, tool summaries) leaves wrapped as
//     untrusted content. `runs.list` carries none of it by construction.
// None of these commands starts a run; `runs.stop` only ends one.
// Surface forms (derived): `runs get <id> [--include messages]`,
// `runs events <id> [--after-seq n] [--limit n]`, `runs friction <id>`,
// `runs stop <id> --mode soft|hard`, `runs list [--status …] [--agent …] …`,
// `runs unit <instance:unit>`, `runs children <id>`, `runs findings <owner/repo#N>`,
// `runs search <session> <words…> [--limit n]`.
//
// The three listings that read across runs (the unit is the reading unit,
// docs/reference/specs/agent-ship.md item 17) are the same shape as `runs
// list`: `RunView`s the run page renders, under the caller's predicate, no
// message text — except `runs search`, whose hits carry one line of the log
// and leave wrapped as untrusted, as `runs events` does. `runs findings`
// (agent-ship item 18) joins a pull request's records by finding id: a
// finding's title and a disposition's note are the reviewer's and the coding
// run's own words, so they leave the JSON surfaces wrapped the same way and
// the text renderers unwrap them for the person reading the table.

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
  /** Where a denied point read is recorded. Default: one JSON line on `console.log`. */
  denied?: (entry: RunReadDenied) => void;
}

const defineCommand = commandDefiner<RunsCommandDeps>();

const runId = z.string().regex(RUN_ID_PATTERN);
const positiveInt = z.coerce.number().int().positive();
const idArg = { name: "id", schema: runId, describe: "run id" } as const;

function unwrap<T>(res: Result<T>, what: "run" | "unit" = "run"): T {
  if (res.ok) return res.value;
  throw new CommandError(res.error, res.error === "not_found" ? `${what} not found` : "run already finished");
}

/** What `runs findings` says when no run the caller may see names the pull
 *  request — an unknown one, one no run worked on and one whose runs are all
 *  outside the predicate are one answer. */
export const NO_RUNS_NAME_PR = "no runs name this pull request";

/** How many hits `runs search` answers without `--limit`: a page a person reads, twice `recall`'s five. */
export const SESSION_SEARCH_DEFAULT_HITS = 10;

const logDenied = (entry: RunReadDenied): void => console.log(JSON.stringify({ audit: "authz", ...entry }));

/** The run as this caller may see it — ONE fetch serves both the authorization
 *  and the payload. `authorize(actor, action, run)` decides on the run's own
 *  attributes; a deny is the same `not_found` an unknown id gives, so
 *  existence is never revealed, and its reason reaches the audit line only. */
async function getVisibleRun(
  runs: RunsService,
  id: string,
  caller: Caller,
  action: Action,
  deps: RunsCommandDeps,
  commandId: string,
  opts: { include?: "messages" } = {},
): Promise<RunRecordView> {
  const view = unwrap(await runs.getRun(id, opts));
  const actor: Actor = caller.actor;
  const decision = authorize(actor, action, runResource(view));
  if (!decision.allow) {
    (deps.denied ?? logDenied)({ commandId, actorId: actor.id, action, reason: decision.reason });
    throw new CommandError("not_found", "run not found");
  }
  return view;
}

/** Every free-text field a JSON surface hands out is wrapped as untrusted: the
 *  narrative texts, the tool summaries and outputs, the notes, and the one
 *  free-text field a span record carries (`span_end.error`). */
export function wrapEvent(e: RunEvent): RunEvent {
  switch (e.type) {
    case "input":
    case "context":
    case "assistant":
    case "answer":
      return { ...e, text: wrapUntrusted(e.text) };
    case "tool_call":
      return { ...e, summary: wrapUntrusted(e.summary) };
    case "tool_result":
      return {
        ...e,
        summary: wrapUntrusted(e.summary),
        ...(e.output !== undefined ? { output: wrapUntrusted(e.output) } : {}),
      };
    case "run_note":
      return { ...e, summary: wrapUntrusted(e.summary) };
    case "span_end":
      // The one free-text field a span record carries (docs/reference/specs/tracing.md).
      return e.error !== undefined ? { ...e, error: wrapUntrusted(e.error) } : e;
    default:
      return e;
  }
}

const asJson = (v: unknown): JsonValue => v as JsonValue;

export const runsList = defineCommand({
  id: "runs.list",
  options: z.object({
    status: z
      .enum(["active", "finished", "all"])
      .default("active")
      .describe("which runs: live (default), persisted, or both"),
    agent: z.string().min(1).optional().describe("only runs of this agent"),
    channel: z
      .string()
      .min(1)
      .optional()
      .describe("only runs in this platform-namespaced channel (`slack:C0123`, `http:ops`)"),
    thread: z
      .string()
      .min(1)
      .optional()
      .describe(
        "only runs in this thread, newest first (`slack:C0123:1712.34` — a thread's story, its sessions' runs)",
      ),
    parent: runId
      .optional()
      .describe("only the runs this run spawned or that continue a thread it opened (a conductor's children)"),
    sinceMs: z.coerce.number().int().nonnegative().optional().describe("only runs started at or after this epoch ms"),
    limit: positiveInt.max(RUN_LIST_MAX_LIMIT).optional().describe(`page size (max ${RUN_LIST_MAX_LIMIT})`),
    before: z.coerce
      .number()
      .int()
      .nonnegative()
      .optional()
      .describe("page cursor: runs finished before this epoch ms"),
    beforeId: runId.optional().describe("page cursor tie-breaker: the last id of the previous page"),
    mine: flag
      .optional()
      .describe("only the runs you requested — for a dashboard session, the Slack user its email names (record 0042)"),
  }),
  action: "runs:read",
  effect: "read",
  describe: "List runs (live and persisted, newest first) — metadata only, never message text.",
  handler: async ({ options, caller, deps }) => {
    // The policy, compiled for this actor, is the store's filter; the
    // `channel` option is a plain filter the caller asked for on top of it, and
    // `--mine` narrows it to the caller's own runs (`ownedBy`: every id the
    // caller means by "me") — a narrowing only, never a widening.
    const { thread, parent, mine, ...rest } = options;
    const readable = predicateFor(caller.actor, "runs:read", "run");
    const visibleTo = mine ? allOf([readable, ownedBy(caller.actor)]) : readable;
    return asJson(
      await (
        await deps.runs()
      ).listRuns({
        ...rest,
        ...(thread !== undefined ? { threadKey: thread } : {}),
        ...(parent !== undefined ? { parentRunId: parent } : {}),
        visibleTo,
      }),
    );
  },
});

export const runsGet = defineCommand({
  id: "runs.get",
  args: [idArg],
  options: z.object({
    include: z.enum(["messages"]).optional().describe("add the run's events, free text wrapped as untrusted content"),
  }),
  action: "runs:read",
  effect: "read",
  surfaces: { chat: false },
  describe: "One run's record; `--include messages` adds its events with free text wrapped as untrusted content.",
  handler: async ({ args, options, caller, deps }) => {
    const view = await getVisibleRun(
      await deps.runs(),
      args.id,
      caller,
      "runs:read",
      deps,
      "runs.get",
      options.include ? { include: options.include } : {},
    );
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
  // Ends someone's live run; nothing restarts it.
  annotations: { destructive: true, risk: () => "stops a live run; hard aborts it now" },
  describe:
    "Request a live run to stop (`--mode soft` = finish the current step; `hard` = abort now). Records the caller as the actor.",
  handler: async ({ args, options, caller, deps }) => {
    const runs = await deps.runs();
    await getVisibleRun(runs, args.id, caller, "runs:write", deps, "runs.stop");
    return asJson(unwrap(await runs.stopRun(args.id, options.mode, { kind: caller.kind, id: caller.id })));
  },
});

const isObject = (v: unknown): v is JsonObject => typeof v === "object" && v !== null && !Array.isArray(v);

/** The text surfaces' listing of runs: one `renderRunLine` per run under a
 *  header, `(none)` for an empty one. `unit` runs carry their round and thread
 *  after the line. Chat gets single spaces (columns collapse in a proportional
 *  font); the terminal gets the aligned columns `runs list` prints. */
function renderRuns(
  commandId: string,
  output: JsonValue,
  surface: "chat" | "text",
  header: (o: JsonObject) => string,
): string {
  if (!isObject(output) || !Array.isArray(output.runs)) return renderCompact(commandId, output);
  const now = systemClock();
  const lines = output.runs.filter(isObject).map((r) => {
    const line = renderRunLine(r, now, surface);
    if (typeof r.round !== "number" || typeof r.thread !== "string") return line;
    return surface === "chat" ? `${line} · round ${r.round} ${r.thread}` : `${line}  round ${r.round} ${r.thread}`;
  });
  return [header(output), ...(lines.length === 0 ? ["(none)"] : lines)].join("\n");
}

const unitHeader = (o: JsonObject): string => {
  const threads = isObject(o.threads) ? o.threads : {};
  const named = (k: "coding" | "review") => (typeof threads[k] === "string" ? threads[k] : "not opened yet");
  return `unit ${String(o.unit)} — coding thread ${named("coding")}, review thread ${named("review")}`;
};
const childrenHeader = (o: JsonObject): string => `children of ${String(o.parentRunId)}`;

const unitKeyArg = {
  name: "unit",
  schema: z.string().regex(UNIT_KEY_PATTERN),
  describe: "unit key `<instance>:<unit>` — `plan-<plan>-<attempt>:U16`, `ship-<run id>:task`",
} as const;

export const runsUnit = defineCommand({
  id: "runs.unit",
  args: [unitKeyArg],
  action: "runs:read",
  effect: "read",
  describe:
    "A ship unit's runs in round order — its coding thread's and its review thread's, live and finished, each with its round and thread — from one read.",
  handler: async ({ args, caller, deps }) => {
    const visibleTo = predicateFor(caller.actor, "runs:read", "run");
    return asJson(unwrap(await (await deps.runs()).listUnitRuns(args.unit, visibleTo), "unit"));
  },
  render: (output) => renderRuns("runs.unit", output, "text", unitHeader),
  renderChat: (output) => renderRuns("runs.unit", output, "chat", unitHeader),
});

export const runsChildren = defineCommand({
  id: "runs.children",
  args: [idArg],
  action: "runs:read",
  effect: "read",
  describe: "The runs one run spawned — a conductor's children, live and finished — oldest started first.",
  handler: async ({ args, caller, deps }) => {
    const runs = await deps.runs();
    await getVisibleRun(runs, args.id, caller, "runs:read", deps, "runs.children");
    const children = await runs.listChildren(args.id, predicateFor(caller.actor, "runs:read", "run"));
    return asJson({ parentRunId: args.id, runs: children });
  },
  render: (output) => renderRuns("runs.children", output, "text", childrenHeader),
  renderChat: (output) => renderRuns("runs.children", output, "chat", childrenHeader),
});

const prArg = {
  name: "pr",
  schema: z.string().regex(PULL_REQUEST_REF_PATTERN),
  describe: "the pull request — `owner/repo#N` or its GitHub URL",
} as const;

/** A finding's title and a disposition's note are stored free text (the
 *  reviewer's words, the coding run's): fenced on the way out, as a search
 *  snippet is. Everything else on a row is structured. */
function wrapFinding(row: FindingRow): FindingRow {
  return {
    ...row,
    ...(row.title !== undefined ? { title: wrapUntrusted(row.title) } : {}),
    ...(row.disposition !== undefined
      ? { disposition: { ...row.disposition, note: wrapUntrusted(row.disposition.note) } }
      : {}),
  };
}

export const runsFindings = defineCommand({
  id: "runs.findings",
  args: [prArg],
  action: "runs:read",
  effect: "read",
  enabledWhen: (caps) => caps.runHistory,
  describe:
    "A pull request's findings ledger — every review finding by id with its severity, where it was raised, what the coding run recorded against it and whether the next review agreed — read from the run records alone.",
  handler: async ({ args, caller, deps }) => {
    const pr = parsePullRequestRef(args.pr);
    if (!pr) throw new CommandError("invalid_input", "pr must be `owner/repo#N` or a pull request URL");
    const visibleTo = predicateFor(caller.actor, "runs:read", "run");
    const res = await (await deps.runs()).listFindings(pr, visibleTo);
    if (!res.ok) throw new CommandError("not_found", NO_RUNS_NAME_PR);
    const view: FindingsLedgerView = { ...res.value, findings: res.value.findings.map(wrapFinding) };
    return asJson(view);
  },
  render: (output) => renderFindings(output, "text"),
  renderChat: (output) => renderFindings(output, "chat"),
});

/** The text surfaces' ledger: a header naming the pull request, the unit when
 *  one names it, and the status tally; then one line per finding — id,
 *  severity, `file:line`, title, status (with the kind a re-raise answered) and
 *  the disposition's note. The terminal gets aligned columns; chat gets one
 *  bullet with ` · ` between the fields. Titles and notes are unwrapped here:
 *  a person reads the table, the fence is for the JSON surfaces. */
function renderFindings(output: JsonValue, surface: "chat" | "text"): string {
  if (!isObject(output) || !Array.isArray(output.findings) || !isObject(output.pr)) {
    return renderCompact("runs.findings", output);
  }
  const rows = output.findings.filter(isObject);
  const tally = new Map<string, number>();
  for (const r of rows) if (typeof r.status === "string") tally.set(r.status, (tally.get(r.status) ?? 0) + 1);
  const counts = [...tally.entries()].map(([status, n]) => `${n} ${status}`).join(" · ");
  const unit = typeof output.unit === "string" ? ` (unit ${output.unit})` : "";
  const header = `findings for ${String(output.repo)}#${String(output.pr.number)}${unit} — ${rows.length} finding${rows.length === 1 ? "" : "s"}${counts ? `: ${counts}` : ""}`;
  const cells = rows.map((r) => {
    const disposition = isObject(r.disposition) ? r.disposition : undefined;
    const status =
      r.status === "re-raised" && typeof r.reRaisedAfter === "string"
        ? `re-raised after ${r.reRaisedAfter}`
        : String(r.status);
    return {
      id: String(r.id),
      severity: typeof r.severity === "string" ? r.severity : "-",
      where: typeof r.file === "string" ? (typeof r.line === "number" ? `${r.file}:${r.line}` : r.file) : "-",
      title: typeof r.title === "string" ? unwrapUntrusted(r.title) : "-",
      status,
      note: disposition && typeof disposition.note === "string" ? unwrapUntrusted(disposition.note) : "",
    };
  });
  if (surface === "chat") {
    const lines = cells.map(
      (c) => `• \`${c.id}\` · ${c.severity} · ${c.where} · ${c.title} · ${c.status}${c.note ? ` — ${c.note}` : ""}`,
    );
    return [header, ...(lines.length === 0 ? ["(none)"] : lines)].join("\n");
  }
  const width = (k: "id" | "severity" | "where" | "title" | "status") => Math.max(...cells.map((c) => c[k].length), 1);
  const w = {
    id: width("id"),
    severity: width("severity"),
    where: width("where"),
    title: width("title"),
    status: width("status"),
  };
  const lines = cells.map((c) =>
    `${c.id.padEnd(w.id)}  ${c.severity.padEnd(w.severity)}  ${c.where.padEnd(w.where)}  ${c.title.padEnd(w.title)}  ${c.status.padEnd(w.status)}  ${c.note}`.trimEnd(),
  );
  return [header, ...(lines.length === 0 ? ["(none)"] : lines)].join("\n");
}

export const runsSearch = defineCommand({
  id: "runs.search",
  args: [
    {
      name: "session",
      schema: z.string().regex(SESSION_KEY_PATTERN),
      describe: "session key `<thread key>:<agent>` (`slack:C0123:1712.34:coding`) — one session's log, never several",
    },
    {
      name: "query",
      schema: z.string().min(1).max(1024),
      describe: "words to search for; matching is by word, in relevance order",
      rest: true,
    },
  ],
  options: z.object({
    limit: positiveInt
      .max(SEARCH_MAX_HITS)
      .optional()
      .describe(`hits to return (default ${SESSION_SEARCH_DEFAULT_HITS}, max ${SEARCH_MAX_HITS})`),
  }),
  action: "runs:read",
  effect: "read",
  surfaces: { chat: false },
  describe:
    "Search one session's log — a thread's conversation on one agent, every run of it — for words: the matching turns in relevance order, each with its run; snippets wrapped as untrusted content.",
  handler: async ({ args, options, caller, deps }) => {
    const found = await (
      await deps.runs()
    ).searchSession(
      args.session,
      args.query,
      options.limit ?? SESSION_SEARCH_DEFAULT_HITS,
      predicateFor(caller.actor, "runs:read", "run"),
    );
    return asJson({ ...found, hits: found.hits.map((h) => ({ ...h, snippet: wrapUntrusted(h.snippet) })) });
  },
});

export const runsCommands: readonly CommandDef<RunsCommandDeps>[] = [
  runsList,
  runsGet,
  runsEvents,
  runsFriction,
  runsStop,
  runsUnit,
  runsChildren,
  runsFindings,
  runsSearch,
] as unknown as CommandDef<RunsCommandDeps>[];

export function registerRunsCommands<D extends RunsCommandDeps>(registry: CommandRegistry<D>): void {
  for (const cmd of runsCommands) registry.register(cmd as unknown as CommandDef<D>);
}
