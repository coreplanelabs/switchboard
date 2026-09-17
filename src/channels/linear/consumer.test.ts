import { afterEach, describe, expect, it, vi } from "vitest";
import { LinearConsumer, type LinearConsumerDeps } from "./consumer.js";
import { InMemoryLinearInbox } from "./inbox.js";
import type { LinearApi } from "./api.js";
import type { LinearWebhookEvent } from "./webhook.js";

const event = (id = "s"): LinearWebhookEvent => ({
  key: `org:${id}:created`,
  receivedAt: 100,
  payload: {
    type: "AgentSessionEvent",
    action: "created",
    organizationId: "org",
    appUserId: "bot",
    agentSession: { id, appUserId: "bot", organizationId: "org", creatorId: "alice" },
    promptContext: "Fix login",
  },
});
function fixture() {
  let now = 100,
    serial = 0;
  const store = new InMemoryLinearInbox();
  const inbox = {
    claim: () => store.claim(now, 120_000, String(++serial)),
    begin: vi.fn((key: string, lease: string) => store.begin(key, lease)),
    bind: vi.fn((key: string, lease: string, id: string) => store.bind(key, lease, id)),
    renew: vi.fn((key: string, lease: string) => store.renew(key, lease, now + 120_000)),
    retry: vi.fn((key: string, lease: string) => store.retry(key, lease, now + 5000)),
    complete: vi.fn((key: string, lease: string) => store.complete(key, lease, now)),
  };
  const api: LinearApi = {
    session: vi.fn(async (id) => ({ id, appUserId: "bot", creatorId: "alice" })),
    activity: vi.fn(async () => {}),
    activities: vi.fn(async () => []),
    link: vi.fn(async () => {}),
  };
  const deps = {
    inbox,
    api: () => api,
    clock: () => now,
    warn: vi.fn(),
    dispatch: vi.fn<LinearConsumerDeps["dispatch"]>(async () => {}),
    stop: vi.fn(async () => {}),
    recover: vi.fn(async (): Promise<"handled" | "unknown"> => "unknown"),
    other: vi.fn(async () => {}),
    leaseLost: vi.fn(),
  };
  return {
    store,
    inbox,
    api,
    deps,
    consumer: new LinearConsumer(deps),
    advance: (ms: number) => {
      now += ms;
    },
  };
}
afterEach(() => vi.useRealTimers());

describe("Linear event consumer", () => {
  it("records dispatch entry before invoking the core and completes only after its reply", async () => {
    const f = fixture();
    await f.store.accept(event());
    let finish!: () => void;
    f.deps.dispatch.mockImplementation(async (...args: unknown[]) => {
      expect(f.inbox.begin).toHaveBeenCalled();
      const io = args[1] as { runStarted(start: { id: string }): void };
      io.runStarted({ id: "run" });
      await new Promise<void>((resolve) => {
        finish = resolve;
      });
    });
    await f.consumer.poll();
    await vi.waitFor(() => expect(f.inbox.bind).toHaveBeenCalledWith(event().key, "1", "run"));
    expect(f.inbox.complete).not.toHaveBeenCalled();
    finish();
    await f.consumer.settled();
    expect(f.inbox.complete).toHaveBeenCalledWith(event().key, "1");
    expect(f.deps.dispatch.mock.calls[0]?.[0]).toMatchObject({ userId: "linear:org:alice", text: "Fix login" });
  });
  it("keeps transport failures pending without recording dispatch entry", async () => {
    const f = fixture();
    await f.store.accept(event());
    vi.mocked(f.api.session).mockRejectedValueOnce(new Error("transport"));
    await f.consumer.poll();
    await f.consumer.settled();
    expect(f.inbox.begin).not.toHaveBeenCalled();
    expect(f.inbox.retry).toHaveBeenCalled();
    f.advance(5000);
    await f.consumer.poll();
    await f.consumer.settled();
    expect(f.deps.dispatch).toHaveBeenCalledOnce();
  });
  it("lets the core replace an interrupted run without losing the delivery lease", async () => {
    const f = fixture();
    await f.store.accept(event());
    f.deps.dispatch.mockImplementation(async (_msg, io) => {
      io.runStarted?.({ id: "first" });
      io.runStarted?.({ id: "replacement" });
    });
    await f.consumer.poll();
    await f.consumer.settled();
    expect(f.inbox.bind).toHaveBeenCalledTimes(1);
    expect(f.deps.leaseLost).not.toHaveBeenCalled();
    expect(f.inbox.complete).toHaveBeenCalledOnce();
  });
  it("reconciles a begun delivery and never dispatches an uncertain command twice", async () => {
    const f = fixture();
    await f.store.accept(event());
    await f.store.claim(100, 1, "old");
    await f.store.begin(event().key, "old");
    f.advance(2);
    await f.consumer.poll();
    await f.consumer.settled();
    expect(f.deps.dispatch).not.toHaveBeenCalled();
    expect(f.deps.recover).toHaveBeenCalledOnce();
    expect(f.api.activity).toHaveBeenCalledWith("s", expect.objectContaining({ type: "error" }));
    expect(f.inbox.complete).toHaveBeenCalledOnce();
  });
  it("lets the durable ledger continue an admitted run without another answer", async () => {
    const f = fixture();
    await f.store.accept(event());
    await f.store.claim(100, 1, "old");
    await f.store.begin(event().key, "old");
    await f.store.bind(event().key, "old", "run");
    f.advance(2);
    f.deps.recover.mockResolvedValue("handled");
    await f.consumer.poll();
    await f.consumer.settled();
    expect(f.deps.dispatch).not.toHaveBeenCalled();
    expect(f.api.activity).not.toHaveBeenCalled();
    expect(f.inbox.complete).toHaveBeenCalledOnce();
  });
  it("renews slow work, admits another session and stops intake during drain", async () => {
    vi.useFakeTimers();
    const f = fixture();
    let finish!: () => void;
    f.deps.dispatch.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    await f.store.accept(event());
    await f.store.accept(event("s2"));
    await f.consumer.poll();
    await vi.advanceTimersByTimeAsync(40_000);
    expect(f.deps.dispatch).toHaveBeenCalledTimes(2);
    expect(f.inbox.renew).toHaveBeenCalledWith(event().key, "1");
    f.consumer.stop();
    await f.store.accept(event("s3"));
    await f.consumer.poll();
    expect(f.deps.dispatch).toHaveBeenCalledTimes(2);
    finish();
    await f.consumer.settled();
  });
  it("routes stop as a control input, without interpreting its text as an agent request", async () => {
    const f = fixture(),
      stop = event();
    stop.payload.action = "prompted";
    stop.payload.agentActivity = {
      id: "a",
      agentSessionId: "s",
      userId: "alice",
      signal: "stop",
      content: { type: "prompt", body: "stop" },
    };
    await f.store.accept(stop);
    await f.consumer.poll();
    await f.consumer.settled();
    expect(f.deps.stop).toHaveBeenCalledWith(
      expect.objectContaining({ userId: "linear:org:alice", threadKey: "linear:org:s" }),
      expect.anything(),
    );
    expect(f.deps.dispatch).not.toHaveBeenCalled();
  });
  it("preserves session arrival order through admission without waiting for the agent to finish", async () => {
    const f = fixture();
    let admitted!: () => void, finished!: () => void;
    f.deps.dispatch.mockImplementationOnce(async (_msg, io) => {
      await new Promise<void>((resolve) => {
        admitted = resolve;
      });
      io.runStarted?.({ id: "run" });
      await new Promise<void>((resolve) => {
        finished = resolve;
      });
    });
    const follow = event();
    follow.key = "follow";
    follow.payload.action = "prompted";
    follow.payload.agentActivity = {
      id: "p",
      agentSessionId: "s",
      userId: "alice",
      content: { type: "prompt", body: "Use OAuth" },
    };
    await f.store.accept(event());
    await f.store.accept(follow);
    await f.consumer.poll();
    expect(f.deps.dispatch).toHaveBeenCalledTimes(1);
    admitted();
    await vi.waitFor(() => expect(f.deps.dispatch).toHaveBeenCalledTimes(2));
    finished();
    await f.consumer.settled();
  });
  it("fails closed on stale ownership and never discards a lifecycle event on handler failure", async () => {
    const f = fixture();
    const lifecycle = event();
    lifecycle.payload.type = "OAuthApp";
    await f.store.accept(lifecycle);
    f.deps.other.mockRejectedValue(new Error("unavailable"));
    await f.consumer.poll();
    await f.consumer.settled();
    expect(f.inbox.complete).not.toHaveBeenCalled();
    expect(f.inbox.retry).toHaveBeenCalled();
    const g = fixture();
    await g.store.accept(event());
    g.inbox.begin.mockResolvedValue(false);
    await g.consumer.poll();
    await g.consumer.settled();
    expect(g.deps.dispatch).not.toHaveBeenCalled();
    expect(g.inbox.complete).not.toHaveBeenCalled();
  });
  it("closes permanently invalid signed inputs honestly without retrying them forever", async () => {
    const f = fixture(),
      invalid = event();
    invalid.payload.agentSession = { id: "s", appUserId: "bot", organizationId: "org" };
    await f.store.accept(invalid);
    await f.consumer.poll();
    await f.consumer.settled();
    expect(f.deps.dispatch).not.toHaveBeenCalled();
    expect(f.inbox.retry).not.toHaveBeenCalled();
    expect(f.api.activity).toHaveBeenCalledWith("s", expect.objectContaining({ type: "error" }));
    expect(f.inbox.complete).toHaveBeenCalledOnce();
  });
});
