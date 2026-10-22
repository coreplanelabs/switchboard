import { writeReceiptSelectorSchema } from "../runLedger/writeReceipt.js";
import { runMetadata } from "../runDisplay.js";
import { cancellationFailureMessage } from "../runLedger/cancellation.js";
import { claimObservationCursor } from "../runLedger/claimObservation.js";
import { originalSelectorSchema } from "../runLedger/originalEvidence.js";
import { checkSelectorSchema, type CheckSelector } from "../checkInspection.js";
import { z } from "zod";
import { authorize } from "../authz/authorize.js";
import { allOf, matchesPredicate, ownedBy, predicateFor } from "../authz/predicate.js";
import { visibilityOf } from "../authz/channelDirectory.js";
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
import { formatUsd } from "../modelPricing.js";
import type { ProviderFailureDetails } from "../provider.js";
import type { RunEvent } from "../runEvents.js";
import { SEARCH_MAX_HITS } from "../runLedger/sessionLog.js";
import { PROVISIONAL_LABEL, RUN_ID_PATTERN, RUN_LIST_MAX_LIMIT, SESSION_KEY_PATTERN } from "../runRecord.js";
import { PermanentStoreError, RouteMissingError, TransientStoreError } from "../runStoreWorker.js";
import { originalStorageFailure } from "../storageFailureDiagnostic.js";
import {
  MAX_EVENTS_PAGE,
  runResource,
  type FindingsLedgerView,
  type Result,
  type RunRecordView,
  type RunView,
  type RunsService,
} from "../runsService.js";
import { systemClock } from "../trace/clock.js";
import { unwrapUntrusted } from "../untrusted.js";

// The `runs.*` registrations: thin wrappers that translate typed
// arguments/options plus the resolved caller into `RunsService` calls.
// Everything a surface can learn about a run comes through here. Two rules the
// service does not enforce because they are about the CALLER, not the run:
//   - what the caller may SEE is the authorization policy (authorization.md
//     items 5–7): a point read authorizes `runs:read` (or `stop:write`
//     for `stop`) against the run's own attributes — channel, user, stamped
//     visibility — and a deny is `not_found`, byte-identical to a missing run
//     (the reason goes to the audit line only); a list hands the store
//     `predicateFor(actor, "runs:read", "run")` so nothing is loaded and
//     filtered afterwards. No channel id is compared by hand here.
//   - stored free text (message bodies, tool summaries) leaves wrapped as
//     untrusted content. `runs.list` carries none of it by construction.
// None of these commands starts a run; `runs.stop` only ends one, and
// `runs.settlecheck` retires an original check only from recorded ending proof.
// Surface forms (derived): `runs get <id> [--include messages]`,
// `runs events <id> [--after-seq n] [--limit n]`, `runs friction <id>`,
// `runs stop <id>` / `runs kill <id>`, `runs list [--status …] [--agent …] …`,
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
const idArg = { name: "id", schema: runId, describe: "id of the run" } as const;

/** A hosted parent's soft-stop refusal (record 0060; live-view items 10 and
 *  16), a 409 pointing at the units and the escape — the same sentence the
 *  tokenless stop route writes. */
export const HOSTED_STOP_REFUSAL =
  "this run is a pipeline; its units run in their own threads, so an operator must stop its runner before the parent run can end";

function unwrap<T>(res: Result<T>, what: "run" | "unit" = "run"): T {
  if (res.ok) return res.value;
  if (res.error === "hosted") throw new CommandError("conflict", HOSTED_STOP_REFUSAL);
  if (res.error === "unavailable")
    throw new CommandError("unavailable", cancellationFailureMessage(res.refusal, res.observation));
  throw new CommandError(res.error, res.error === "not_found" ? `no ${what} found` : "the run already finished");
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
  opts: { include?: "messages" | "audience" | "shutdown" } = {},
): Promise<RunRecordView> {
  let read: Awaited<ReturnType<RunsService["getRun"]>>;
  try {
    read = await runs.getRun(id, opts);
  } catch (err) {
    if (err instanceof TransientStoreError) throw new CommandError("unavailable", "History is temporarily unavailable");
    throw err;
  }
  const view = unwrap(read);
  const actor: Actor = caller.actor;
  const decision = authorize(actor, action, runResource(view));
  if (!decision.allow) {
    (deps.denied ?? logDenied)({ commandId, actorId: actor.id, action, reason: decision.reason });
    throw new CommandError("not_found", "no run found");
  }
  return view;
}

function wrapProviderFailure<T extends ProviderFailureDetails>(details: T): T {
  if (!details.diagnostic) return details;
  const { message, response, title, detail } = details.diagnostic;
  return {
    ...details,
    diagnostic: {
      ...details.diagnostic,
      ...(message === undefined ? {} : { message: wrapUntrusted(message) }),
      ...(response === undefined ? {} : { response: wrapUntrusted(response) }),
      ...(title === undefined ? {} : { title: wrapUntrusted(title) }),
      ...(detail === undefined ? {} : { detail: wrapUntrusted(detail) }),
    },
  };
}

function wrapOperator<
  T extends {
    providerFailureDetails?: ProviderFailureDetails;
    telemetry?: import("../routingTelemetry.js").RoutingTelemetry;
  },
>(operator: T): T {
  return {
    ...operator,
    ...(operator.providerFailureDetails
      ? { providerFailureDetails: wrapProviderFailure(operator.providerFailureDetails) }
      : {}),
    ...(operator.telemetry
      ? {
          telemetry: {
            ...operator.telemetry,
            steps: operator.telemetry.steps.map((step) => ({
              ...step,
              ...(step.question === undefined ? {} : { question: wrapUntrusted(step.question) }),
              ...(step.proposal === undefined ? {} : { proposal: wrapUntrusted(step.proposal) }),
              ...(step.validation === undefined ? {} : { validation: wrapUntrusted(step.validation) }),
              ...(step.calls === undefined
                ? {}
                : {
                    calls: step.calls.map((call) => ({
                      ...call,
                      input: wrapUntrusted(call.input),
                      ...(call.result === undefined ? {} : { result: wrapUntrusted(call.result) }),
                    })),
                  }),
            })),
          },
        }
      : {}),
  };
}

function wrapException(
  exception: import("../exceptionDiagnostic.js").ExceptionDiagnostic,
): import("../exceptionDiagnostic.js").ExceptionDiagnostic {
  return {
    ...exception,
    message: wrapUntrusted(exception.message),
    ...(exception.stack === undefined ? {} : { stack: wrapUntrusted(exception.stack) }),
    ...(exception.cause ? { cause: wrapException(exception.cause) } : {}),
  };
}

function wrapStorageFailure(
  diagnostic: import("../storageFailureDiagnostic.js").StorageFailureDiagnostic,
): import("../storageFailureDiagnostic.js").StorageFailureDiagnostic {
  const server = diagnostic.server;
  return {
    ...diagnostic,
    ...(diagnostic.exception ? { exception: wrapException(diagnostic.exception) } : {}),
    ...(server && "exception" in server && server.exception
      ? { server: { ...server, exception: wrapException(server.exception) } }
      : {}),
  };
}

function wrapRunView<T extends RunView>(view: T): Omit<T, "prompt" | "readingDiffAbridge"> {
  // Listings stay metadata-only. A prompt is available through explicit message reads.
  const metadata = runMetadata(view);
  return view.operator ? { ...metadata, operator: wrapOperator(view.operator) } : metadata;
}

/** Every free-text field a JSON surface hands out is wrapped as untrusted: the
 *  narrative texts, the tool summaries and outputs, the notes, and the one
 *  free-text field a span record carries (`span_end.error`). */
export function wrapEvent(e: RunEvent): RunEvent {
  switch (e.type) {
    case "run_title":
      return { ...e, title: wrapUntrusted(e.title) };
    case "input":
    case "context":
    case "assistant":
    case "answer":
      return { ...e, text: wrapUntrusted(e.text) };
    case "tool_call":
      return {
        ...e,
        summary: wrapUntrusted(e.summary),
        ...(e.input === undefined ? {} : { input: wrapUntrusted(e.input) }),
      };
    case "tool_input":
      return { ...e, input: wrapUntrusted(e.input) };
    case "tool_result":
      return {
        ...e,
        summary: wrapUntrusted(e.summary),
        ...(e.output !== undefined ? { output: wrapUntrusted(e.output) } : {}),
      };
    case "run_note":
      return {
        ...e,
        summary: wrapUntrusted(e.summary),
        ...(e.providerFailure ? { providerFailure: wrapProviderFailure(e.providerFailure) } : {}),
        ...(e.storageFailure ? { storageFailure: wrapStorageFailure(e.storageFailure) } : {}),
        ...(e.checkpointFailure
          ? {
              checkpointFailure: {
                ...e.checkpointFailure,
                opening: wrapException(e.checkpointFailure.opening),
                ...(e.checkpointFailure.recovery ? { recovery: wrapException(e.checkpointFailure.recovery) } : {}),
              },
            }
          : {}),
        ...(e.modelFailure
          ? {
              modelFailure: {
                ...e.modelFailure,
                stops: {
                  pi: wrapUntrusted(e.modelFailure.stops.pi),
                  provider: wrapUntrusted(e.modelFailure.stops.provider),
                },
                diagnostic: {
                  ...e.modelFailure.diagnostic,
                  ...(e.modelFailure.diagnostic.responseId === undefined
                    ? {}
                    : { responseId: wrapUntrusted(e.modelFailure.diagnostic.responseId) }),
                  ...(e.modelFailure.diagnostic.error
                    ? {
                        error: Object.fromEntries(
                          Object.entries(e.modelFailure.diagnostic.error).map(([key, value]) => [
                            key,
                            typeof value === "string" ? wrapUntrusted(value) : value,
                          ]),
                        ),
                      }
                    : {}),
                },
              },
            }
          : {}),
      };
    case "operator":
      return wrapOperator(e);
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
    readUser: z
      .string()
      .regex(/^http:[A-Za-z0-9_-]+$/)
      .optional()
      .describe("HTTP requester for a read-scope preview; requires channel and readRepo"),
    readRepo: z
      .string()
      .regex(/^[A-Za-z0-9][A-Za-z0-9_.-]*\/[A-Za-z0-9][A-Za-z0-9_.-]*$/)
      .optional()
      .describe("repository for a read-scope preview; requires HTTP channel and readUser"),
  }),
  action: "runs:read",
  effect: "read",
  describe: "List runs (live and persisted, newest first) — metadata only, never message text.",
  handler: async ({ options, caller, deps }) => {
    // The policy, compiled for this actor, is the store's filter; the
    // `channel` option is a plain filter the caller asked for on top of it, and
    // `--mine` narrows it to the caller's own runs (`ownedBy`: every id the
    // caller means by "me") — a narrowing only, never a widening.
    const { thread, parent, mine, readUser, readRepo, ...rest } = options;
    const readable = predicateFor(caller.actor, "runs:read", "run");
    const visibleTo = mine ? allOf([readable, ownedBy(caller.actor)]) : readable;
    if (
      (readUser === undefined) !== (readRepo === undefined) ||
      (readUser !== undefined && (!rest.channel || !/^http:[A-Za-z0-9_-]+$/.test(rest.channel)))
    )
      throw new CommandError("invalid_input", "readUser and readRepo require each other and an HTTP channel filter");
    let scopeProof;
    if (readUser !== undefined && readRepo !== undefined && rest.channel !== undefined) {
      const readScope = { channelId: rest.channel, userId: readUser, repo: readRepo };
      const channelVisibility = visibilityOf(rest.channel);
      if (channelVisibility !== "machine")
        throw new CommandError("unavailable", "HTTP read scope could not be verified");
      // A permission preview over requested attributes, never a stored run or
      // ending fact. Reuse the exact predicate that filters this caller's page.
      scopeProof = { ...readScope, allowed: matchesPredicate(visibleTo, { ...readScope, channelVisibility }) };
    }
    const page = await (
      await deps.runs()
    ).listRuns({
      ...rest,
      ...(thread !== undefined ? { threadKey: thread } : {}),
      ...(parent !== undefined ? { parentRunId: parent } : {}),
      visibleTo,
    });
    return asJson({ ...page, runs: page.runs.map(wrapRunView), ...(scopeProof ? { readScope: scopeProof } : {}) });
  },
});

export const runsReceipt = defineCommand({
  id: "runs.receipt",
  args: [idArg],
  options: writeReceiptSelectorSchema
    .omit({ runId: true, operation: true })
    .extend({ operation: z.enum(["live-state", "conversation-write"]) }),
  surfaces: { chat: false },
  enabledWhen: (caps) => caps.runLedger,
  action: "runs:read",
  effect: "read",
  describe: "Read one original storage write receipt. Missing proof stays unknown and never permits replay.",
  handler: async ({ args, options, caller, deps }) => {
    const source = await (
      await deps.runs()
    ).writeReceipt({
      runId: args.id,
      ...options,
      operation: options.operation === "live-state" ? "/runs/live-state" : "/runs/session/write",
    });
    if (source.kind !== "source") throw new CommandError("not_found", "no run found");
    const decision = authorize(caller.actor, "runs:read", source.resource);
    if (!decision.allow) {
      (deps.denied ?? logDenied)({
        commandId: "runs.receipt",
        actorId: caller.actor.id,
        action: "runs:read",
        reason: decision.reason,
      });
      throw new CommandError("not_found", "no run found");
    }
    return asJson(source.receipt);
  },
});

export const runsOriginal = defineCommand({
  id: "runs.original",
  args: [idArg],
  options: z.object({ gen: originalSelectorSchema.shape.gen.describe("original owner generation") }),
  surfaces: { chat: false },
  enabledWhen: (caps) => caps.runLedger,
  action: "runs:read",
  effect: "read",
  describe:
    "Inspect bounded stored evidence for one current original. Does not repeat writes, settle a run, or prove process ending.",
  handler: async ({ args, options, caller, deps }) => {
    const source = await (await deps.runs()).originalEvidence({ runId: args.id, gen: options.gen });
    if (source.kind !== "source") throw new CommandError("not_found", "no run found");
    const decision = authorize(caller.actor, "runs:read", source.resource);
    if (!decision.allow) {
      (deps.denied ?? logDenied)({
        commandId: "runs.original",
        actorId: caller.actor.id,
        action: "runs:read",
        reason: decision.reason,
      });
      throw new CommandError("not_found", "no run found");
    }
    return asJson(source.evidence);
  },
});

export const runsRequest = defineCommand({
  id: "runs.request",
  args: [idArg],
  surfaces: { chat: false },
  enabledWhen: (caps) => caps.runLedger,
  action: "runs:read",
  effect: "read",
  describe:
    "Read the original request and dispatch status assigned to this id, even before an agent run exists. This does not prove execution or permit replay.",
  handler: async ({ args, caller, deps }) => {
    const read = await (await deps.runs()).getAdmission(args.id);
    if (read.kind === "unavailable") throw new CommandError("unavailable", "Request status is temporarily unavailable");
    if (read.kind === "not_found") throw new CommandError("not_found", "no request found");
    const decision = authorize(caller.actor, "runs:read", read.resource);
    if (!decision.allow) {
      (deps.denied ?? logDenied)({
        commandId: "runs.request",
        actorId: caller.actor.id,
        action: "runs:read",
        reason: decision.reason,
      });
      throw new CommandError("not_found", "no request found");
    }
    return asJson(read.value);
  },
});

export const runsClaims = defineCommand({
  id: "runs.claims",
  surfaces: { chat: false },
  enabledWhen: (caps) => caps.runLedger,
  options: z.object({
    after: claimObservationCursor.optional().describe("page cursor from the preceding observation page"),
    limit: positiveInt.max(RUN_LIST_MAX_LIMIT).optional().describe("observations per page, at most 200"),
  }),
  action: "runs:read",
  effect: "read",
  describe:
    "List persisted unknown native claim observations. These are not current holds or commit receipts; missing observations do not prove absence.",
  handler: async ({ options, caller, deps }) => {
    try {
      return asJson(
        await (
          await deps.runs()
        ).listClaimObservations({ ...options, visibleTo: predicateFor(caller.actor, "runs:read", "run") }),
      );
    } catch (error) {
      const diagnostic = originalStorageFailure(error);
      try {
        console.error(
          JSON.stringify({
            audit: "runs.claims",
            failure:
              diagnostic?.phase ??
              (error instanceof RouteMissingError
                ? "unsupported"
                : error instanceof PermanentStoreError
                  ? "refused-or-invalid"
                  : "unclassified"),
            ...(diagnostic?.httpStatus === undefined ? {} : { httpStatus: diagnostic.httpStatus }),
            ...(diagnostic?.timing ? { deadlineExceeded: diagnostic.timing.deadlineExceeded } : {}),
          }),
        );
      } catch {
        // Logging cannot change the unavailable result or establish a claim outcome.
      }
      throw new CommandError("unavailable", "Claim observations could not be read; no claim outcome was established.");
    }
  },
});

/** The standing block `runs get` prints under the meta lines (record 0065):
 *  a header with the units seen and the stage counts — an older record's
 *  rounds name no unit, so its newest unnamed round rides the header — then
 *  one line per open unit with its stage, round and pull request. */
function pipelineLines(pipeline: JsonObject): string[] {
  const counts = Object.entries(isObject(pipeline.counts) ? pipeline.counts : {})
    .filter(([, n]) => typeof n === "number" && n > 0)
    .map(([stage, n]) => `${n as number} ${stage}`);
  const total = typeof pipeline.total === "number" ? pipeline.total : 0;
  const last = isObject(pipeline.lastRound)
    ? ` · round ${pipeline.lastRound.index} · ${pipeline.lastRound.agent} ${pipeline.lastRound.outcome}`
    : "";
  const head = `pipeline: ${total} unit${total === 1 ? "" : "s"}${counts.length > 0 ? ` — ${counts.join(" · ")}` : ""}${last}`;
  const rows = (Array.isArray(pipeline.current) ? pipeline.current : [])
    .filter(isObject)
    .map(
      (u) =>
        `  ${String(u.unit)} ${String(u.stage)} · round ${String(u.round)}${typeof u.pr === "number" ? ` · #${u.pr}` : ""}`,
    );
  return [head, ...rows];
}

/** `runs get` on the text surfaces: the record's `key: value` lines, the
 *  pipeline's standing under them for a run that has one (record 0065), and
 *  its cost read as dollars (costs.md item 4c) — the total, then each model —
 *  or `unpriced` where the price table knows no model, never `$0`. */
function renderRunRecord(rawOutput: JsonValue): string {
  // A provisional tombstone (run-history item 27) renders the third state in
  // its status line: the run may still be live in a registry this store-only
  // read cannot see, so `interrupted` would be a misread.
  const output =
    isObject(rawOutput) && rawOutput.provisional === true ? { ...rawOutput, status: PROVISIONAL_LABEL } : rawOutput;
  if (!isObject(output)) return renderCompact("runs.get", output);
  const { pipeline, ...withoutPipeline } = output;
  const standing = isObject(pipeline) ? pipelineLines(pipeline) : [];
  const { cost, ...rest } = withoutPipeline;
  if (!isObject(cost)) return [renderCompact("runs.get", withoutPipeline), ...standing].join("\n");
  const dollars = (usd: unknown): string => (typeof usd === "number" ? formatUsd(usd) : "unpriced");
  const models = Object.entries(isObject(cost.byModel) ? cost.byModel : {}).map(
    ([ref, m]) => `${ref} ${dollars(isObject(m) ? m.usd : undefined)}`,
  );
  return [renderCompact("runs.get", rest), ...standing, `cost: ${[dollars(cost.usd), ...models].join(" · ")}`].join(
    "\n",
  );
}

export const runsGet = defineCommand({
  id: "runs.get",
  args: [idArg],
  options: z.object({
    include: z
      .enum(["messages", "audience", "shutdown"])
      .optional()
      .describe(
        "add events, the audience-refusal diagnostic, or retained shutdown evidence and the current target check",
      ),
  }),
  action: "runs:read",
  effect: "read",
  surfaces: { chat: false },
  describe:
    "One run's record and cost in dollars per model (or unpriced); `--include messages` adds events with free text wrapped as untrusted content; `--include audience` adds a structural refusal diagnostic; `--include shutdown` reads retained shutdown acknowledgements separately from the current target check; it does not contact the runtime.",
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
    return asJson(wrapRunView(view));
  },
  render: renderRunRecord,
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

const checkArgs = [
  idArg,
  { name: "call", schema: checkSelectorSchema.shape.callId, describe: "original recorded check call id" },
] as const;
const checkOptions = z
  .object({ phase: checkSelectorSchema.shape.phase.describe("original metadata or command phase") })
  .strict();

async function inspectRecordedCheck(
  selector: CheckSelector,
  caller: Caller,
  deps: RunsCommandDeps,
  settle: boolean,
): Promise<JsonValue> {
  const runs = await deps.runs();
  let selected: Awaited<ReturnType<RunsService["getCheckSource"]>>;
  try {
    selected = await runs.getCheckSource(selector);
  } catch (error) {
    if (error instanceof TransientStoreError)
      throw new CommandError("unavailable", "History is temporarily unavailable");
    throw error;
  }
  const { run, source } = unwrap(selected);
  const action = settle ? "runs:write" : "runs:read";
  const commandId = settle ? "runs.settlecheck" : "runs.check";
  const resource = source.kind === "source" ? source.source.resource : runResource(run);
  const decision = authorize(caller.actor, action, resource);
  if (!decision.allow) {
    (deps.denied ?? logDenied)({ commandId, actorId: caller.actor.id, action, reason: decision.reason });
    throw new CommandError("not_found", "no run found");
  }
  const inspected = await (settle ? runs.settleCheck(source) : runs.inspectCheck(source));
  return asJson(
    inspected.kind === "known"
      ? {
          ...inspected,
          result: {
            ...inspected.result,
            stdout: wrapUntrusted(inspected.result.stdout),
            stderr: wrapUntrusted(inspected.result.stderr),
          },
        }
      : inspected,
  );
}

export const runsCheck = defineCommand({
  id: "runs.check",
  args: checkArgs,
  options: checkOptions,
  action: "runs:read",
  effect: "read",
  surfaces: { chat: false },
  describe:
    "Inspect an original recorded check without running it again; saved output is wrapped as untrusted content.",
  handler: ({ args, options, caller, deps }) =>
    inspectRecordedCheck({ runId: args.id, callId: args.call, phase: options.phase }, caller, deps, false),
});

export const runsSettleCheck = defineCommand({
  id: "runs.settlecheck",
  args: checkArgs,
  options: checkOptions,
  action: "runs:write",
  effect: "write",
  surfaces: { chat: false },
  describe:
    "Retire one original check after its run finishes, only when saved proof verifies that the original process ended.",
  handler: ({ args, options, caller, deps }) =>
    inspectRecordedCheck({ runId: args.id, callId: args.call, phase: options.phase }, caller, deps, true),
});

export const runsStop = defineCommand({
  id: "runs.stop",
  args: [idArg],
  options: z.object({
    mode: z
      .enum(["soft", "hard"])
      .optional()
      .describe("Deprecated compatibility input. Omit for Stop; use runs kill for destructive removal."),
  }),
  action: "stop:write",
  effect: "write",
  // Ends someone's live run; nothing restarts it.
  annotations: { destructive: true, risk: () => "ends the current turn and cleans up its runtime" },
  describe:
    "End the current turn, clean up the runtime, and keep the run as stopped by user. Records who requested the stop. Needs stop permission for the run.",
  handler: async ({ args, options, caller, deps }) => {
    const runs = await deps.runs();
    await getVisibleRun(runs, args.id, caller, "stop:write", deps, "runs.stop");
    const result = unwrap(await runs.stopRun(args.id, options.mode ?? "hard", { kind: caller.kind, id: caller.id }));
    return asJson({ ...result, mode: options.mode ?? "stop" });
  },
  render: (output) => {
    if (output && typeof output === "object" && !Array.isArray(output)) {
      if (output.state === "stopped") return "✅ Run stopped.";
      if (output.state === "stopping") return "Stop requested. Shutdown is not confirmed.";
      if (output.state === "withdrawn") return "✅ Queued request withdrawn.";
    }
    return renderCompact("runs.stop", output);
  },
});

export const runsDelete = defineCommand({
  id: "runs.delete",
  args: [idArg],
  options: z.object({
    force: flag
      .refine((enabled) => enabled, "force must be true")
      .describe("Delete stored run data even when shutdown is unconfirmed"),
  }),
  action: "runs:write",
  effect: "write",
  annotations: {
    destructive: true,
    risk: () => "permanently deletes this run's stored data without confirming shutdown",
  },
  describe:
    "Delete one run's stored records with --force. Shared conversations and runtime custody remain; shutdown is not confirmed.",
  handler: async ({ args, options, caller, deps }) => {
    if (!options.force)
      throw new CommandError("invalid_input", "Use --force to delete stored data without a shutdown receipt.");
    try {
      const runs = await deps.runs();
      const target = unwrap(await runs.deletionTarget(args.id));
      const decision = authorize(caller.actor, "runs:write", target);
      if (!decision.allow) {
        (deps.denied ?? logDenied)({
          commandId: "runs.delete",
          actorId: caller.actor.id,
          action: "runs:write",
          reason: decision.reason,
        });
        throw new CommandError("not_found", "no run found");
      }
      const result = await runs.deleteRunData(args.id);
      if (!result.ok && result.error === "unavailable")
        throw new CommandError("unavailable", "Stored run deletion could not be confirmed.");
      return asJson(unwrap(result));
    } catch (error) {
      if (
        error instanceof PermanentStoreError ||
        error instanceof TransientStoreError ||
        error instanceof RouteMissingError
      )
        throw new CommandError("unavailable", "Stored run deletion could not be confirmed.");
      throw error;
    }
  },
});

export const runsKill = defineCommand({
  id: "runs.kill",
  args: [idArg],
  options: z.object({}),
  action: "stop:write",
  effect: "write",
  annotations: { destructive: true, risk: () => "kills the runtime and deletes the run row" },
  describe:
    "Kill the runtime without a graceful turn shutdown and delete the run from live and saved run views. Destructive. Needs stop permission for the run.",
  handler: async ({ args, caller, deps }) => {
    const runs = await deps.runs();
    await getVisibleRun(runs, args.id, caller, "stop:write", deps, "runs.kill");
    const result = unwrap(
      await runs.stopRun(args.id, "hard", { kind: caller.kind, id: caller.id }, { destructive: true }),
    );
    return asJson({ ...result, mode: "kill" });
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
  // One thread per unit (record 0055); a row written before that names its review thread too.
  return typeof threads.review === "string"
    ? `unit ${String(o.unit)} — coding thread ${named("coding")}, review thread ${named("review")}`
    : `unit ${String(o.unit)} — thread ${named("coding")}`;
};
const childrenHeader = (o: JsonObject): string => `children of ${String(o.parentRunId)}`;

const unitKeyArg = {
  name: "unit",
  schema: z.string().regex(UNIT_KEY_PATTERN),
  describe: "unit key — `plan-<plan>-<n>:U16` (`<n>`: the plan's nth pipeline), `ship-<run id>:task`",
} as const;

export const runsUnit = defineCommand({
  id: "runs.unit",
  args: [unitKeyArg],
  action: "runs:read",
  effect: "read",
  describe: "A ship unit's runs in round order — its thread's, live and finished, each with its round — from one read.",
  handler: async ({ args, caller, deps }) => {
    const visibleTo = predicateFor(caller.actor, "runs:read", "run");
    const unit = unwrap(await (await deps.runs()).listUnitRuns(args.unit, visibleTo), "unit");
    return asJson({ ...unit, runs: unit.runs.map(wrapRunView) });
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
    return asJson({ parentRunId: args.id, runs: children.map(wrapRunView) });
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
  runsOriginal,
  runsRequest,
  runsReceipt,
  runsClaims,
  runsGet,
  runsEvents,
  runsFriction,
  runsCheck,
  runsSettleCheck,
  runsStop,
  runsKill,
  runsDelete,
  runsUnit,
  runsChildren,
  runsFindings,
  runsSearch,
] as unknown as CommandDef<RunsCommandDeps>[];

export function registerRunsCommands<D extends RunsCommandDeps>(registry: CommandRegistry<D>): void {
  for (const cmd of runsCommands) registry.register(cmd as unknown as CommandDef<D>);
}
