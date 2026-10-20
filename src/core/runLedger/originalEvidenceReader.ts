import { z } from "zod";
import { sourceHash } from "../references/receipts.js";
import { parseStoredJson } from "../storedJson.js";
import { harnessLaunchIntentOf } from "../harness/sessionPolicy.js";
import { sameOriginalSessionPolicy } from "../harness/sessionPolicy.js";
import { harnessFactsOf } from "../harness/facts.js";
import { isContextCheckpointReceipt } from "../references/contextCheckpoint.js";
import { workspaceDurabilityArchiveOf } from "./workspaceDurability.js";
import { promotionBodyHash, promotionBodyOf, promotionCommitMatchesPreparation } from "./promotion.js";
import { canonicalSeedJson, seedContentHash } from "./seedManifest.js";
import {
  confirmationMatchesPreparation,
  sourceSeedOriginalOf,
  sourceSeedReferenceMatches,
  type SourceSeedReference,
} from "./seedVerification.js";

import {
  ORIGINAL_CELL_BYTES,
  ORIGINAL_RECEIPT_BYTES,
  originalUnavailable,
  type OriginalRead,
  type OriginalSelector,
  type OriginalUnavailable,
  type OriginalEvidence,
  originalMetaSchema,
  originalUnavailableSchema,
} from "./originalEvidence.js";

const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
export type OriginalCell = { json: string | null; bytes: number };
export interface OriginalSnapshot {
  storeKey: string;
  runId: string;
  ownerGen: string;
  startedAt: number;
  phase: string;
  stop: string | null;
  meta: unknown;
  state: OriginalCell;
  step: OriginalCell;
  allocation: OriginalCell;
  eventThrough: number | null;
}
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
function cellValue(cell: OriginalCell, limit: number): { value: unknown } | OriginalUnavailable {
  if (cell.bytes > limit) return originalUnavailable("oversize");
  if (cell.json === null) return originalUnavailable("missing");
  try {
    return { value: parseStoredJson(cell.json) };
  } catch (error) {
    if (error instanceof SyntaxError) return originalUnavailable("corrupt");
    throw error;
  }
}
export async function inspectOriginal(
  selector: OriginalSelector,
  snapshot: OriginalSnapshot,
  readSource: (key: string, ref: SourceSeedReference) => Promise<unknown | OriginalUnavailable>,
): Promise<OriginalRead> {
  const m = object(snapshot.meta) ? snapshot.meta : {};
  const parsed = originalMetaSchema.safeParse({
    userId: m.userId,
    channelId: m.channelId,
    channelVisibility: m.channelVisibility ?? undefined,
    repo: m.repo ?? undefined,
    threadKey: m.threadKey,
  });
  if (!parsed.success || snapshot.runId !== selector.runId) return { kind: "unavailable", reason: "corrupt" };
  const { threadKey, ...fields } = parsed.data;
  const resource = { type: "run" as const, id: snapshot.runId, ...fields };
  const wrap = (evidence: OriginalEvidence): OriginalRead => ({ kind: "source", resource, threadKey, evidence });
  const identity = { version: 1 as const, runId: selector.runId, gen: selector.gen };
  if (snapshot.ownerGen !== selector.gen) return wrap({ ...identity, availability: "unavailable", reason: "fenced" });
  const stateCell = cellValue(snapshot.state, ORIGINAL_CELL_BYTES);
  const state = "value" in stateCell && object(stateCell.value) ? stateCell.value : undefined;
  const stepCell = cellValue(snapshot.step, ORIGINAL_RECEIPT_BYTES);
  const step = "value" in stepCell && object(stepCell.value) ? stepCell.value : undefined;
  const validStep =
    step &&
    ["step", "seq", "turnIndex", "inboxConsumedSeq", "remainingMs", "turn", "iteration"].every(
      (key) => count.safeParse(step[key]).success,
    ) &&
    Array.isArray(step.inFlight) &&
    step.inFlight.every((call) => object(call) && typeof call.callId === "string" && typeof call.tool === "string");
  const intent = harnessLaunchIntentOf(state?.harnessLaunch);
  const facts = harnessFactsOf(state?.harness);
  const producerBound =
    intent?.phase === "begun" &&
    facts &&
    facts.harness === intent.harness &&
    facts.launchOrdinal === intent.ordinal &&
    sameOriginalSessionPolicy(facts.sessionPolicy, intent.sessionPolicy);
  let promotion: Extract<OriginalEvidence, { availability: "observed" }>["promotion"] = originalUnavailable("legacy");
  let source: Extract<OriginalEvidence, { availability: "observed" }>["source"] = originalUnavailable("legacy");
  const allocation = cellValue(snapshot.allocation, ORIGINAL_CELL_BYTES);
  if (!("value" in allocation)) promotion = allocation;
  else {
    const archive = workspaceDurabilityArchiveOf(allocation.value);
    if (!archive || archive.runId !== selector.runId || archive.startedAt !== snapshot.startedAt)
      promotion = originalUnavailable("corrupt");
    else if (archive.promotion) {
      const prepared = archive.promotion,
        body = promotionBodyOf(prepared.bodyJson);
      const expected = prepared.expectedSeed;
      const sameIdentity =
        body &&
        parseStoredJson(prepared.bodyJson).storeKey === snapshot.storeKey &&
        body.runId === selector.runId &&
        body.gen === selector.gen &&
        body.startedAt === snapshot.startedAt &&
        body.meta.userId === fields.userId &&
        body.meta.channelId === fields.channelId &&
        body.meta.repo === fields.repo &&
        body.threadKey === threadKey &&
        (body.meta.channelVisibility ?? "unknown") === fields.channelVisibility;
      if (!sameIdentity) return { kind: "unavailable", reason: "corrupt" };
      if (
        (await promotionBodyHash(prepared.bodyJson)) !== prepared.receipt.bodySha256 ||
        (expected && (await seedContentHash(expected)) !== prepared.receipt.expectedSeedSha256)
      )
        promotion = originalUnavailable("mismatch");
      else {
        let phase: "prepared-recorded" | "commit-recorded" | "confirmation-recorded" = "prepared-recorded";
        let valid = true;
        if (archive.promotionCommit) {
          valid = promotionCommitMatchesPreparation(archive.promotionCommit, prepared);
          phase = "commit-recorded";
        }
        if (archive.promotionConfirmation) {
          valid &&=
            !!archive.promotionCommit && confirmationMatchesPreparation(archive.promotionConfirmation, prepared);
          phase = "confirmation-recorded";
        }
        promotion = valid
          ? {
              state: phase,
              bodySha256: prepared.receipt.bodySha256,
              ...(prepared.receipt.expectedSeedSha256
                ? { expectedSeedSha256: prepared.receipt.expectedSeedSha256 }
                : {}),
            }
          : originalUnavailable("corrupt");
        if (valid && expected?.mode === "session" && expected.key && prepared.receipt.expectedSeedSha256) {
          const ref: SourceSeedReference = {
            storeKey: snapshot.storeKey,
            runId: selector.runId,
            gen: selector.gen,
            bodySha256: prepared.receipt.bodySha256,
            expectedSeedSha256: prepared.receipt.expectedSeedSha256,
          };
          const raw = await readSource(expected.key, ref);
          if (originalUnavailableSchema.safeParse(raw).success) source = originalUnavailableSchema.parse(raw);
          else {
            const receipt = sourceSeedOriginalOf(raw);
            if (!receipt) source = originalUnavailable(raw === undefined ? "missing" : "corrupt");
            else if (
              receipt.cancelledBy ||
              !sourceSeedReferenceMatches(receipt.receipt, ref, expected.key) ||
              receipt.receipt.startedAt !== expected.startedAt ||
              receipt.receipt.namespace !== expected.namespace ||
              receipt.receipt.requester !== expected.requester ||
              receipt.receipt.from !== expected.from ||
              receipt.receipt.through !== expected.through ||
              receipt.receipt.count !== expected.count
            )
              source = originalUnavailable("mismatch");
            else if (!receipt.release) source = { state: "verification-recorded" };
            else
              source =
                archive.promotionConfirmation &&
                canonicalSeedJson(receipt.release.confirmation) === canonicalSeedJson(archive.promotionConfirmation)
                  ? { state: "release-recorded-matched" }
                  : originalUnavailable("mismatch");
          }
        }
      }
    }
  }
  const checkpoint = state?.contextCheckpointReceipt;
  const checkpointBound =
    isContextCheckpointReceipt(checkpoint) &&
    checkpoint.runId === selector.runId &&
    checkpoint.ownerGen === selector.gen;
  const stateProblem = state ? undefined : "value" in stateCell ? originalUnavailable("corrupt") : stateCell;
  if (promotion.state === "unavailable" && source.state === "unavailable" && source.reason === "legacy")
    source = originalUnavailable(promotion.reason);
  return wrap({
    ...identity,
    availability: "observed",
    selection: "current-original",
    consistency: "per-boundary",
    state: state
      ? { state: "recorded", digest: await sourceHash(state) }
      : "value" in stateCell
        ? originalUnavailable("corrupt")
        : stateCell,
    step: validStep
      ? {
          state: "recorded",
          digest: await sourceHash(step),
          step: step.step as number,
          seq: step.seq as number,
          turnIndex: step.turnIndex as number,
          inFlight: (step.inFlight as unknown[]).length,
        }
      : "value" in stepCell
        ? originalUnavailable("corrupt")
        : stepCell,
    contextCheckpoint:
      stateProblem ??
      (checkpointBound
        ? { state: "recorded", digest: await sourceHash(checkpoint) }
        : originalUnavailable(checkpoint === undefined ? "missing" : "mismatch")),
    promotion,
    source,
    launch:
      stateProblem ??
      (intent
        ? { state: "recorded", phase: intent.phase, ordinal: intent.ordinal }
        : originalUnavailable(state?.harnessLaunch === undefined ? "missing" : "corrupt")),
    producer:
      stateProblem ??
      (producerBound
        ? {
            state: "recorded",
            digest: await sourceHash(state!.harness),
            harness: facts.harness,
            ordinal: intent.ordinal,
          }
        : originalUnavailable(state?.harness === undefined ? "missing" : "mismatch")),
    eventThrough: snapshot.eventThrough,
    appendAcknowledgement: "not-recorded",
    failedRequestBinding: "unknown",
    physicalEnding: "not-assessed",
  });
}
