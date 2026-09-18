import { describe, expect, it, vi } from "vitest";
import { LinearAcknowledgements } from "./acknowledgement.js";
import { InMemoryLinearInbox } from "./inbox.js";
import type { LinearApi } from "./api.js";
import type { LinearWebhookEvent } from "./webhook.js";

const event: LinearWebhookEvent = {
  key: "org:s:created",
  receivedAt: 100,
  payload: {
    type: "AgentSessionEvent",
    action: "created",
    organizationId: "org",
    appUserId: "bot",
    agentSession: { id: "s", organizationId: "org", appUserId: "bot", creatorId: "alice" },
    promptContext: "Fix it",
  },
};
function fixture() {
  let now = 100;
  const inbox = new InMemoryLinearInbox();
  const api: LinearApi = {
    openThread: vi.fn(),
    workItems: vi.fn(),
    files: vi.fn(async () => []),
    canRead: vi.fn(async () => true),
    upload: vi.fn(),
    session: vi.fn(async (id) => ({ id, appUserId: "bot", creatorId: "alice" })),
    activity: vi.fn(async () => {}),
    activities: vi.fn(),
    link: vi.fn(),
  };
  const deps = { inbox, api: vi.fn(async () => api), clock: () => now, warn: vi.fn() };
  return {
    inbox,
    api,
    deps,
    ack: new LinearAcknowledgements(deps),
    advance: () => {
      now += 10_000;
    },
  };
}
describe("Linear edge acknowledgement", () => {
  it("posts a native thought before releasing the delivery for dispatch", async () => {
    const f = fixture();
    await f.inbox.accept(event, { acknowledge: true });
    vi.mocked(f.api.activity).mockImplementation(async () => {
      expect(await f.inbox.claim(100, 100, "consumer")).toBeUndefined();
    });
    await f.ack.flush();
    expect(f.api.activity).toHaveBeenCalledWith(
      "s",
      { type: "thought", body: "Request received. Switchboard is preparing to work on it." },
      { id: expect.stringMatching(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/) },
    );
    expect((await f.inbox.claim(100, 100, "consumer"))?.event.key).toBe(event.key);
  });
  it("retries a failed acknowledgement across host replacement with the same activity id", async () => {
    const f = fixture();
    await f.inbox.accept(event, { acknowledge: true });
    vi.mocked(f.api.activity).mockRejectedValueOnce(new Error("unavailable"));
    await f.ack.flush();
    expect(await f.inbox.hasPendingAcks()).toBe(true);
    expect(await f.inbox.claim(100, 100, "consumer")).toBeUndefined();
    f.advance();
    await new LinearAcknowledgements(f.deps).flush();
    expect(vi.mocked(f.api.activity).mock.calls[0]?.[2]?.id).toBe(vi.mocked(f.api.activity).mock.calls[1]?.[2]?.id);
    expect(await f.inbox.hasPendingAcks()).toBe(false);
  });
  it("closes dismissed or permanently invalid sessions without starting work", async () => {
    const f = fixture();
    await f.inbox.accept(event, { acknowledge: true });
    vi.mocked(f.api.session).mockResolvedValueOnce({ id: "s", appUserId: "bot", dismissedAt: "removed" });
    await f.ack.flush();
    expect(f.api.activity).not.toHaveBeenCalled();
    expect(await f.inbox.claim(100, 100, "consumer")).toBeUndefined();
    const g = fixture();
    await g.inbox.accept({ ...event, payload: { ...event.payload, agentSession: { id: "s" } } }, { acknowledge: true });
    await g.ack.flush();
    expect(g.api.activity).toHaveBeenCalledWith("s", expect.objectContaining({ type: "error" }), expect.anything());
    expect(await g.inbox.claim(100, 100, "consumer")).toBeUndefined();
  });
});
