import { parsePreservationOwner, sameOwner, type PreservationOwner } from "./sandboxCheckpoint.js";

/** A trusted operator declaration, never a command supplied by a run or model. */
export const INSTALL_REPAIR_POLICY_VERSION = "npm-ci-v1";
export type InstallRepairPolicy = { policyVersion: typeof INSTALL_REPAIR_POLICY_VERSION };

export const INSTALL_REPAIR_RECEIPT_VERSION = "install-repair-receipt-v1";

export interface InstallRepairReceipt {
  version: typeof INSTALL_REPAIR_RECEIPT_VERSION;
  owner: PreservationOwner;
  targetHead: string;
  policyVersion: typeof INSTALL_REPAIR_POLICY_VERSION;
  /** SHA-256 of root lockfile entries committed at targetHead, not a path. */
  lockfileKey: string;
}

export type InstallRepairAttempt = { kind: "none" | "unknown" } | { kind: "completed"; receipt: InstallRepairReceipt };

const RECEIPT_FIELDS = ["version", "owner", "targetHead", "policyVersion", "lockfileKey"] as const;
const TARGET_HEAD = /^[0-9a-f]{40}$/;
const LOCKFILE_KEY = /^[0-9a-f]{64}$/;

/** Checks only identity and shape. The future Worker must establish the install
 * effect, that the root lockfile is committed, and that it owns a no-wake
 * exclusive route; a matching receipt alone authorizes none of these. */
export function verifyInstallRepairReceipt(
  receipt: unknown,
  expected: { owner: PreservationOwner; targetHead: string; policy: InstallRepairPolicy; lockfileKey: string },
): boolean {
  if (
    !receipt ||
    typeof receipt !== "object" ||
    Array.isArray(receipt) ||
    Object.keys(receipt).length !== RECEIPT_FIELDS.length ||
    Object.keys(receipt).some((key) => !RECEIPT_FIELDS.includes(key as (typeof RECEIPT_FIELDS)[number]))
  )
    return false;
  if (
    !expected.policy ||
    typeof expected.policy !== "object" ||
    Array.isArray(expected.policy) ||
    Object.keys(expected.policy).length !== 1 ||
    expected.policy.policyVersion !== INSTALL_REPAIR_POLICY_VERSION ||
    typeof expected.targetHead !== "string" ||
    !TARGET_HEAD.test(expected.targetHead) ||
    typeof expected.lockfileKey !== "string" ||
    !LOCKFILE_KEY.test(expected.lockfileKey) ||
    !parsePreservationOwner(expected.owner)
  )
    return false;
  const record = receipt as Record<string, unknown>;
  const owner = parsePreservationOwner(record.owner);
  return (
    !!owner &&
    "container" in owner &&
    sameOwner(owner, expected.owner) &&
    record.version === INSTALL_REPAIR_RECEIPT_VERSION &&
    record.targetHead === expected.targetHead &&
    record.policyVersion === expected.policy.policyVersion &&
    record.lockfileKey === expected.lockfileKey
  );
}
