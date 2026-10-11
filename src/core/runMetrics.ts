import { FRICTION_CATEGORIES, type CategoryTotals, type FrictionCategory } from "./runFriction.js";
import { llmUsdOfUsage, type ModelPriceTable } from "./modelPricing.js";
import { emptyUsage, UNKNOWN_AGENT } from "./runUsage.js";
import { utf8ByteLength, type RunRecord } from "./runRecord.js";
import { isLostWord } from "./runSetup.js";
import { FINDING_SEVERITIES } from "./reviewVerdict.js";

// Run metrics (docs/reference/specs/run-metrics.md; docs/decisions/0063-every-finished-run-writes-one-metrics-point-and-a-metrics-page-reads-the-trend.md):
// one flat point per finished run, written to a Workers Analytics Engine
// dataset beside the record's commit. This file is the point's contract, shared
// by both sides of the wire — the bot's store/ledger clients compute the point
// (`pointOf`), the state Worker validates it (`isRunMetricsPoint`) and decides
// whether the write emits (`pointEmits`, record 0097's terminal close) — so it is node-free like
// `runRecord.ts`: no Node built-ins, no I/O, no clock.

/** A point as the platform's `writeDataPoint` takes it: one index (the
 *  sampling key), positional string blobs and positional doubles. */
export interface RunMetricsPoint {
  indexes: [string];
  blobs: string[];
  doubles: number[];
}

/** The platform's byte cap per blob (and per index); `pointOf` truncates. */
export const MAX_POINT_BLOB_BYTES = 96;

/** The point's schema word, `blob1` — bump it when a position changes meaning. */
export const POINT_SCHEMA = "1";

const BLOB_NAMES = [
  "schema",
  "agent",
  "preset",
  "model",
  "status",
  "error type",
  "dominant friction",
  "channel",
  "repository",
  "machine class",
  "route class",
  "reply",
  "lineage",
  "requester",
  "identity",
  "run id",
  // Appended by record 0097, so no position above changes meaning.
  "surface",
  "workspace",
  "setup reason",
  "outcome",
] as const;

const DOUBLE_NAMES = [
  "wall",
  "getting ready",
  "thinking",
  "tools",
  "finishing up",
  "overhead",
  "not recorded",
  "not loaded",
  "turns",
  "input tokens",
  "output tokens",
  "cache read tokens",
  "cache write tokens",
  "dollars",
  "steps",
  "tool calls",
  "events",
  "unpriced tokens",
  "minutes",
  "finished at",
] as const;

export type PointBlobName = (typeof BLOB_NAMES)[number];
export type PointDoubleName = (typeof DOUBLE_NAMES)[number];

/** The ONE ordered table naming every position once: `blobs[i]` is the meaning
 *  of `blob<i+1>`, `doubles[i]` of `double<i+1>`, `index[0]` of `index1`. The
 *  writer builds from it (`pointOf` fills a `Record<name, value>` and maps it
 *  through this order, so a position added here without a value fails to
 *  compile) and the reader's SQL aliases from it — a query names a column
 *  through its name here, never a magic number. */
export const POINT_COLUMNS = {
  index: ["agent"] as const,
  blobs: BLOB_NAMES,
  doubles: DOUBLE_NAMES,
};

/** The 1-based platform column of a named blob: `"status"` → `"blob5"`. */
export function blobColumn(name: PointBlobName): string {
  return `blob${POINT_COLUMNS.blobs.indexOf(name) + 1}`;
}

/** The 1-based platform column of a named double: `"dollars"` → `"double14"`. */
export function doubleColumn(name: PointDoubleName): string {
  return `double${POINT_COLUMNS.doubles.indexOf(name) + 1}`;
}

/** A point's blob by its `POINT_COLUMNS` name — the tests' and readers' accessor. */
export function blobOf(point: RunMetricsPoint, name: PointBlobName): string {
  return point.blobs[POINT_COLUMNS.blobs.indexOf(name)];
}

/** A point's double by its `POINT_COLUMNS` name. */
export function doubleOf(point: RunMetricsPoint, name: PointDoubleName): number {
  return point.doubles[POINT_COLUMNS.doubles.indexOf(name)];
}

/** Truncate to the platform's per-blob byte cap (multi-byte safe: cut by
 *  characters until the UTF-8 size fits — blob values are ids and enum words,
 *  so the loop is theoretical). */
function capBlob(s: string): string {
  let out = s;
  while (utf8ByteLength(out) > MAX_POINT_BLOB_BYTES) out = out.slice(0, -1);
  return out;
}

const isFinite_ = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

/** The dominant friction category of a stored diagnosis: the `FrictionCategory`
 *  with the largest `durationMs` among those with a count (first in
 *  `FRICTION_CATEGORIES` order on a tie); empty when no category has a count. */
export function dominantFriction(byCategory: Partial<Record<FrictionCategory, CategoryTotals>>): FrictionCategory | "" {
  let best: FrictionCategory | "" = "";
  let bestMs = -1;
  for (const c of FRICTION_CATEGORIES) {
    const t = byCategory[c];
    if (!t || t.count <= 0) continue;
    if (t.durationMs > bestMs) {
      best = c;
      bestMs = t.durationMs;
    }
  }
  return best;
}

/**
 * The record's metrics point, or `undefined` for a record still in its
 * provisional window (`provisional: true`) — and for nothing else: a final
 * record whose `finishedAt` equals its `startedAt` is counted with a zero
 * wall. Reads ONLY the record's typed dimensions and counters — never
 * `activity`, `label`, `events`, `verdict`, `handoff`, `dispositions` or
 * `diagnosis.verdict` — so no free text reaches the dataset. Dollars are
 * priced at finish through the same table `RunsService` prices reads with
 * (`llmUsdOfUsage`); an unpriced model's tokens land in `unpriced tokens`,
 * never in `dollars` as $0.
 */
export function pointOf(record: RunRecord, prices?: ModelPriceTable): RunMetricsPoint | undefined {
  if (record.provisional === true) return undefined;
  const usage = record.usage ?? emptyUsage();
  const priced = llmUsdOfUsage(usage, prices);
  let inputTokens = 0;
  let outputTokens = 0;
  let cacheReadTokens = 0;
  let cacheWriteTokens = 0;
  for (const m of Object.values(usage.byModel)) {
    inputTokens += m.inputTokens;
    outputTokens += m.outputTokens;
    cacheReadTokens += m.cacheReadTokens;
    cacheWriteTokens += m.cacheWriteTokens;
  }
  const shape = record.diagnosis.shape;
  const { outcome, errorType } = outcomeOf(record);
  const blobs: Record<PointBlobName, string> = {
    schema: POINT_SCHEMA,
    agent: record.agent ?? "",
    preset: record.profile?.preset ?? "",
    model: record.model ?? "",
    status: record.status,
    "error type": errorType,
    "dominant friction": dominantFriction(record.diagnosis.byCategory),
    channel: record.channelId,
    repository: record.repo ?? "",
    "machine class": record.profile?.machine ?? "",
    "route class": record.route !== undefined ? "routed" : "chosen",
    reply: record.replyOk === true ? "ok" : record.replyOk === false ? "failed" : "none",
    lineage: record.parentRunId !== undefined ? "child" : "root",
    requester: record.userId,
    identity: record.profile?.identity ?? "",
    "run id": record.id,
    surface: surfaceOf(record.channelId),
    workspace: workspaceWordOf(record),
    "setup reason": record.setup?.reason ?? "",
    outcome,
  };
  const doubles: Record<PointDoubleName, number> = {
    wall: record.finishedAt - (record.receivedAt ?? record.startedAt),
    "getting ready": shape?.gettingReadyMs ?? 0,
    thinking: shape?.thinkingMs ?? 0,
    tools: shape?.toolsMs ?? 0,
    "finishing up": shape?.finishingUpMs ?? 0,
    overhead: shape?.overheadMs ?? 0,
    "not recorded": shape?.notRecordedMs ?? 0,
    "not loaded": shape?.notLoadedMs ?? 0,
    turns: usage.turns,
    "input tokens": inputTokens,
    "output tokens": outputTokens,
    "cache read tokens": cacheReadTokens,
    "cache write tokens": cacheWriteTokens,
    dollars: priced.usd,
    steps: record.stepCount ?? 0,
    "tool calls": isFinite_(record.diagnosis.toolCalls) ? record.diagnosis.toolCalls : 0,
    events: record.eventCount,
    "unpriced tokens": priced.unpricedTokens,
    minutes: record.profile?.minutes ?? 0,
    "finished at": record.finishedAt,
  };
  return {
    indexes: [capBlob(record.agent ?? UNKNOWN_AGENT)],
    blobs: POINT_COLUMNS.blobs.map((n) => capBlob(blobs[n])),
    doubles: POINT_COLUMNS.doubles.map((n) => doubles[n]),
  };
}

/** A run's **outcome** in OpenTelemetry's CI/CD result vocabulary, and its
 *  **error type** (record 0097, "Outcome and error type"): a failure is work
 *  that ran and said no, an error is the system breaking. */
export type RunOutcome = "success" | "failure" | "error" | "timeout" | "cancellation";

/** The record's outcome and error type: the terminal status decides first,
 *  then the first matching row of record 0097's table. A changes-requested
 *  review is a success (the verdict is the review row's); the setup reason has
 *  its own column, so a cancellation keeps it. Error type is empty exactly for
 *  `success` and `cancellation`, and `unclassified` names a failed run no row
 *  explains. */
export function outcomeOf(record: RunRecord): { outcome: RunOutcome; errorType: string } {
  const ending = record.answerOutcome?.ending;
  const budget = ending === "time_budget" || ending === "turn_budget" ? ending : undefined;
  switch (record.status) {
    case "stopped_soft":
    case "stopped_hard":
      return { outcome: "cancellation", errorType: "" };
    case "interrupted":
      return {
        outcome: "error",
        errorType: record.failure?.kind === "restart_unclaimed" ? "restart_unclaimed" : "interrupted",
      };
    case "failed": {
      const kind = record.failure?.kind;
      if (kind === "policy_refusal") return { outcome: "failure", errorType: kind };
      if (kind !== undefined) return { outcome: "error", errorType: kind };
      if (isLostWord(record.setup?.reason)) return { outcome: "error", errorType: record.setup!.reason! };
      if (record.replyOk === false) return { outcome: "error", errorType: "reply_failed" };
      if (budget !== undefined) return { outcome: "timeout", errorType: budget };
      return { outcome: "error", errorType: "unclassified" };
    }
    case "completed":
      if (budget !== undefined) return { outcome: "timeout", errorType: budget };
      if (ending === "interrupted") return { outcome: "error", errorType: "answer_interrupted" };
      if (ending === "hard_stop" || ending === "soft_stop") return { outcome: "cancellation", errorType: "" };
      return { outcome: "success", errorType: "" };
  }
}

/** The surfaces a run arrives on, read from its channel's namespace. */
const SURFACES = ["slack", "mcp", "web", "http", "cli"] as const;

/** The run's **surface**: its channel's namespace when it is one of
 *  `SURFACES`, else empty. */
export function surfaceOf(channelId: string): string {
  const namespace = channelId.slice(0, channelId.indexOf(":"));
  return (SURFACES as readonly string[]).includes(namespace) ? namespace : "";
}

/** The run's **workspace** word (record 0097, "Rows and columns"): its setup
 *  result folded into one word — the resident it got, how a sandbox that stood
 *  in was filled, the sandbox a cold or blank class asked for, `local` or
 *  `e2b` for a run on that backend, `none` for a lost workspace, and empty for
 *  a run that asked for none or a record written before the setup result
 *  existed. */
export function workspaceWordOf(record: Pick<RunRecord, "setup">): string {
  const setup = record.setup;
  if (setup === undefined) return "";
  if (isLostWord(setup.reason)) return "none";
  if (setup.backend !== undefined) return setup.backend;
  if (setup.seeding === "snapshot") return "sandbox_snapshot";
  if (setup.seeding === "fresh_no_snapshot") return "sandbox_fresh";
  if (setup.seeding === "fresh_after_seed_failure") return "sandbox_seed_failed";
  if (setup.requested === "cold") return "sandbox_cold";
  if (setup.requested === "blank") return "sandbox_blank";
  return setup.restored === true ? "resident_restored" : "resident";
}

/** The run point widths a store accepts: the sixteen columns record 0063
 *  defined and the twenty record 0097 widens it to, which is also the platform's
 *  blob cap. Both stay accepted while two generations write during a deploy, so
 *  the store never refuses an older or a newer writer's put; any other width is
 *  a malformed point. */
export const RUN_POINT_BLOB_WIDTHS: readonly number[] = [16, 20];

/** Structural check on a point from outside the process (the `/runs/put` and
 *  `/runs/finish` bodies): exactly one index, a `RUN_POINT_BLOB_WIDTHS` count of
 *  strings each at most `MAX_POINT_BLOB_BYTES` bytes, exactly
 *  `POINT_COLUMNS.doubles.length` finite numbers — and nothing else. */
export function isRunMetricsPoint(v: unknown): v is RunMetricsPoint {
  if (typeof v !== "object" || v === null) return false;
  const p = v as Record<string, unknown>;
  if (!Array.isArray(p.indexes) || p.indexes.length !== 1) return false;
  const index = p.indexes[0];
  if (typeof index !== "string" || utf8ByteLength(index) > MAX_POINT_BLOB_BYTES) return false;
  if (!Array.isArray(p.blobs) || !RUN_POINT_BLOB_WIDTHS.includes(p.blobs.length)) return false;
  if (!p.blobs.every((b) => typeof b === "string" && utf8ByteLength(b) <= MAX_POINT_BLOB_BYTES)) return false;
  if (!Array.isArray(p.doubles) || p.doubles.length !== POINT_COLUMNS.doubles.length) return false;
  return p.doubles.every(isFinite_);
}

/** A run's **terminal close** (record 0097): a record that is neither
 *  provisional (the start tombstone) nor `restarting` (a close a same-id
 *  successor replaces). Only a terminal close is the run's end. */
export function isTerminalClose(record: Pick<RunRecord, "provisional" | "restarting">): boolean {
  return record.provisional !== true && record.restarting !== true;
}

/**
 * The emission rule's one question, answered inside the store's transaction
 * (record 0097, amending 0063): does this write emit the run's point? True
 * exactly when the stored record is a terminal close and the run's emission
 * latch is unset; the store sets the latch in the same transaction. A
 * provisional or `restarting` close emits nothing, a terminal rewrite after
 * the latch (the review artifact, an identical retry) emits nothing, and a
 * plain `put` of an `interrupted` record over no row is a run counted once.
 */
export function pointEmits(latched: boolean, stored: Pick<RunRecord, "provisional" | "restarting">): boolean {
  return !latched && isTerminalClose(stored);
}

// ---- The review row (record 0097, "Rows and columns") ----------------------
//
// One row per review run with a verdict, written under the same terminal rule
// and latch as the run row, with its own schema word so 0063's reader (which
// filters on `schema = "1"`) never counts it. Every field is read from the
// run record; nothing here needs a price, so the store computes the row from
// the record it committed.

/** The review row's schema word, `blob1`. */
export const REVIEW_POINT_SCHEMA = "review-1";

const REVIEW_BLOB_NAMES = [
  "schema",
  "run id",
  "repository",
  "pull request number",
  "head revision",
  "verdict",
  "requester",
  "surface",
] as const;

const REVIEW_DOUBLE_NAMES = ["finished at", "duration", "findings", ...FINDING_SEVERITIES] as const;

export type ReviewBlobName = (typeof REVIEW_BLOB_NAMES)[number];
export type ReviewDoubleName = (typeof REVIEW_DOUBLE_NAMES)[number];

/** The review row's one ordered table, as `POINT_COLUMNS` is the run row's. */
export const REVIEW_POINT_COLUMNS = {
  index: ["review"] as const,
  blobs: REVIEW_BLOB_NAMES,
  doubles: REVIEW_DOUBLE_NAMES,
};

/** A review row's blob by its `REVIEW_POINT_COLUMNS` name. */
export function reviewBlobOf(point: RunMetricsPoint, name: ReviewBlobName): string {
  return point.blobs[REVIEW_POINT_COLUMNS.blobs.indexOf(name)];
}

/** A review row's double by its `REVIEW_POINT_COLUMNS` name. */
export function reviewDoubleOf(point: RunMetricsPoint, name: ReviewDoubleName): number {
  return point.doubles[REVIEW_POINT_COLUMNS.doubles.indexOf(name)];
}

/** The review row of a review run's terminal close with a verdict, else
 *  undefined. The target (repository, pull request number, head) comes from
 *  the run record — `repo`, `targetPr`, `reviewHead` falling back to the
 *  observed `headSha` — never from `reviewPost.target`, which exists only when
 *  the post succeeded. A branch review with no pull request writes an empty
 *  number. The verdict reads in GitHub's review states. */
export function reviewPointOf(record: RunRecord): RunMetricsPoint | undefined {
  if (record.agent !== "review" || record.verdict === undefined || !isTerminalClose(record)) return undefined;
  const findings = record.verdict.findings ?? [];
  const blobs: Record<ReviewBlobName, string> = {
    schema: REVIEW_POINT_SCHEMA,
    "run id": record.id,
    repository: record.repo ?? "",
    "pull request number": record.targetPr !== undefined ? String(record.targetPr) : "",
    "head revision": record.reviewHead ?? record.headSha ?? "",
    verdict: record.verdict.verdict === "approve" ? "approved" : "changes_requested",
    requester: record.userId,
    surface: surfaceOf(record.channelId),
  };
  const doubles: Record<ReviewDoubleName, number> = {
    "finished at": record.finishedAt,
    duration: record.finishedAt - (record.receivedAt ?? record.startedAt),
    findings: findings.length,
    blocking: findings.filter((f) => f.severity === "blocking").length,
    major: findings.filter((f) => f.severity === "major").length,
    minor: findings.filter((f) => f.severity === "minor").length,
    nit: findings.filter((f) => f.severity === "nit").length,
  };
  return {
    indexes: ["review"],
    blobs: REVIEW_POINT_COLUMNS.blobs.map((n) => capBlob(blobs[n])),
    doubles: REVIEW_POINT_COLUMNS.doubles.map((n) => doubles[n]),
  };
}

/** Structural check on a review row: the review index, exactly the review
 *  columns, its own schema word, each blob within the byte cap, finite numbers. */
export function isReviewMetricsPoint(v: unknown): v is RunMetricsPoint {
  if (typeof v !== "object" || v === null) return false;
  const p = v as Record<string, unknown>;
  if (!Array.isArray(p.indexes) || p.indexes.length !== 1 || p.indexes[0] !== "review") return false;
  if (!Array.isArray(p.blobs) || p.blobs.length !== REVIEW_POINT_COLUMNS.blobs.length) return false;
  if (p.blobs[0] !== REVIEW_POINT_SCHEMA) return false;
  if (!p.blobs.every((b) => typeof b === "string" && utf8ByteLength(b) <= MAX_POINT_BLOB_BYTES)) return false;
  if (!Array.isArray(p.doubles) || p.doubles.length !== REVIEW_POINT_COLUMNS.doubles.length) return false;
  return p.doubles.every(isFinite_);
}
