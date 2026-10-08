import { minutesToMs } from "../budgets.js";
import type { ExpectedSeedManifest } from "./seedManifest.js";
import { canonicalSeedJson, seedContentHash } from "./seedManifest.js";
import { promotionBodyOf, type PromotionReadResult } from "./promotion.js";
import {
  isContextDependencies,
  contextDependenciesHash,
  type ContextDependencies,
} from "../references/contextDependencies.js";
import { assembleTranscript } from "./transcript.js";
import { SESSION_KEY_PATTERN } from "../runRecord.js";
import { GEN_PATTERN, type TranscriptRow, type TranscriptAttachment } from "./types.js";
import { RUN_ID_PATTERN } from "../runIdentity.js";

export interface SourceSeedReference {
  storeKey: string;
  runId: string;
  gen: string;
  bodySha256: string;
  expectedSeedSha256: string;
}
export interface SourceSeedHashes {
  messagesHash: string;
  rowsHash: string;
  attachmentsHash: string;
  actorsHash: string;
  contextHash: string;
  notepadHash: string;
}
/** The source proves only stored source data; system, budget and step0 are Runs facts. */
export interface SourceSeedReceipt extends SourceSeedReference, SourceSeedHashes {
  version: 1;
  phase: "pending-confirmation";
  key: string;
  startedAt: number;
  namespace: string;
  requester: string;
  from: number;
  through: number;
  count: number;
  next: number;
  pinRevision: number;
}
export type SourceSeedResult =
  | { kind: "verified"; receipt: SourceSeedReceipt; release?: SourceSeedReleaseReceipt }
  | { kind: "held"; reason: "missing" | "mismatch" | "owner" | "corrupt" | "unsupported" | "unknown" };
export interface SourceSeedSnapshot {
  sources?: import("../references/receipts.js").SessionSources;
  rows: Array<TranscriptRow & { trimmed: number | boolean }>;
  attachments: TranscriptAttachment[];
  owner?: { runId: string; gen: string };
  next: number;
  context?: ContextDependencies;
  notepad: string;
}
export class SourceSeedPendingError extends Error {
  constructor(
    readonly key: string,
    readonly runId: string,
  ) {
    super("The original source seed remains held pending confirmation.");
    this.name = "SourceSeedPendingError";
  }
}
const object = (x: unknown): x is Record<string, unknown> => !!x && typeof x === "object" && !Array.isArray(x);
const hash = (x: unknown) => typeof x === "string" && /^[a-f0-9]{64}$/.test(x);
const text = (x: unknown): x is string => typeof x === "string" && x.length > 0 && x.length <= 512;
export function sourceSeedReferenceOf(value: unknown): SourceSeedReference | undefined {
  if (
    !object(value) ||
    Object.keys(value).some((k) => !["storeKey", "runId", "gen", "bodySha256", "expectedSeedSha256"].includes(k)) ||
    !text(value.storeKey) ||
    !text(value.runId) ||
    !RUN_ID_PATTERN.test(value.runId) ||
    !text(value.gen) ||
    !GEN_PATTERN.test(value.gen) ||
    !hash(value.bodySha256) ||
    !hash(value.expectedSeedSha256)
  )
    return;
  return structuredClone(value) as unknown as SourceSeedReference;
}
export function sourceSeedReceiptOf(value: unknown): SourceSeedReceipt | undefined {
  if (
    !object(value) ||
    Object.keys(value).some(
      (k) =>
        ![
          "version",
          "phase",
          "key",
          "storeKey",
          "runId",
          "gen",
          "bodySha256",
          "expectedSeedSha256",
          "startedAt",
          "namespace",
          "requester",
          "from",
          "through",
          "count",
          "next",
          "pinRevision",
          "messagesHash",
          "rowsHash",
          "attachmentsHash",
          "actorsHash",
          "contextHash",
          "notepadHash",
        ].includes(k),
    ) ||
    value.version !== 1 ||
    value.phase !== "pending-confirmation" ||
    !text(value.key) ||
    !SESSION_KEY_PATTERN.test(value.key) ||
    !Number.isFinite(value.startedAt) ||
    !text(value.namespace) ||
    !text(value.requester) ||
    ![value.from, value.through, value.count, value.next, value.pinRevision].every(
      (x) => typeof x === "number" && Number.isSafeInteger(x) && x >= 0,
    ) ||
    ![
      value.messagesHash,
      value.rowsHash,
      value.attachmentsHash,
      value.actorsHash,
      value.contextHash,
      value.notepadHash,
    ].every(hash)
  )
    return;
  const ref = sourceSeedReferenceOf({
    storeKey: value.storeKey,
    runId: value.runId,
    gen: value.gen,
    bodySha256: value.bodySha256,
    expectedSeedSha256: value.expectedSeedSha256,
  });
  if (!ref) return;
  const result = value as unknown as SourceSeedReceipt;
  if (
    result.count < 1 ||
    result.pinRevision < 1 ||
    result.through !== result.from + result.count - 1 ||
    result.next !== result.through + 1
  )
    return;
  return structuredClone(result);
}
export function authenticatedSeedExpectation(
  key: string,
  ref: SourceSeedReference,
  actual: PromotionReadResult,
): ExpectedSeedManifest | undefined {
  if (
    (actual.kind !== "committed" && actual.kind !== "confirmed") ||
    (actual.receipt.phase !== "unconfirmed" && actual.receipt.phase !== "confirmed") ||
    actual.receipt.runId !== ref.runId ||
    actual.receipt.gen !== ref.gen ||
    actual.receipt.bodySha256 !== ref.bodySha256 ||
    actual.receipt.expectedSeedSha256 !== ref.expectedSeedSha256
  )
    return;
  const expected = actual.preparation.expectedSeed,
    body = promotionBodyOf(actual.preparation.bodyJson);
  if (
    !expected ||
    !body ||
    expected.mode !== "session" ||
    expected.key !== key ||
    JSON.parse(actual.preparation.bodyJson).storeKey !== ref.storeKey
  )
    return;
  return structuredClone(expected);
}
export async function verifiedSourceSeedHashes(
  snapshot: SourceSeedSnapshot,
  expected: ExpectedSeedManifest,
): Promise<SourceSeedHashes | undefined> {
  if (
    snapshot.owner?.runId !== expected.runId ||
    snapshot.owner.gen !== expected.gen ||
    snapshot.next !== expected.through + 1 ||
    !isContextDependencies(snapshot.context) ||
    snapshot.rows.some((r) => r.trimmed !== 0 && r.trimmed !== false) ||
    snapshot.rows.some((r) => r.idx < expected.from || r.idx > expected.through) ||
    new Set(snapshot.rows.map((r) => `${r.idx}:${r.part}`)).size !== snapshot.rows.length
  )
    return;
  const rows = snapshot.rows
      .map(({ idx, part, json }) => ({ idx, part, json }))
      .sort((a, b) => a.idx - b.idx || a.part - b.part),
    assembly = assembleTranscript(rows, snapshot.attachments, expected.from);
  if (!assembly.complete || assembly.turns !== expected.count || assembly.compactions.length) return;
  const hashes: SourceSeedHashes = {
    messagesHash: await seedContentHash(assembly.messages),
    rowsHash: await seedContentHash(rows.map((r) => ({ ...r, json: canonicalSeedJson(JSON.parse(r.json)) }))),
    attachmentsHash: await seedContentHash(
      [...snapshot.attachments].sort((a, b) => (a.ref < b.ref ? -1 : a.ref > b.ref ? 1 : 0)),
    ),
    actorsHash: await seedContentHash(
      rows.map((r) => ({ idx: r.idx, part: r.part, actor: (JSON.parse(r.json) as { actor?: unknown }).actor ?? null })),
    ),
    contextHash: await contextDependenciesHash(snapshot.context),
    notepadHash: await seedContentHash(snapshot.notepad),
  };
  return Object.entries(hashes).every(([key, value]) => value === expected[key as keyof SourceSeedHashes])
    ? hashes
    : undefined;
}
export function sourceSeedReferenceMatches(
  receipt: SourceSeedReceipt,
  reference: SourceSeedReference,
  key: string,
): boolean {
  return (
    receipt.key === key &&
    ["storeKey", "runId", "gen", "bodySha256", "expectedSeedSha256"].every(
      (k) => receipt[k as keyof SourceSeedReference] === reference[k as keyof SourceSeedReference],
    )
  );
}

/** The owning Runs transaction confirms source custody and its own admitted seed boundary. */
export interface PromotionConfirmationReceipt extends SourceSeedReference {
  version: 1;
  phase: "confirmed";
  key: string;
  startedAt: number;
  namespace: string;
  requester: string;
  authenticatedAs?: string;
  postedBy?: string;
  source: SourceSeedReceipt;
  systemHash: string;
  budgetMs: number;
  step0Hash: string;
}
export type PromotionConfirmationResult =
  | { kind: "confirmed"; receipt: PromotionConfirmationReceipt }
  | { kind: "held"; reason: import("./promotion.js").PromotionHoldReason };
export interface SourceSeedReleaseReceipt {
  version: 1;
  phase: "released";
  source: SourceSeedReceipt;
  confirmation: PromotionConfirmationReceipt;
}
export function promotionConfirmationOf(value: unknown): PromotionConfirmationReceipt | undefined {
  if (
    !object(value) ||
    Object.keys(value).some(
      (k) =>
        ![
          "version",
          "phase",
          "key",
          "storeKey",
          "runId",
          "gen",
          "bodySha256",
          "expectedSeedSha256",
          "startedAt",
          "namespace",
          "requester",
          "authenticatedAs",
          "postedBy",
          "source",
          "systemHash",
          "budgetMs",
          "step0Hash",
        ].includes(k),
    ) ||
    value.version !== 1 ||
    value.phase !== "confirmed" ||
    !hash(value.systemHash) ||
    !hash(value.step0Hash) ||
    typeof value.budgetMs !== "number" ||
    !Number.isSafeInteger(value.budgetMs) ||
    value.budgetMs <= 0 ||
    (value.authenticatedAs !== undefined && !text(value.authenticatedAs)) ||
    (value.postedBy !== undefined && !text(value.postedBy))
  )
    return;
  const source = sourceSeedReceiptOf(value.source);
  if (
    !source ||
    !sourceSeedReferenceMatches(source, value as unknown as SourceSeedReference, String(value.key)) ||
    source.startedAt !== value.startedAt ||
    source.namespace !== value.namespace ||
    source.requester !== value.requester
  )
    return;
  return structuredClone(value) as unknown as PromotionConfirmationReceipt;
}
export function confirmationMatchesPreparation(
  value: PromotionConfirmationReceipt,
  preparation: import("./promotion.js").OriginalPromotionPreparation,
): boolean {
  const expected = preparation.expectedSeed;
  return (
    !!expected &&
    expected.mode === "session" &&
    value.runId === preparation.receipt.runId &&
    value.gen === preparation.receipt.gen &&
    value.startedAt === preparation.receipt.startedAt &&
    value.namespace === preparation.receipt.namespace &&
    value.requester === preparation.receipt.requester &&
    value.authenticatedAs === preparation.receipt.authenticatedAs &&
    value.postedBy === preparation.receipt.postedBy &&
    value.bodySha256 === preparation.receipt.bodySha256 &&
    value.expectedSeedSha256 === preparation.receipt.expectedSeedSha256 &&
    value.storeKey === JSON.parse(preparation.bodyJson).storeKey &&
    value.key === expected.key &&
    value.budgetMs === expected.budgetMs &&
    value.systemHash === expected.systemHash &&
    value.source.from === expected.from &&
    value.source.through === expected.through &&
    value.source.count === expected.count &&
    value.source.next === expected.through + 1 &&
    ["messagesHash", "rowsHash", "attachmentsHash", "actorsHash", "contextHash", "notepadHash"].every(
      (k) => value.source[k as keyof SourceSeedHashes] === expected[k as keyof SourceSeedHashes],
    )
  );
}
export function sourceSeedReleaseOf(value: unknown): SourceSeedReleaseReceipt | undefined {
  if (
    !object(value) ||
    Object.keys(value).some((k) => !["version", "phase", "source", "confirmation"].includes(k)) ||
    value.version !== 1 ||
    value.phase !== "released"
  )
    return;
  const source = sourceSeedReceiptOf(value.source),
    confirmation = promotionConfirmationOf(value.confirmation);
  if (!source || !confirmation || canonicalSeedJson(source) !== canonicalSeedJson(confirmation.source)) return;
  return { version: 1, phase: "released", source, confirmation };
}
/** Lease renewal keeps the original owner alive; it changes no admitted input
 * or allowance. Every other row fact still fences source confirmation. */
export function promotionConfirmationRow(row: import("./types.js").LiveRunRow | undefined) {
  if (!row) return;
  const { leaseUntil: _leaseUntil, ...boundary } = row;
  return boundary;
}

/** No caller-supplied system, budget or step is used here. */
export async function confirmStoredSeedBoundary(
  original: Extract<PromotionReadResult, { kind: "committed" }>,
  source: SourceSeedResult,
  row: import("./types.js").LiveRunRow,
  steps: readonly import("./types.js").StepRecord[],
): Promise<PromotionConfirmationReceipt | undefined> {
  const expected = original.preparation.expectedSeed,
    s = steps[0];
  if (
    !expected ||
    expected.mode !== "session" ||
    source.kind !== "verified" ||
    source.release ||
    steps.length !== 1 ||
    !s ||
    s.step !== 0 ||
    !Number.isSafeInteger(s.seq) ||
    s.seq < 0 ||
    s.turnIndex !== expected.count ||
    !Array.isArray(s.inFlight) ||
    s.inFlight.length ||
    s.inboxConsumedSeq !== 0 ||
    (s.inboxDeferredSeqs !== undefined && (!Array.isArray(s.inboxDeferredSeqs) || s.inboxDeferredSeqs.length)) ||
    s.remainingMs !== expected.budgetMs ||
    s.turn !== 0 ||
    s.iteration !== 0 ||
    row.stop === "hard" ||
    row.ownerGen !== expected.gen ||
    row.runId !== expected.runId ||
    row.startedAt !== expected.startedAt ||
    !row.meta.profile ||
    minutesToMs(row.meta.profile.minutes) !== expected.budgetMs
  )
    return;
  const receipt: PromotionConfirmationReceipt = {
    version: 1,
    phase: "confirmed",
    storeKey: source.receipt.storeKey,
    runId: row.runId,
    gen: row.ownerGen,
    bodySha256: original.receipt.bodySha256,
    expectedSeedSha256: original.receipt.expectedSeedSha256!,
    key: expected.key!,
    startedAt: row.startedAt,
    namespace: row.meta.channelId,
    requester: row.meta.userId,
    ...(row.meta.authenticatedAs !== undefined ? { authenticatedAs: row.meta.authenticatedAs } : {}),
    ...(row.meta.postedBy !== undefined ? { postedBy: row.meta.postedBy } : {}),
    source: structuredClone(source.receipt),
    systemHash: await seedContentHash(row.system),
    budgetMs: s.remainingMs,
    step0Hash: await seedContentHash(s),
  };
  return promotionConfirmationOf(receipt) && confirmationMatchesPreparation(receipt, original.preparation)
    ? receipt
    : undefined;
}

/** Flat entries in the existing session metadata carrier, one immutable original per exact fingerprint. */
export const SOURCE_SEED_RECORD_PREFIX = "expected_seed_original:";
export interface SourceSeedOriginalRecord {
  /** Negative resolution only; the original receipt remains unconfirmed. */
  cancelledBy?: string;
  version: 1;
  receipt: SourceSeedReceipt;
  release?: SourceSeedReleaseReceipt;
}
export function sourceSeedReferenceOfReceipt(receipt: SourceSeedReference): SourceSeedReference {
  return {
    storeKey: receipt.storeKey,
    runId: receipt.runId,
    gen: receipt.gen,
    bodySha256: receipt.bodySha256,
    expectedSeedSha256: receipt.expectedSeedSha256,
  };
}
export function sourceSeedOriginalKey(reference: SourceSeedReference): `${typeof SOURCE_SEED_RECORD_PREFIX}${string}` {
  return `${SOURCE_SEED_RECORD_PREFIX}${canonicalSeedJson(sourceSeedReferenceOfReceipt(reference))}`;
}
export function sourceSeedOriginalOf(value: unknown): SourceSeedOriginalRecord | undefined {
  if (
    !object(value) ||
    value.version !== 1 ||
    Object.keys(value).some((k) => !["version", "receipt", "release", "cancelledBy"].includes(k))
  )
    return;
  const receipt = sourceSeedReceiptOf(value.receipt),
    release = value.release === undefined ? undefined : sourceSeedReleaseOf(value.release);
  if (
    !receipt ||
    (value.cancelledBy !== undefined &&
      (typeof value.cancelledBy !== "string" ||
        !RUN_ID_PATTERN.test(value.cancelledBy) ||
        value.release !== undefined)) ||
    (value.release !== undefined && (!release || canonicalSeedJson(release.source) !== canonicalSeedJson(receipt)))
  )
    return;
  return {
    version: 1,
    receipt,
    ...(release ? { release } : {}),
    ...(typeof value.cancelledBy === "string" ? { cancelledBy: value.cancelledBy } : {}),
  };
}
