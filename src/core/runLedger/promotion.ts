import { RefusalError, refusalOf } from "../refusal.js";
import { promotionConfirmationOf, confirmationMatchesPreparation } from "./seedVerification.js";
import type { ClaimRequest, LiveRunRow } from "./types.js";
import { GEN_PATTERN } from "./types.js";
import { RUN_ID_PATTERN, INSTANCE_ID_PATTERN, IDEMPOTENCY_KEY_PATTERN } from "../runIdentity.js";
import { validMaintenanceTransport } from "../coordinator/maintenanceIdentity.js";
import { isChildHandoff } from "../dispatch/handoff.js";
import { isRunSession } from "../runRecord.js";
import { minutesToMs } from "../budgets.js";
import { expectedSeedManifestOf, expectedSeedMatchesClaim, type ExpectedSeedManifest } from "./seedManifest.js";

/** A known original identity conflict retains that original's admitted custody. */
export class PromotionIdentityRefusal extends RefusalError {
  constructor() {
    super(
      refusalOf(
        "setup_failed",
        "The original reservation identity could not be confirmed; its saved work remains held.",
      ),
    );
  }
}
/** The existing ordinary Memory request fence; no smaller promotion envelope. */
export const PROMOTION_BODY_BYTES = 512 * 1024;
/** Known receiver precondition; not terminal transport uncertainty or a foreign owner. */
export class PromotionPendingError extends Error {
  readonly kind = "promotion-pending";
  constructor(
    readonly runId: string,
    readonly reason: "prepared" | "corrupt" = "prepared",
  ) {
    super(
      reason === "prepared"
        ? "The original promotion remains prepared and its work is held."
        : "The original promotion witness is unreadable and its work is held.",
    );
    this.name = "PromotionPendingError";
  }
}
export interface PromotionPreparedReceipt {
  version: 1;
  runId: string;
  threadKey: string;
  gen: string;
  startedAt: number;
  namespace: string;
  requester: string;
  authenticatedAs?: string;
  postedBy?: string;
  revision: 1;
  bodySha256: string;
  expectedSeedSha256?: string;
}
export interface OriginalPromotionPreparation {
  version: 1;
  bodyJson: string;
  receipt: PromotionPreparedReceipt;
  expectedSeed?: ExpectedSeedManifest;
}
/** Actual claim transaction receipt; the seed remains unconfirmed and held. */
export interface PromotionCommitReceipt extends PromotionPreparedReceipt {
  phase: "unconfirmed";
}
export function promotionCommitReceiptOf(value: unknown): PromotionCommitReceipt | undefined {
  if (!object(value) || value.phase !== "unconfirmed") return;
  const { phase: _phase, ...identity } = value;
  const receipt = promotionReceiptOf(identity);
  return receipt ? { ...receipt, phase: "unconfirmed" } : undefined;
}
export function samePromotionReceipt(left: PromotionPreparedReceipt, right: PromotionPreparedReceipt): boolean {
  return JSON.stringify(promotionReceiptOf(left)) === JSON.stringify(promotionReceiptOf(right));
}
export function promotionCommitMatchesPreparation(
  value: PromotionCommitReceipt,
  prepared: OriginalPromotionPreparation,
): boolean {
  const { phase: _phase, ...identity } = value;
  return samePromotionReceipt(identity, prepared.receipt);
}
export type PromotionHoldReason = "unknown" | "unsupported" | "legacy" | "fenced" | "mismatch" | "oversize" | "corrupt";
export function promotionHoldReasonOf(value: unknown): PromotionHoldReason | undefined {
  return typeof value === "string" &&
    ["unknown", "unsupported", "legacy", "fenced", "mismatch", "oversize", "corrupt"].includes(value)
    ? (value as PromotionHoldReason)
    : undefined;
}
export type PromotionPrepareResult =
  { kind: "prepared"; receipt: PromotionPreparedReceipt } | { kind: "held"; reason: PromotionHoldReason };
export type PromotionReadResult =
  | ConfirmedPromotionRead
  | { kind: "prepared"; preparation: OriginalPromotionPreparation }
  | {
      kind: "committed";
      preparation: OriginalPromotionPreparation;
      receipt: PromotionCommitReceipt;
      allocationAck: import("./types.js").WorkspaceAllocationAck;
    }
  | { kind: "held"; reason: PromotionHoldReason };
export type ConfirmedPromotionRead = {
  kind: "confirmed";
  preparation: OriginalPromotionPreparation;
  commit: PromotionCommitReceipt;
  receipt: import("./seedVerification.js").PromotionConfirmationReceipt;
  allocationAck: import("./types.js").WorkspaceAllocationAck;
};
export interface PromotionReadRequest {
  runId: string;
  gen: string;
  bodySha256?: string;
}
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const text = (v: unknown): v is string => typeof v === "string" && v.length > 0 && v.length <= 512;
const hash = (v: unknown): v is string => typeof v === "string" && /^[a-f0-9]{64}$/.test(v);
export function promotionHeldResultOf(v: unknown): Extract<PromotionPrepareResult, { kind: "held" }> | undefined {
  if (!object(v) || v.kind !== "held" || Object.keys(v).some((k) => k !== "kind" && k !== "reason")) return;
  const reason = promotionHoldReasonOf(v.reason);
  return reason ? { kind: "held", reason } : undefined;
}
export const promotionBytes = (s: string): number => new TextEncoder().encode(s).byteLength;
export async function promotionBodyHash(s: string): Promise<string> {
  const bytes = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s)));
  return [...bytes].map((n) => n.toString(16).padStart(2, "0")).join("");
}
/** The bytes are the original claim envelope, not an encoded string wrapper. */
export function promotionBodyOf(bodyJson: unknown): ClaimRequest | undefined {
  if (typeof bodyJson !== "string" || promotionBytes(bodyJson) > PROMOTION_BODY_BYTES) return;
  try {
    const envelope: unknown = JSON.parse(bodyJson);
    if (!object(envelope) || !object(envelope.run)) return;
    const r = envelope.run;
    if (
      !text(r.runId) ||
      !RUN_ID_PATTERN.test(r.runId) ||
      !text(r.threadKey) ||
      r.threadKey.length > 256 ||
      !text(r.gen) ||
      !GEN_PATTERN.test(r.gen) ||
      !Number.isFinite(r.startedAt) ||
      typeof r.leaseMs !== "number" ||
      !Number.isInteger(r.leaseMs) ||
      r.leaseMs < 1000 ||
      r.leaseMs > minutesToMs(60) ||
      typeof r.system !== "string" ||
      !Array.isArray(r.tools) ||
      !object(r.meta) ||
      !text(r.meta.userId) ||
      !text(r.meta.channelId) ||
      !text(r.meta.threadKey) ||
      (r.phase !== undefined && r.phase !== "live")
    )
      return;
    const m = r.meta;
    if (
      !validMaintenanceTransport(m) ||
      (m.childHandoff !== undefined && !isChildHandoff(m.childHandoff)) ||
      (m.session !== undefined && !isRunSession(m.session)) ||
      (m.parentInstanceId === undefined) !== (m.idempotencyKey === undefined) ||
      (m.parentInstanceId !== undefined &&
        (!text(m.parentInstanceId) || !INSTANCE_ID_PATTERN.test(m.parentInstanceId))) ||
      (m.idempotencyKey !== undefined &&
        (!text(m.idempotencyKey) || !IDEMPOTENCY_KEY_PATTERN.test(m.idempotencyKey))) ||
      (m.costCapUsd !== undefined &&
        (m.parentInstanceId === undefined ||
          typeof m.costCapUsd !== "number" ||
          !Number.isFinite(m.costCapUsd) ||
          m.costCapUsd <= 0)) ||
      (m.restartOf !== undefined && (!text(m.restartOf) || !RUN_ID_PATTERN.test(m.restartOf))) ||
      (r.card !== undefined &&
        r.card !== null &&
        (!object(r.card) || typeof r.card.channel !== "string" || typeof r.card.ts !== "string")) ||
      (r.state !== undefined && !object(r.state))
    )
      return;
    return r as unknown as ClaimRequest;
  } catch {
    return;
  }
}
export function promotionReceiptOf(value: unknown): PromotionPreparedReceipt | undefined {
  if (
    !object(value) ||
    Object.keys(value).some(
      (key) =>
        ![
          "version",
          "runId",
          "threadKey",
          "gen",
          "startedAt",
          "namespace",
          "requester",
          "authenticatedAs",
          "postedBy",
          "revision",
          "bodySha256",
          "expectedSeedSha256",
        ].includes(key),
    ) ||
    value.version !== 1 ||
    value.revision !== 1 ||
    !text(value.runId) ||
    !text(value.threadKey) ||
    !text(value.gen) ||
    !Number.isFinite(value.startedAt) ||
    !text(value.namespace) ||
    !text(value.requester) ||
    !hash(value.bodySha256) ||
    (value.expectedSeedSha256 !== undefined && !hash(value.expectedSeedSha256)) ||
    (value.authenticatedAs !== undefined && !text(value.authenticatedAs)) ||
    (value.postedBy !== undefined && !text(value.postedBy))
  )
    return;
  return structuredClone(value) as unknown as PromotionPreparedReceipt;
}
export function promotionPreparationOf(value: unknown): OriginalPromotionPreparation | undefined {
  if (
    !object(value) ||
    Object.keys(value).some((k) => !["version", "bodyJson", "receipt", "expectedSeed"].includes(k)) ||
    value.version !== 1
  )
    return;
  const body = promotionBodyOf(value.bodyJson),
    receipt = promotionReceiptOf(value.receipt);
  const expectedSeed = value.expectedSeed === undefined ? undefined : expectedSeedManifestOf(value.expectedSeed);
  if (
    !body ||
    !receipt ||
    (value.expectedSeed === undefined) !== (receipt.expectedSeedSha256 === undefined) ||
    (value.expectedSeed !== undefined &&
      (!expectedSeed || !expectedSeedMatchesClaim(expectedSeed, body, receipt.bodySha256))) ||
    body.runId !== receipt.runId ||
    body.threadKey !== receipt.threadKey ||
    body.gen !== receipt.gen ||
    body.startedAt !== receipt.startedAt ||
    body.meta.userId !== receipt.requester ||
    body.meta.channelId !== receipt.namespace ||
    body.meta.authenticatedAs !== receipt.authenticatedAs ||
    body.meta.postedBy !== receipt.postedBy
  )
    return;
  return { version: 1, bodyJson: value.bodyJson as string, receipt, ...(expectedSeed ? { expectedSeed } : {}) };
}
/** Corrupt private bytes cannot prove there is no pending original witness. */
export function promotionPending(rawArchive: unknown): boolean {
  if (rawArchive === undefined) return false;
  if (!object(rawArchive)) return true;
  if (!Object.hasOwn(rawArchive, "promotion")) return false;
  const prepared = promotionPreparationOf(rawArchive.promotion),
    commit = promotionCommitReceiptOf(rawArchive.promotionCommit),
    confirmation = promotionConfirmationOf(rawArchive.promotionConfirmation);
  return (
    !prepared ||
    !commit ||
    !confirmation ||
    !promotionCommitMatchesPreparation(commit, prepared) ||
    !confirmationMatchesPreparation(confirmation, prepared)
  );
}
export function promotionMatchesOriginal(row: LiveRunRow, req: ClaimRequest, allocatedHead?: string): boolean {
  const actor = [
    "userId",
    "channelId",
    "threadKey",
    "authenticatedAs",
    "postedBy",
    "agent",
    "parentRunId",
    "parentInstanceId",
    "coordinatorUnit",
    "coordinatorAttempt",
    "costCapUsd",
    "idempotencyKey",
    "maintenanceActionId",
  ] as const;
  const target = ["repo", "ref", "pr"] as const;
  return (
    row.runId === req.runId &&
    row.threadKey === req.threadKey &&
    row.ownerGen === req.gen &&
    row.startedAt === req.startedAt &&
    actor.every((k) => row.meta[k] === req.meta[k]) &&
    target.every((k) => row.meta[k] === undefined || row.meta[k] === req.meta[k]) &&
    (allocatedHead === undefined || req.meta.headSha === allocatedHead) &&
    (row.meta.readonly === undefined || row.meta.readonly === req.meta.readonly) &&
    (!row.meta.profile ||
      (row.meta.profile.identity === req.meta.profile?.identity &&
        Number.isFinite(req.meta.profile?.minutes) &&
        req.meta.profile!.minutes > 0 &&
        req.meta.profile!.minutes <= row.meta.profile.minutes))
  );
}
/** Called from the owning prepare transaction with the actual reservation. */
export function promotionReceiptFromRow(
  row: LiveRunRow,
  bodySha256: string,
  expectedSeedSha256?: string,
): PromotionPreparedReceipt {
  return {
    version: 1,
    runId: row.runId,
    threadKey: row.threadKey,
    gen: row.ownerGen,
    startedAt: row.startedAt,
    namespace: row.meta.channelId,
    requester: row.meta.userId,
    revision: 1,
    bodySha256,
    ...(expectedSeedSha256 ? { expectedSeedSha256 } : {}),
    ...(row.meta.authenticatedAs !== undefined ? { authenticatedAs: row.meta.authenticatedAs } : {}),
    ...(row.meta.postedBy !== undefined ? { postedBy: row.meta.postedBy } : {}),
  };
}
/** Match ordinary claim normalization, then consume only the original saved bytes. */
export function preparedPromotionClaim(
  request: ClaimRequest,
  bodyJson: string | undefined,
  digest: string | undefined,
  row: LiveRunRow | undefined,
  archive: import("./workspaceDurability.js").WorkspaceDurabilityArchive | undefined,
): ClaimRequest | undefined {
  const prepared = archive?.promotion;
  if (!prepared || !row || bodyJson !== prepared.bodyJson || digest !== prepared.receipt.bodySha256) return;
  const original = promotionBodyOf(prepared.bodyJson);
  if (
    !original ||
    !samePromotionReceipt(
      promotionReceiptFromRow(row, digest, prepared.receipt.expectedSeedSha256),
      prepared.receipt,
    ) ||
    !promotionMatchesOriginal(row, original, archive.allocation?.headSha)
  )
    return;
  if (!samePromotionClaim(original, request)) return;
  if (archive.promotionCommit) {
    if (
      !promotionCommittedRowMatches(row, original) ||
      !promotionCommitMatchesPreparation(archive.promotionCommit, prepared)
    )
      return;
  } else if (row.phase !== "attaching") return;
  return structuredClone(original);
}
/** A duplicate reads the exact promoted input, never a different current target or binding. */
export function promotionCommittedRowMatches(row: LiveRunRow, original: ClaimRequest): boolean {
  return (
    row.phase === "live" &&
    row.system === original.system &&
    JSON.stringify(row.tools) === JSON.stringify(original.tools) &&
    JSON.stringify(row.card ?? null) === JSON.stringify(original.card ?? null) &&
    (["repo", "ref", "headSha", "pr", "session"] as const).every(
      (key) => JSON.stringify(row.meta[key]) === JSON.stringify(original.meta[key]),
    ) &&
    Object.entries(original.state ?? {}).every(
      ([key, value]) => JSON.stringify(row.state[key]) === JSON.stringify(value),
    )
  );
}
export function samePromotionClaim(left: ClaimRequest, right: ClaimRequest): boolean {
  const normalized = (r: ClaimRequest) => ({
    runId: r.runId,
    threadKey: r.threadKey,
    gen: r.gen,
    leaseMs: r.leaseMs,
    startedAt: r.startedAt,
    meta: r.meta,
    card: r.card ?? null,
    system: r.system,
    tools: r.tools,
    ...(r.state !== undefined ? { state: r.state } : {}),
    ...(r.phase !== undefined ? { phase: r.phase } : {}),
  });
  return JSON.stringify(normalized(left)) === JSON.stringify(normalized(right));
}
/** Called only after promotion in the owning transaction with its actual live row. */
export function promotionCommitFromRow(
  row: LiveRunRow,
  digest: string,
  expectedSeedSha256?: string,
): PromotionCommitReceipt {
  return { ...promotionReceiptFromRow(row, digest, expectedSeedSha256), phase: "unconfirmed" };
}
