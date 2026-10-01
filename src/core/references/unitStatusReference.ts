/** An immutable typed status in the existing shared session, not a grant. */
export interface UnitStatusReference {
  instanceId: string;
  unit: string;
  attempt: number;
  requester: string;
  channelId: string;
  threadKey: string;
  deliveryId: string;
  destinationThreadKey: string;
  repo: string;
  snapshotHash: string;
}

export function isUnitStatusReference(value: unknown): value is UnitStatusReference {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const r = value as UnitStatusReference;
  return (
    Object.keys(r).every((key) =>
      [
        "instanceId",
        "unit",
        "attempt",
        "requester",
        "channelId",
        "threadKey",
        "deliveryId",
        "destinationThreadKey",
        "repo",
        "snapshotHash",
      ].includes(key),
    ) &&
    [r.instanceId, r.unit, r.requester, r.channelId, r.threadKey, r.deliveryId, r.destinationThreadKey].every(
      (s) => typeof s === "string" && s.length > 0 && s.length <= 512,
    ) &&
    Number.isSafeInteger(r.attempt) &&
    r.attempt >= 0 &&
    typeof r.repo === "string" &&
    /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(r.repo) &&
    r.repo.length <= 256 &&
    typeof r.snapshotHash === "string" &&
    /^[a-f0-9]{64}$/.test(r.snapshotHash)
  );
}

export const unitStatusIdentity = (ref: UnitStatusReference): string =>
  JSON.stringify([
    ref.instanceId,
    ref.unit,
    ref.attempt,
    ref.requester,
    ref.channelId,
    ref.threadKey,
    ref.deliveryId,
    ref.destinationThreadKey,
  ]);
