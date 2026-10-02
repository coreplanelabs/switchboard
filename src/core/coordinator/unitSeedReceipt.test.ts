import { describe, expect, it } from "vitest";
import { isUnitSeedReceipt, type UnitSeedReceipt } from "./unitSeedReceipt.js";

const receipt: UnitSeedReceipt = {
  version: 1,
  binding: {
    instanceId: "ship_signup_1",
    unit: "task",
    instanceAttempt: 0,
    idempotencyKey: "ship_signup_1:task/0/coding",
  },
  child: {
    runId: "child-run",
    requester: "slack:UALICE",
    channelId: "slack:DMAIN",
    threadKey: "private:worker:ship_signup_1:task",
  },
  ownerGen: "generation-1",
  workBriefHash: "a".repeat(64),
  capsuleHash: "b".repeat(64),
  contractHash: "c".repeat(64),
  seed: {
    key: "ship_signup_1:task:coding",
    from: 0,
    through: 5,
    messagesHash: "d".repeat(64),
    systemHash: "e".repeat(64),
  },
  acknowledgedAt: 20,
};

describe("unit seed receipt schema", () => {
  it("round-trips an exact acknowledged seed without claiming execution began", () => {
    expect(isUnitSeedReceipt(JSON.parse(JSON.stringify(receipt)))).toBe(true);
    expect(isUnitSeedReceipt({ ...receipt, providerStarted: true })).toBe(false);
  });
  it.each([
    { ...receipt, ownerGen: "" },
    { ...receipt, workBriefHash: "complete" },
    { ...receipt, capsuleHash: "B".repeat(64) },
    { ...receipt, contractHash: null },
    { ...receipt, child: { ...receipt.child, runId: "" } },
    { ...receipt, binding: { ...receipt.binding, instanceAttempt: -1 } },
    { ...receipt, binding: { ...receipt.binding, instanceAttempt: 0.5 } },
    { ...receipt, seed: { ...receipt.seed, through: -1 } },
    { ...receipt, seed: { ...receipt.seed, from: 6 } },
    { ...receipt, seed: { ...receipt.seed, systemHash: "" } },
    { ...receipt, acknowledgedAt: Infinity },
    { ...receipt, acknowledgedAt: -1 },
  ])("rejects malformed or incomplete persisted receipt %#", (value) => {
    expect(isUnitSeedReceipt(value)).toBe(false);
  });
});
