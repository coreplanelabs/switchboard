import { describe, expect, it, vi } from "vitest";
import { recoverLinearDelivery } from "./recovery.js";
import { InMemoryRunLedger } from "../../core/runLedger/inMemory.js";
import type { RunStore } from "../../core/runStore.js";
import type { IncomingMessage } from "../../core/types.js";

const msg: IncomingMessage = {
  channelId: "linear:org:team",
  threadKey: "linear:org:s",
  userId: "linear:org:alice",
  text: "fix",
  messageId: "p",
};
const delivery = {
  event: {
    key: "key",
    receivedAt: 100,
    payload: { type: "AgentSessionEvent", action: "created", organizationId: "org" },
  },
  lease: "l",
  attempts: 2,
  begun: true,
};
const fixture = async (request?: Record<string, unknown>) => {
  const ledger = new InMemoryRunLedger(() => 100);
  await ledger.claim({
    runId: "run",
    threadKey: msg.threadKey,
    gen: "g",
    leaseMs: 100,
    startedAt: 100,
    meta: { ...msg, request },
    card: null,
    system: "",
    tools: [],
  });
  const store = { get: vi.fn<RunStore["get"]>(async () => null), list: vi.fn<RunStore["list"]>(async () => []) };
  return { ledger, store };
};
describe("Linear dispatch recovery", () => {
  it("finds a durable admission even when the run binding response was lost", async () => {
    expect(await recoverLinearDelivery(await fixture({ ...msg }), delivery, msg)).toBe("handled");
  });
  it("finds a durable follow-up without confusing another sender or message", async () => {
    const f = await fixture();
    await f.ledger.pushInbox("run", { ...msg });
    expect(await recoverLinearDelivery(f, delivery, msg)).toBe("handled");
    expect(await recoverLinearDelivery(f, delivery, { ...msg, userId: "linear:org:bob" })).toBe("unknown");
  });
  it("does not treat a runStarted binding without durable admission as success", async () => {
    expect(await recoverLinearDelivery(await fixture(), { ...delivery, runId: "run" }, msg)).toBe("unknown");
  });
  it("retains the delivery when the durable store is unavailable", async () => {
    const f = await fixture();
    f.store.list.mockRejectedValue(new Error("unavailable"));
    await expect(recoverLinearDelivery(f, delivery, msg)).rejects.toThrow("unavailable");
  });
});
