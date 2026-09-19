import { FRICTION_CATEGORIES, type CategoryTotals, type FrictionCategory } from "./runFriction.js";
import { llmUsdOfUsage, type ModelPriceTable } from "./modelPricing.js";
import { emptyUsage, UNKNOWN_AGENT } from "./runUsage.js";
import { utf8ByteLength, type RunRecord } from "./runRecord.js";

// Run metrics (docs/reference/specs/run-metrics.md; docs/decisions/0063-every-finished-run-writes-one-metrics-point-and-a-metrics-page-reads-the-trend.md):
// one flat point per finished run, written to a Workers Analytics Engine
// dataset beside the record's commit. This file is the point's contract, shared
// by both sides of the wire — the bot's store/ledger clients compute the point
// (`pointOf`), the state Worker validates it (`isRunMetricsPoint`) and decides
// whether the row turned final (`pointTurnsFinal`) — so it is node-free like
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
  "failure kind",
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
  const blobs: Record<PointBlobName, string> = {
    schema: POINT_SCHEMA,
    agent: record.agent ?? "",
    preset: record.profile?.preset ?? "",
    model: record.model ?? "",
    status: record.status,
    "failure kind": record.failure?.kind ?? "",
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

/** Structural check on a point from outside the process (the `/runs/put` and
 *  `/runs/finish` bodies): exactly one index, exactly `POINT_COLUMNS.blobs.length`
 *  strings each at most `MAX_POINT_BLOB_BYTES` bytes, exactly
 *  `POINT_COLUMNS.doubles.length` finite numbers — and nothing else. */
export function isRunMetricsPoint(v: unknown): v is RunMetricsPoint {
  if (typeof v !== "object" || v === null) return false;
  const p = v as Record<string, unknown>;
  if (!Array.isArray(p.indexes) || p.indexes.length !== 1) return false;
  const index = p.indexes[0];
  if (typeof index !== "string" || utf8ByteLength(index) > MAX_POINT_BLOB_BYTES) return false;
  if (!Array.isArray(p.blobs) || p.blobs.length !== POINT_COLUMNS.blobs.length) return false;
  if (!p.blobs.every((b) => typeof b === "string" && utf8ByteLength(b) <= MAX_POINT_BLOB_BYTES)) return false;
  if (!Array.isArray(p.doubles) || p.doubles.length !== POINT_COLUMNS.doubles.length) return false;
  return p.doubles.every(isFinite_);
}

/**
 * The emission rule's one question, answered inside the store's transaction:
 * did this write turn the run's row final? True exactly when the stored record
 * is final (`provisional` absent) and the existing row was absent or itself
 * provisional. There is deliberately no `finishedAt > startedAt` term: a plain
 * `put` of an `interrupted` record over no row is a run counted once, and a
 * final rewrite over a final row (the review artifact, an identical retry) is
 * false however its stamps compare.
 */
export function pointTurnsFinal(
  existing: { provisional?: boolean } | undefined,
  stored: Pick<RunRecord, "provisional">,
): boolean {
  if (stored.provisional === true) return false;
  return existing === undefined || existing.provisional === true;
}
