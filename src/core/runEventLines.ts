import { storageFailureDiagnosticOf } from "./storageFailureDiagnostic.js";
import { isPublicationSettlement } from "./publicationSettlement.js";
import { typedExecutionDiagnosticFrom } from "../execution/typedExecutionDiagnostic.js";
import { execFailureDiagnosticFrom } from "../execution/execFailureDiagnostic.js";
import { PROVIDER_FAILURE_CAUSES } from "./provider.js";
import {
  RUN_NOTE_KINDS,
  RUN_TITLE_DIAGNOSTIC_ERROR_KINDS,
  RUN_TITLE_DIAGNOSTIC_OUTCOMES,
  RUN_TITLE_DIAGNOSTIC_REASONS,
  RUN_TITLE_DIAGNOSTIC_STAGES,
  RUN_TITLE_INVALID_OUTPUT_KINDS,
  RUN_TITLE_PRICE_SOURCES,
  RUN_TITLE_STOP_REASONS,
  type RunEvent,
  type RunNoteKind,
} from "./runEvents.js";
import { RUN_LIVE_STATE_NAMES, type RunLiveStateName } from "./runLiveState.js";
import { PLANE_ENDING_CAUSES, type PlaneEndingCause } from "./plane/decide.js";

// Parsing a SAVED run-event stream — the input of
// `friction analyze`: one JSON object per line, OR a raw SSE capture of
// `/runs/:id/events` (`data: {...}` frames). Analysis-only input handling;
// nothing here touches a run, a sandbox, or GitHub.

// Derived from the union, so a new note kind reaches `friction analyze` the day
// it is added (docs/reference/specs/tracing.md).
const NOTE_KINDS = new Set<RunNoteKind>(RUN_NOTE_KINDS);
const LIVE_STATES = new Set<RunLiveStateName>(RUN_LIVE_STATE_NAMES);
const ENDING_CAUSES = new Set<PlaneEndingCause>(PLANE_ENDING_CAUSES);

/**
 * Parse run events from text: one JSON object per line, OR a raw SSE capture of
 * `/runs/:id/events` (only `data:` lines carry events; `retry:`/`event:`/
 * comment/blank lines are transport; the `{}` payload of the terminal `end`
 * frame is ignored). Malformed lines and non-event payloads are skipped and
 * counted, never thrown — a partially garbled capture still yields a diagnosis.
 */
export function parseRunEventLines(text: string): { events: RunEvent[]; skipped: number } {
  const events: RunEvent[] = [];
  let skipped = 0;
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (line === "" || line.startsWith(":") || /^(retry|event|id):/.test(line)) continue;
    const payload = line.startsWith("data:") ? line.slice("data:".length).trim() : line;
    let parsed: unknown;
    try {
      parsed = JSON.parse(payload);
    } catch {
      skipped++;
      continue;
    }
    if (isRunEvent(parsed)) {
      if (parsed.type === "run_note" && Object.hasOwn(parsed, "storageFailure")) {
        const diagnostic =
          parsed.kind === "storage_failure" ? storageFailureDiagnosticOf(parsed.storageFailure) : undefined;
        if (diagnostic) parsed.storageFailure = diagnostic;
        else delete parsed.storageFailure;
      }
      if (parsed.type === "run_note" && Object.hasOwn(parsed, "executionDiagnostic")) {
        const diagnostic =
          parsed.kind === "run_failed" ? typedExecutionDiagnosticFrom(parsed.executionDiagnostic) : undefined;
        if (diagnostic) parsed.executionDiagnostic = diagnostic;
        else delete parsed.executionDiagnostic;
      }
      if (parsed.type === "run_note" && Object.hasOwn(parsed, "execFailureDiagnostic")) {
        const diagnostic =
          parsed.kind === "run_failed" ? execFailureDiagnosticFrom(parsed.execFailureDiagnostic) : undefined;
        if (diagnostic) parsed.execFailureDiagnostic = diagnostic;
        else delete parsed.execFailureDiagnostic;
      }
      events.push(parsed);
    } else if (!isTransportFrame(parsed)) skipped++; // garbage, or an event-shaped payload this reader does not know
  }
  return { events, skipped };
}

/** A plain object with no `type` is a transport frame — `end`'s `{}` today,
 *  `{ sealedAt, replyOk }` and the `finished`/`replay_elided` payloads later
 *  (docs/reference/specs/tracing.md) — never garbage. Anything else that is not an event
 *  (a number, a string, an array, an object whose `type` this reader does not
 *  know) is skipped and counted. */
function isTransportFrame(v: unknown): boolean {
  return typeof v === "object" && v !== null && !Array.isArray(v) && typeof (v as { type?: unknown }).type !== "string";
}

const nonnegative = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value) && value >= 0;
const nonnegativeCount = (value: unknown): value is number => nonnegative(value) && Number.isSafeInteger(value);

/** Structural check of the fields the analyzer actually relies on — a recognized
 *  `type` alone is not enough, since this input is external (a hand-edited or
 *  corrupted capture must be skipped, never crash the analysis). */
function isRunEvent(v: unknown): v is RunEvent {
  if (typeof v !== "object" || v === null) return false;
  const o = v as Record<string, unknown>;
  if (o.at !== undefined && typeof o.at !== "number") return false;
  switch (o.type) {
    case "run_title":
      return typeof o.title === "string";
    case "run_title_diagnostic":
      return (
        RUN_TITLE_DIAGNOSTIC_OUTCOMES.includes(o.outcome as (typeof RUN_TITLE_DIAGNOSTIC_OUTCOMES)[number]) &&
        RUN_TITLE_DIAGNOSTIC_REASONS.includes(o.reason as (typeof RUN_TITLE_DIAGNOSTIC_REASONS)[number]) &&
        (o.outcome === "generated") === (o.reason === "generated") &&
        RUN_TITLE_DIAGNOSTIC_STAGES.includes(o.stage as (typeof RUN_TITLE_DIAGNOSTIC_STAGES)[number]) &&
        nonnegative(o.ms) &&
        (o.model === undefined || typeof o.model === "string") &&
        (o.errorKind === undefined ||
          RUN_TITLE_DIAGNOSTIC_ERROR_KINDS.includes(
            o.errorKind as (typeof RUN_TITLE_DIAGNOSTIC_ERROR_KINDS)[number],
          )) &&
        (o.providerCause === undefined ||
          PROVIDER_FAILURE_CAUSES.includes(o.providerCause as (typeof PROVIDER_FAILURE_CAUSES)[number])) &&
        (o.providerStatus === undefined ||
          (typeof o.providerStatus === "number" &&
            Number.isInteger(o.providerStatus) &&
            o.providerStatus >= 100 &&
            o.providerStatus <= 599)) &&
        (o.providerInvoked === undefined || typeof o.providerInvoked === "boolean") &&
        (o.sendAttempts === undefined || nonnegativeCount(o.sendAttempts)) &&
        (o.requestId === undefined ||
          (typeof o.requestId === "string" && o.requestId.length <= 128 && !/[\r\n]/.test(o.requestId))) &&
        (o.responseMs === undefined || nonnegative(o.responseMs)) &&
        (o.stopReason === undefined ||
          RUN_TITLE_STOP_REASONS.includes(o.stopReason as (typeof RUN_TITLE_STOP_REASONS)[number])) &&
        ["inputTokens", "outputTokens", "cacheReadTokens", "cacheWriteTokens", "outputChars"].every(
          (key) => o[key] === undefined || nonnegativeCount(o[key]),
        ) &&
        (o.cacheOverReported === undefined || typeof o.cacheOverReported === "boolean") &&
        (o.priceSource === undefined ||
          RUN_TITLE_PRICE_SOURCES.includes(o.priceSource as (typeof RUN_TITLE_PRICE_SOURCES)[number])) &&
        (o.usd === undefined || nonnegative(o.usd)) &&
        (o.invalidOutputKind === undefined ||
          RUN_TITLE_INVALID_OUTPUT_KINDS.includes(
            o.invalidOutputKind as (typeof RUN_TITLE_INVALID_OUTPUT_KINDS)[number],
          ))
      );
    case "tool_call":
      return typeof o.summary === "string" && typeof o.tool === "string";
    case "tool_input":
      return typeof o.callId === "string" && o.callId.length > 0 && typeof o.input === "string";
    case "tool_result":
      return typeof o.summary === "string" && typeof o.tool === "string" && typeof o.ok === "boolean";
    case "run_note":
      return typeof o.summary === "string" && typeof o.kind === "string" && NOTE_KINDS.has(o.kind as RunNoteKind);
    case "answer":
    case "input":
    case "assistant":
    case "context":
    case "notes":
      return typeof o.text === "string"; // the narrative events carry text, not a summary
    case "run_meta":
      return typeof o.agent === "string" && (o.model === undefined || typeof o.model === "string");
    case "reference":
      // A quoted conversation (record 0037): the live analyzer counts it as a
      // side fact, so a captured replay must keep it too or the two disagree.
      return (
        typeof o.text === "string" &&
        typeof o.url === "string" &&
        typeof o.channelId === "string" &&
        typeof o.channelName === "string" &&
        typeof o.messages === "number"
      );
    case "span_start":
      return typeof o.spanId === "string" && typeof o.name === "string";
    case "span_end":
      return (
        typeof o.spanId === "string" &&
        typeof o.name === "string" &&
        typeof o.startedAt === "number" &&
        typeof o.durationMs === "number" &&
        (o.status === "ok" || o.status === "error")
      );
    case "skill_use":
      return typeof o.skill === "string" && typeof o.agent === "string" && typeof o.bodyBytes === "number";
    case "artifact":
      // A key, never a URL (run-visibility.md item 1): a payload carrying one is
      // a producer that stored a signed URL by mistake — skipped, not repaired.
      // And the join the page binds by (live-view.md item 26): a received
      // file names its message, a sent one the call that posted it.
      return (
        ((o.direction === "in" && typeof o.messageId === "string") ||
          (o.direction === "out" && typeof o.callId === "string")) &&
        typeof o.key === "string" &&
        typeof o.name === "string" &&
        typeof o.size === "number" &&
        typeof o.contentType === "string" &&
        o.url === undefined
      );
    case "review_artifact":
      if (o.artifact === "pr_description") {
        return (
          (o.origin === "submitted" || o.origin === "parsed") &&
          typeof o.repo === "string" &&
          typeof o.pr === "number" &&
          typeof o.title === "string" &&
          typeof o.body === "string" &&
          // `pointers` today; `tour` on a record written under the previous contract.
          (Array.isArray(o.pointers) || Array.isArray(o.tour))
        );
      }
      return (
        o.artifact === "reading_diff" && typeof o.diff === "string" && (o.poweredBy === "git" || o.poweredBy === "meat")
      );
    case "pr_description":
      return typeof o.description === "object" && o.description !== null;
    case "pr_opened":
      return typeof o.url === "string" && typeof o.number === "number" && typeof o.created === "boolean";
    case "pushed_head":
      return typeof o.ref === "string" && typeof o.sha === "string" && (o.by === "push" || o.by === "salvage");
    case "publication_settlement":
      return isPublicationSettlement(o.settlement);
    case "unfinished_patch":
      return (
        typeof o.runId === "string" &&
        typeof o.key === "string" &&
        o.key === `runs/${o.runId}/out/0-unfinished-${o.baseHeadSha}-${o.targetHeadSha}-${o.sourceHeadSha}.patch` &&
        typeof o.size === "number" &&
        Number.isSafeInteger(o.size) &&
        o.size > 0 &&
        typeof o.sha256 === "string" &&
        /^[0-9a-f]{64}$/.test(o.sha256) &&
        typeof o.baseHeadSha === "string" &&
        /^[0-9a-f]{40}$/.test(o.baseHeadSha) &&
        typeof o.targetHeadSha === "string" &&
        /^[0-9a-f]{40}$/.test(o.targetHeadSha) &&
        typeof o.sourceHeadSha === "string" &&
        /^[0-9a-f]{40}$/.test(o.sourceHeadSha)
      );
    case "run_state":
      return (
        typeof o.state === "string" &&
        LIVE_STATES.has(o.state as RunLiveStateName) &&
        typeof o.since === "number" &&
        (o.state === "ended"
          ? typeof o.cause === "string" && ENDING_CAUSES.has(o.cause as PlaneEndingCause)
          : typeof o.bound === "number")
      );
    case "review_posted":
      return typeof o.repo === "string" && typeof o.number === "number" && typeof o.head === "string";
    case "ship_round":
      return typeof o.index === "number" && typeof o.agent === "string" && typeof o.outcome === "string";
    case "ship_handoff":
      // The plan runner instance the hand-off created (record 0051 R2).
      return typeof o.instanceId === "string";
    case "coordinator_tag":
      // The instance a coordinator's child belongs to (run-history item 48a).
      return typeof o.parentInstanceId === "string";
    case "child_interrupted":
      // A deploy roll interrupted a coordinator's child (run-history item 47a).
      return typeof o.parentInstanceId === "string" && typeof o.reason === "string";
    case "child_resumed":
      // A coordinator's child resumed across a deploy roll (run-history item 47a).
      return typeof o.parentInstanceId === "string" && typeof o.summary === "string";
    case "route":
      return typeof o.preset === "string" && typeof o.reason === "string" && typeof o.model === "string";
    case "operator":
      // The operator's shadow decision (record 0057; run-history item 60).
      return (
        (o.mode === "shadow" || o.mode === "on") &&
        (o.outcome === "binds" ||
          o.outcome === "question" ||
          o.outcome === "refusal" ||
          o.outcome === "non_decision") &&
        typeof o.reason === "string"
      );
    case "refusal":
      // A refusal the door recorded (record 0054, as amended): the code, its
      // cause and the capped sentence — a captured door record replays whole.
      return typeof o.code === "string" && typeof o.cause === "string" && typeof o.text === "string";
    default:
      return false;
  }
}
