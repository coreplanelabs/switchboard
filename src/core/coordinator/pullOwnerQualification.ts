import { sourceHash } from "../references/receipts.js";
import { canonicalSeedJson } from "../runLedger/seedManifest.js";
import { isRunWorkOwner, RUN_ID_PATTERN, type RunWorkOwner } from "../runRecord.js";
import { isCoordinatorInstance, isCoordinatorUnit } from "./contract.js";
import { historicalOwnerRecord, type HistoricalOwnerRecord } from "./historicalNativeAudit.js";
import type { PullOwnershipRows, PullTarget } from "./pullOwnership.js";

export const INITIAL_OWNER_PREDICATES = [
  "record_identity",
  "terminal_coding",
  "publication_shape",
  "door_intent",
  "canonical_unit",
  "native_confirmation",
  "native_receipt",
  "owner_binding",
  "unit_authority",
] as const;
export type InitialOwnerPredicate = (typeof INITIAL_OWNER_PREDICATES)[number];
export interface PullOwnerQualification {
  version: 1;
  runId: string;
  failedPredicate: InitialOwnerPredicate;
  targetDigest: string;
  ownerProjectionDigest: string;
  dependencyDigest: string;
}
/** Private immutable hash inputs only; never serialized as diagnostic output. */
export interface PullOwnerQualificationSnapshot {
  runId: string;
  failedPredicate: InitialOwnerPredicate;
  target: string;
  owner: string;
  dependencies: string;
}

export function initialOwnerUnits(record: RunWorkOwner, units: PullOwnershipRows["units"]): PullOwnershipRows["units"] {
  return units.filter(
    (row) =>
      isCoordinatorInstance(row.instance) &&
      isCoordinatorUnit(row.unit) &&
      row.instance.id === record.parentInstanceId &&
      row.unit.instanceId === record.parentInstanceId &&
      row.unit.unit === record.coordinatorUnit,
  );
}

/** Canonical decoded target, not raw transport keys or a scan cursor. */
export function pullOwnerTargetProjection(target: PullTarget): string {
  return canonicalSeedJson({
    repo: target.repo.toLowerCase(),
    pr: target.pr,
    ref: target.ref?.startsWith("refs/heads/") ? target.ref.slice("refs/heads/".length) : target.ref,
  });
}

/** Reusable with existing exact record/instance/unit reads. Supply only the
 * already-stored native event projection when its existing audit is relevant. */
export function pullOwnerQualificationSnapshot(
  target: PullTarget,
  run: PullOwnershipRows["runs"][number],
  units: PullOwnershipRows["units"],
  failedPredicate: InitialOwnerPredicate,
): PullOwnerQualificationSnapshot | undefined {
  if (run.live || typeof run.runId !== "string" || !RUN_ID_PATTERN.test(run.runId)) return;
  const identity =
    isRunWorkOwner(run.record) && run.record.id === run.runId && run.record.repo === run.repo ? run.record : undefined;
  const record =
    run.record && typeof run.record === "object" && !Array.isArray(run.record)
      ? historicalOwnerRecord({
          ...run.record,
          branchPublication: run.publication,
          branchPushReceipts: run.pushReceipts,
          doorPublicationPending: run.door,
        } as HistoricalOwnerRecord)
      : {
          malformedRecord: run.record,
          branchPublication: run.publication,
          branchPushReceipts: run.pushReceipts,
          doorPublicationPending: run.door,
        };
  const bound = identity ? initialOwnerUnits(identity, units) : undefined;
  return {
    runId: run.runId,
    failedPredicate,
    target: pullOwnerTargetProjection(target),
    owner: canonicalSeedJson({ runId: run.runId, live: run.live, repo: run.repo, record }),
    dependencies: canonicalSeedJson(
      bound
        ? {
            units: bound.slice().sort((a, b) => {
              const left = canonicalSeedJson(a),
                right = canonicalSeedJson(b);
              return left < right ? -1 : left > right ? 1 : 0;
            }),
            historicalEvents: bound.some((row) => isCoordinatorUnit(row.unit) && row.unit.adoption?.audit)
              ? run.historicalEvents
              : undefined,
          }
        : { kind: "unbound", reason: "record_identity" },
    ),
  };
}

export async function qualifyPullOwnerSnapshot(
  snapshot: PullOwnerQualificationSnapshot,
): Promise<PullOwnerQualification> {
  const [targetDigest, ownerProjectionDigest, dependencyDigest] = await Promise.all([
    sourceHash(snapshot.target),
    sourceHash(snapshot.owner),
    sourceHash(snapshot.dependencies),
  ]);
  return {
    version: 1,
    runId: snapshot.runId,
    failedPredicate: snapshot.failedPredicate,
    targetDigest,
    ownerProjectionDigest,
    dependencyDigest,
  };
}

/** A locator is observation only. Unsupported or extra fields give no locator. */
export function pullOwnerQualificationFrom(value: unknown, targetDigest: string): PullOwnerQualification | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return;
  const v = value as Record<string, unknown>;
  if (
    Object.keys(v).length !== 6 ||
    Object.keys(v).some(
      (key) =>
        !["version", "runId", "failedPredicate", "targetDigest", "ownerProjectionDigest", "dependencyDigest"].includes(
          key,
        ),
    ) ||
    v.version !== 1 ||
    typeof v.runId !== "string" ||
    !RUN_ID_PATTERN.test(v.runId) ||
    !INITIAL_OWNER_PREDICATES.includes(v.failedPredicate as InitialOwnerPredicate) ||
    v.targetDigest !== targetDigest ||
    ![v.targetDigest, v.ownerProjectionDigest, v.dependencyDigest].every(
      (digest) => typeof digest === "string" && /^[a-f0-9]{64}$/.test(digest),
    )
  )
    return;
  return {
    version: 1,
    runId: v.runId,
    failedPredicate: v.failedPredicate as InitialOwnerPredicate,
    targetDigest: v.targetDigest as string,
    ownerProjectionDigest: v.ownerProjectionDigest as string,
    dependencyDigest: v.dependencyDigest as string,
  };
}
