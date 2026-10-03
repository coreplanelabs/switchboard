import { describe, expect, it } from "vitest";
import { parsePreservationOwner } from "./sandboxCheckpoint.js";
import { verifyInstallRepairReceipt } from "./installRepairPolicy.js";

const owner = parsePreservationOwner({
  run: "11111111-1111-1111-1111-111111111111",
  requester: "slack:U123",
  thread: "slack:C123:123.456",
  repository: "acme/api",
  ref: "refs/heads/feature",
  head: "a".repeat(40),
  seed: "22222222-2222-2222-2222-222222222222",
  container: "33333333-3333-3333-3333-333333333333",
});
if (!owner || !("container" in owner)) throw new Error("invalid test owner");

const targetHead = "b".repeat(40);
const lockfileKey = "c".repeat(64);
const policy = { policyVersion: "npm-ci-v1" } as const;
const receipt = {
  version: "install-repair-receipt-v1",
  owner,
  targetHead,
  policyVersion: "npm-ci-v1",
  lockfileKey,
};
const expected = { owner, targetHead, policy, lockfileKey };

describe("install repair receipt", () => {
  it("accepts an exact target head distinct from the owner's admission head", () => {
    expect(owner.head).not.toBe(targetHead);
    expect(verifyInstallRepairReceipt(receipt, expected)).toBe(true);
  });

  it("rejects malformed or mismatched receipt bindings and injectable fields", () => {
    for (const field of Object.keys(receipt)) {
      const missing = { ...receipt } as Record<string, unknown>;
      delete missing[field];
      expect(verifyInstallRepairReceipt(missing, expected), `missing ${field}`).toBe(false);
    }
    for (const [field, value] of Object.entries({
      run: "44444444-4444-4444-4444-444444444444",
      requester: "slack:UOTHER",
      thread: "slack:COTHER:123.456",
      repository: "acme/other",
      ref: "refs/heads/other",
      head: "c".repeat(40),
      seed: "55555555-5555-5555-5555-555555555555",
      container: "66666666-6666-6666-6666-666666666666",
    })) {
      expect(verifyInstallRepairReceipt({ ...receipt, owner: { ...owner, [field]: value } }, expected), field).toBe(
        false,
      );
      const missingOwner = { ...owner } as Record<string, unknown>;
      delete missingOwner[field];
      expect(verifyInstallRepairReceipt({ ...receipt, owner: missingOwner }, expected), `missing owner ${field}`).toBe(
        false,
      );
    }
    for (const injected of [
      { ...receipt, command: "npm ci --ignore-scripts" },
      { ...receipt, env: { NODE_OPTIONS: "--require ./hack" } },
      { ...receipt, path: "../private" },
      { ...receipt, owner: { ...owner, command: "echo hi" } },
      { ...receipt, version: "install-repair-receipt-v2" },
      { ...receipt, policyVersion: "arbitrary" },
      { ...receipt, targetHead: "c".repeat(40) },
      { ...receipt, targetHead: "B".repeat(40) },
      { ...receipt, lockfileKey: "d".repeat(64) },
      { ...receipt, lockfileKey: "C".repeat(64) },
      { ...receipt, lockfileKey: "nested/package-lock.json" },
      { ...receipt, lockfileKey: "npm-shrinkwrap.json" },
      null,
      [],
    ]) {
      expect(verifyInstallRepairReceipt(injected, expected)).toBe(false);
    }
    expect(verifyInstallRepairReceipt(receipt, { ...expected, policy: { policyVersion: "other" } as never })).toBe(
      false,
    );
    expect(verifyInstallRepairReceipt(receipt, { ...expected, targetHead: "not-a-sha" })).toBe(false);
    expect(verifyInstallRepairReceipt(receipt, { ...expected, lockfileKey: "d".repeat(64) })).toBe(false);
    expect(verifyInstallRepairReceipt(receipt, { ...expected, lockfileKey: "package-lock.json" })).toBe(false);
    expect(verifyInstallRepairReceipt(receipt, { ...expected, owner: { ...owner, env: {} } } as never)).toBe(false);
  });
});
