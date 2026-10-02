import { describe, expect, it } from "vitest";
import {
  isMainWorkReadReceipt,
  recordMainWorkRead,
  restoreMainWorkRead,
  workStateHash,
  type MainWorkRead,
  type MainWorkReadReceipt,
} from "./mainWorkObservation.js";
import { sourceHash } from "../references/receipts.js";

const receipt: MainWorkReadReceipt = {
  tool: "work_status",
  callId: "status-call",
  input: { actId: "fix-signups" },
  resultHash: "b".repeat(64),
  observation: {
    version: 1,
    actId: "fix-signups",
    instanceId: "ship_signup_1",
    unit: "task",
    attempt: 0,
    requesterId: "slack:UALICE",
    channelId: "slack:DMAIN",
    mainThreadKey: "slack:DMAIN:1.0",
    snapshotHash: "a".repeat(64),
    observedAt: 10,
  },
};

describe("current work observations", () => {
  it("rejects malformed receipts and retargeted inputs without interpreting prose", () => {
    expect(isMainWorkReadReceipt(receipt)).toBe(true);
    for (const invalid of [
      { ...receipt, tool: "other" },
      { ...receipt, resultHash: "running" },
      { ...receipt, input: { actId: "different" } },
      { ...receipt, input: { actId: "fix-signups", afterSeq: 1 } },
      { ...receipt, observation: { ...receipt.observation, observedAt: -1 } },
      { ...receipt, observation: { ...receipt.observation, attempt: 0.5 } },
      { ...receipt, observation: { ...receipt.observation, invented: true } },
    ])
      expect(isMainWorkReadReceipt(invalid)).toBe(false);
  });

  it("compares canonical state without treating object key ordering as a transition", async () => {
    expect(await workStateHash({ unit: { startedAt: 1, ending: undefined }, instance: { id: "ship" } })).toBe(
      await workStateHash({ instance: { id: "ship" }, unit: { startedAt: 1 } }),
    );
    expect(await workStateHash({ unit: { startedAt: 1 } })).not.toBe(await workStateHash({ unit: { startedAt: 2 } }));
  });

  it("hashes final bytes and keeps the original receipt immutable across a refresh", async () => {
    const input = { ...receipt, content: '{"state":"running"}' };
    let captured: MainWorkRead | undefined;
    const next = {
      observation: { ...receipt.observation, snapshotHash: "c".repeat(64), observedAt: 12 },
      content: '{"state":"ended"}',
    };
    await recordMainWorkRead(
      (read) => {
        captured = read;
      },
      input,
      async () => next,
    );
    input.observation = { ...receipt.observation, requesterId: "slack:UBOB" };
    expect(captured!.resultHash).toBe(await sourceHash('{"state":"running"}'));
    expect(await captured!.refresh()).toEqual({ kind: "changed", ...next, resultHash: await sourceHash(next.content) });
    expect(captured!.observation).toEqual(receipt.observation);
    expect(await captured!.refresh()).toEqual({ kind: "unchanged" });
  });

  it("never follows a replacement work owner while refreshing the original read", async () => {
    const refresh = restoreMainWorkRead(receipt, async () => ({
      observation: { ...receipt.observation, instanceId: "replacement" },
      content: "running",
    }));
    expect(await refresh()).toEqual({ kind: "unavailable" });
    expect(
      await restoreMainWorkRead(receipt, async () => {
        throw new Error("store unavailable");
      })(),
    ).toEqual({ kind: "unavailable" });
  });
});
