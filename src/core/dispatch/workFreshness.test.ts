import { describe, expect, it, vi } from "vitest";
import { sourceHash } from "../references/receipts.js";
import { restoreMainWorkRead, type MainWorkRead } from "../coordinator/mainWorkObservation.js";
import { createWorkFreshness } from "./workFreshness.js";

const observation = {
  version: 1 as const,
  actId: "work",
  instanceId: "instance",
  unit: "unit-one",
  attempt: 0,
  requesterId: "slack:U",
  channelId: "slack:C",
  mainThreadKey: "slack:C:1",
  snapshotHash: "a".repeat(64),
  observedAt: 10,
};
async function reading(): Promise<MainWorkRead> {
  return {
    tool: "work_status",
    callId: "call-1",
    input: { actId: "work" },
    observation,
    resultHash: await sourceHash("running"),
    content: "running",
    refresh: vi.fn().mockResolvedValue({ kind: "unchanged" }),
  };
}
const owner = {
  requesterId: observation.requesterId,
  channelId: observation.channelId,
  threadKey: observation.mainThreadKey,
};
const tracker = (save = vi.fn().mockResolvedValue(true)) => createWorkFreshness({ owner, save });

describe("current work answer freshness", () => {
  it("requires a durable receipt before exposing a read and leaves its original bytes immutable", async () => {
    const save = vi.fn().mockResolvedValue(true),
      state = tracker(save),
      read = await reading();
    await state.observe(read);
    expect(save).toHaveBeenCalledWith({
      workReads: [
        {
          tool: read.tool,
          callId: read.callId,
          input: read.input,
          observation: read.observation,
          resultHash: read.resultHash,
        },
      ],
    });
    read.observation = { ...observation, snapshotHash: "b".repeat(64) };
    expect(state.receipts()[0]?.observation.snapshotHash).toBe("a".repeat(64));
    await expect(tracker(vi.fn().mockResolvedValue(false)).observe(read)).rejects.toThrow("saved");
  });
  it("serializes simultaneous read admissions and restores both immutable call receipts", async () => {
    let release!: () => void, entered!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    let saved: unknown;
    const save = vi.fn(async (value) => {
      if (save.mock.calls.length === 1) {
        entered();
        await blocked;
      }
      saved = JSON.parse(JSON.stringify(value));
      return true;
    });
    const state = tracker(save),
      first = await reading(),
      second = {
        ...(await reading()),
        callId: "call-2",
        input: { actId: "other" },
        observation: { ...observation, actId: "other", unit: "unit-two" },
      };
    const pending = Promise.all([state.observe(first), state.observe(second)]);
    await started;
    expect(save).toHaveBeenCalledTimes(1);
    release();
    await pending;
    expect(saved).toEqual({ workReads: state.receipts() });
    expect(state.receipts()).toHaveLength(2);
    const messages = [first, second].flatMap((r) => [
      {
        role: "assistant" as const,
        content: [{ type: "tool_use" as const, id: r.callId, name: r.tool, input: r.input }],
      },
      { role: "user" as const, content: [{ type: "tool_result" as const, toolUseId: r.callId, content: r.content }] },
    ]);
    const restored = tracker(),
      reads = vi.fn(() => vi.fn().mockResolvedValue({ kind: "unchanged" }));
    await restored.restore(state.receipts(), messages, reads, false);
    expect(reads).toHaveBeenCalledTimes(2);
    expect(await restored.beforePublish()).toBeUndefined();
  });
  it("revises an answer based on an earlier status even after a later status for the same unit", async () => {
    const state = tracker(),
      first = await reading(),
      second = {
        ...(await reading()),
        callId: "call-2",
        content: "ended",
        resultHash: await sourceHash("ended"),
        observation: { ...observation, snapshotHash: "b".repeat(64), observedAt: 20 },
      };
    first.refresh = vi
      .fn()
      .mockResolvedValueOnce({
        kind: "changed",
        observation: second.observation,
        resultHash: second.resultHash,
        content: second.content,
      })
      .mockResolvedValue({ kind: "unchanged" });
    await state.observe(first);
    await state.observe(second);
    const revise = vi.fn().mockResolvedValue("The work ended.");
    expect(await state.finalize("The work is running.", revise)).toBe("The work ended.");
    expect(revise).toHaveBeenCalledOnce();
    expect(revise.mock.calls[0]?.[0]).toContain("ended");
    expect(first.refresh).toHaveBeenCalledTimes(2);
    expect(second.refresh).toHaveBeenCalledTimes(2);
  });
  it("restores both statuses for the same unit and detects the earlier result's transition", async () => {
    const first = await reading(),
      second = {
        ...(await reading()),
        callId: "call-2",
        content: "ended",
        resultHash: await sourceHash("ended"),
        observation: { ...observation, snapshotHash: "b".repeat(64), observedAt: 20 },
      };
    const receipts = [first, second].map(({ refresh: _, content: __, ...receipt }) => receipt);
    const messages = [first, second].flatMap((r) => [
      {
        role: "assistant" as const,
        content: [{ type: "tool_use" as const, id: r.callId, name: r.tool, input: r.input }],
      },
      { role: "user" as const, content: [{ type: "tool_result" as const, toolUseId: r.callId, content: r.content }] },
    ]);
    const readCurrent = vi.fn().mockResolvedValue({ observation: second.observation, content: second.content });
    const restored = vi.fn((receipt: (typeof receipts)[number]) => restoreMainWorkRead(receipt, readCurrent));
    const state = tracker();
    await state.restore(receipts, messages, restored, false);
    const revise = vi.fn().mockResolvedValue("The work ended.");
    expect(await state.finalize("The work is running.", revise)).toBe("The work ended.");
    expect(revise.mock.calls[0]?.[0]).toContain("ended");
    expect(restored).toHaveBeenCalledTimes(2);
    expect(readCurrent).toHaveBeenCalledTimes(4);
  });
  it("refreshes a changed answer once then rechecks without treating change as an access revocation", async () => {
    const state = tracker(),
      read = await reading();
    read.refresh = vi
      .fn()
      .mockResolvedValueOnce({
        kind: "changed",
        observation: { ...observation, snapshotHash: "b".repeat(64), observedAt: 20 },
        resultHash: await sourceHash("aborted"),
        content: "aborted",
      })
      .mockResolvedValue({ kind: "unchanged" });
    await state.observe(read);
    const revise = vi.fn().mockResolvedValue("The work was aborted.");
    expect(await state.finalize("The work is running.", revise)).toBe("The work was aborted.");
    expect(revise).toHaveBeenCalledOnce();
    expect(revise.mock.calls[0]?.[0]).toContain("aborted");
    expect(await state.beforePublish()).toBeUndefined();
    expect(state.receipts()[0]?.observation.observedAt).toBe(10);
  });
  it("withholds claims if the work changes again after the bounded refresh", async () => {
    const state = tracker(),
      read = await reading();
    read.refresh = vi.fn().mockResolvedValue({
      kind: "changed",
      observation: { ...observation, observedAt: 20 },
      resultHash: await sourceHash("aborted"),
      content: "aborted",
    });
    await state.observe(read);
    const revise = vi.fn().mockResolvedValue("running");
    expect(await state.finalize("running", revise)).toContain("current state remains unconfirmed");
    expect(revise).toHaveBeenCalledOnce();
    expect(await state.beforePublish()).toContain("unconfirmed");
  });
  it("catches a transition at the last reply boundary without releasing stale prose", async () => {
    const state = tracker(),
      read = await reading();
    const refresh = vi.fn().mockResolvedValueOnce({ kind: "unchanged" }).mockResolvedValue({ kind: "unavailable" });
    read.refresh = refresh;
    await state.observe(read);
    expect(await state.finalize("running")).toBe("running");
    expect(await state.beforePublish()).toContain("unconfirmed");
  });
  it("restores only receipt bytes that match the saved call and result under the same owner", async () => {
    const read = await reading();
    const { refresh: _, content, ...receipt } = read;
    const state = tracker(),
      restore = vi.fn().mockReturnValue(vi.fn().mockResolvedValue({ kind: "unchanged" }));
    const messages = [
      {
        role: "assistant" as const,
        content: [{ type: "tool_use" as const, id: read.callId, name: read.tool, input: read.input }],
      },
      { role: "user" as const, content: [{ type: "tool_result" as const, toolUseId: read.callId, content }] },
    ];
    await state.restore([receipt], messages, restore, false);
    expect(restore).toHaveBeenCalledOnce();
    expect(await state.beforePublish()).toBeUndefined();
    const bad = tracker();
    await bad.restore([{ ...receipt, resultHash: "b".repeat(64) }], messages, restore, false);
    expect(await bad.beforePublish()).toContain("unconfirmed");
    const foreign = tracker();
    await foreign.restore(
      [{ ...receipt, observation: { ...observation, requesterId: "other" } }],
      messages,
      restore,
      false,
    );
    expect(await foreign.beforePublish()).toContain("unconfirmed");
  });
  it("does not buy another refresh after restart or accept an unreceipted status result", async () => {
    const read = await reading();
    const { refresh: _, content, ...receipt } = read;
    const state = tracker(),
      revise = vi.fn();
    const messages = [
      {
        role: "assistant" as const,
        content: [{ type: "tool_use" as const, id: read.callId, name: read.tool, input: read.input }],
      },
      { role: "user" as const, content: [{ type: "tool_result" as const, toolUseId: read.callId, content }] },
    ];
    await state.restore(
      [receipt],
      messages,
      () => vi.fn().mockResolvedValue({ kind: "changed", observation, resultHash: read.resultHash, content }),
      true,
    );
    expect(await state.finalize("running", revise)).toContain("unconfirmed");
    expect(revise).not.toHaveBeenCalled();
    const missing = tracker();
    await missing.restore([], messages, () => undefined, false);
    expect(await missing.beforePublish()).toContain("unconfirmed");
  });
});
