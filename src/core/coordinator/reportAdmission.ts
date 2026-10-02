export interface CoordinatorReportOwner {
  instanceId: string;
  unit: string;
  attempt: number;
  requester: string;
  channelId: string;
  threadKey: string;
  deliveryId: string;
}
/** Committed with the canonical unit before any immutable display row. */
export interface CoordinatorReportAdmission {
  version: 1;
  owner: CoordinatorReportOwner;
  proposalHash: string;
}
export function isCoordinatorReportAdmission(value: unknown): value is CoordinatorReportAdmission {
  if (!value || typeof value !== "object") return false;
  const a = value as CoordinatorReportAdmission;
  return (
    Object.keys(a).length === 3 &&
    a.version === 1 &&
    typeof a.proposalHash === "string" &&
    /^[a-f0-9]{64}$/.test(a.proposalHash) &&
    !!a.owner &&
    typeof a.owner === "object" &&
    Object.keys(a.owner).length === 7 &&
    [
      a.owner.instanceId,
      a.owner.unit,
      a.owner.requester,
      a.owner.channelId,
      a.owner.threadKey,
      a.owner.deliveryId,
    ].every((v) => typeof v === "string" && v.length > 0 && v.length <= 512) &&
    Number.isSafeInteger(a.owner.attempt) &&
    a.owner.attempt >= 0
  );
}
