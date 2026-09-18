import { afterEach, describe, expect, it, vi } from "vitest";
import { LinearConsumer, type LinearConsumerDeps } from "./consumer.js";
import { InMemoryLinearInbox } from "./inbox.js";
import type { LinearApi } from "./api.js";
import type { LinearWebhookEvent } from "./webhook.js";
import { stopLinearSession } from "./control.js";
import { grantsFor } from "../../core/authz/grants.js";
import { RunRegistry } from "../../core/runRegistry.js";
import { createRunsService } from "../../core/runsService.js";
import { NullRunStore } from "../../core/runStore.js";

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
function fixture(maxStagedBytes?: number) {
  let now = 100,
    serial = 0;
  const store = new InMemoryLinearInbox();
  const inbox = {
    claim: () => store.claim(now, 120_000, String(++serial)),
    begin: vi.fn((key: string, lease: string) => store.begin(key, lease)),
    bind: vi.fn((key: string, lease: string, id: string) => store.bind(key, lease, id)),
    renew: vi.fn((key: string, lease: string) => store.renew(key, lease, now + 120_000)),
    defer: vi.fn((key: string, lease: string) => store.defer(key, lease, now + 5000)),
    retry: vi.fn((key: string, lease: string) => store.retry(key, lease, now + 5000)),
    complete: vi.fn((key: string, lease: string) => store.complete(key, lease, now)),
  };
  const api: LinearApi = {
    openThread: vi.fn(),
    workItems: vi.fn(),
    files: vi.fn(async () => []),
    canRead: vi.fn(async () => true),
    upload: vi.fn(),
    session: vi.fn(async (id) => ({ id, appUserId: "bot", creatorId: "alice" })),
    activity: vi.fn(async () => {}),
    activities: vi.fn(async () => []),
    link: vi.fn(async () => {}),
  };
  const deps = {
    maxStagedBytes,
    inbox,
    api: () => api,
    clock: () => now,
    warn: vi.fn(),
    dispatch: vi.fn<LinearConsumerDeps["dispatch"]>(async () => {}),
    stop: vi.fn<LinearConsumerDeps["stop"]>(async () => {}),
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
  it("does not replay a no-effects deferral that finishes after an authorized Stop", async () => {
    const f = fixture();
    let defer!: () => void;
    f.deps.dispatch.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          defer = () => resolve({ deferred: true });
        }),
    );
    await f.store.accept(event());
    await f.consumer.poll();
    await vi.waitFor(() => expect(f.deps.dispatch).toHaveBeenCalledOnce());
    const runs = createRunsService({ registry: new RunRegistry(), store: new NullRunStore() });
    f.deps.stop.mockImplementationOnce((input, io) =>
      stopLinearSession({ runs, inbox: f.store, config: { grantsFor: (id) => grantsFor(id, {}) } }, input, io),
    );
    const stop = event();
    stop.key = "stop-deferred";
    stop.receivedAt = 150;
    stop.payload.action = "prompted";
    stop.payload.agentActivity = {
      id: "stop-deferred",
      agentSessionId: "s",
      userId: "alice",
      signal: "stop",
      content: { type: "prompt", body: "Stop" },
    };
    await f.store.accept(stop);
    await f.consumer.poll();
    await vi.waitFor(() => expect(f.inbox.complete).toHaveBeenCalledWith(stop.key, expect.any(String)));
    defer();
    await f.consumer.settled();
    f.advance(200_000);
    await f.consumer.poll();
    await f.consumer.settled();
    expect(f.deps.dispatch).toHaveBeenCalledOnce();
    expect(f.deps.recover).not.toHaveBeenCalled();
    expect(f.deps.warn).not.toHaveBeenCalled();
    const later = event();
    later.key = "after-stop";
    later.receivedAt = 200_100;
    await f.store.accept(later);
    await f.consumer.poll();
    await f.consumer.settled();
    expect(f.deps.dispatch).toHaveBeenCalledTimes(2);
  });
  it("does not dispatch a file-hydrating request cancelled durably by a later Stop", async () => {
    const f = fixture();
    const preparing = event();
    preparing.payload.promptContext = "Read [notes.txt](https://uploads.linear.app/org/notes)";
    let finishFiles!: () => void;
    vi.mocked(f.api.files).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishFiles = () => resolve([]);
        }),
    );
    await f.store.accept(preparing);
    await f.consumer.poll();
    await vi.waitFor(() => expect(f.api.files).toHaveBeenCalledOnce());
    const runs = createRunsService({ registry: new RunRegistry(), store: new NullRunStore() });
    f.deps.stop.mockImplementationOnce((input, io) =>
      stopLinearSession({ runs, inbox: f.store, config: { grantsFor: (id) => grantsFor(id, {}) } }, input, io),
    );
    const stop = event();
    stop.key = "stop";
    stop.receivedAt = 150;
    stop.payload.action = "prompted";
    stop.payload.agentActivity = {
      id: "stop",
      agentSessionId: "s",
      userId: "alice",
      signal: "stop",
      content: { type: "prompt", body: "Stop" },
    };
    await f.store.accept(stop);
    await f.consumer.poll();
    await vi.waitFor(() => expect(f.inbox.complete).toHaveBeenCalledWith("stop", expect.any(String)));
    finishFiles();
    await f.consumer.settled();
    expect(f.deps.dispatch).not.toHaveBeenCalled();
    expect(f.deps.recover).not.toHaveBeenCalled();
    expect(f.deps.warn).not.toHaveBeenCalled();
    f.advance(200_000);
    const next = event();
    next.key = "new-request";
    next.receivedAt = 200_100;
    await f.store.accept(next);
    await f.consumer.poll();
    await f.consumer.settled();
    expect(f.deps.dispatch).toHaveBeenCalledOnce();
  });
  it("passes staged metadata and the configured byte budget into dispatch under the original message id", async () => {
    const f = fixture(1000);
    const ev = event();
    const url = "https://uploads.linear.app/org/archive";
    ev.payload.promptContext = `Inspect [data.zip](${url})`;
    vi.mocked(f.api.files).mockResolvedValue([
      { url, name: "data.zip", staged: { size: 100, type: "application/zip" } },
    ]);
    await f.store.accept(ev);
    await f.consumer.poll();
    await f.consumer.settled();
    expect(f.api.files).toHaveBeenCalledWith("s", "linear:org:alice", [url], false, 1000);
    expect(f.deps.dispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        staged: [{ url, name: "data.zip", size: 100, type: "application/zip", messageId: ev.key }],
      }),
      expect.objectContaining({ copyAttachment: expect.any(Function) }),
    );
  });
  it("consumes a managed child's creation without a second dispatch but accepts human follow-ups", async () => {
    const f = fixture();
    vi.mocked(f.api.session).mockResolvedValue({ id: "s", appUserId: "bot", creatorId: "bot", managedChild: true });
    const created = event();
    (created.payload.agentSession as Record<string, unknown>).creatorId = "bot";
    await f.store.accept(created);
    await f.consumer.poll();
    await f.consumer.settled();
    expect(f.deps.dispatch).not.toHaveBeenCalled();
    expect(f.api.activity).not.toHaveBeenCalled();
    const follow = event();
    follow.key = "follow";
    follow.payload.action = "prompted";
    follow.payload.agentActivity = {
      id: "prompt",
      agentSessionId: "s",
      userId: "alice",
      content: { type: "prompt", body: "Please continue" },
    };
    await f.store.accept(follow);
    await f.consumer.poll();
    await f.consumer.settled();
    expect(f.deps.dispatch).toHaveBeenCalledWith(
      expect.objectContaining({ userId: "linear:org:alice", text: "Please continue" }),
      expect.anything(),
    );
  });
  it("leaves access refusal to dispatch and never claims a denied file was read", async () => {
    const f = fixture();
    const ev = event();
    ev.payload.promptContext = "Read [file.txt](https://uploads.linear.app/org/file)";
    await f.store.accept(ev);
    vi.mocked(f.api.files).mockRejectedValue(new Error("linear_file_denied"));
    await f.consumer.poll();
    await f.consumer.settled();
    expect(f.deps.dispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        text: expect.stringContaining("Attachments not read: the requester could not access this session"),
      }),
      expect.anything(),
    );
    expect(f.inbox.complete).toHaveBeenCalledOnce();
  });
  it("loads private prompt files before beginning dispatch and retries a failed download without a begun marker", async () => {
    const f = fixture();
    const url = "https://uploads.linear.app/org/image";
    const ev = event();
    ev.payload.promptContext = `Describe ![screen.png](${url})`;
    await f.store.accept(ev);
    vi.mocked(f.api.files)
      .mockRejectedValueOnce(new Error("linear_file_unavailable"))
      .mockResolvedValueOnce([
        { url, name: "screen.png", image: { name: "screen.png", mediaType: "image/png", data: "cGl4ZWxz" } },
      ]);
    await f.consumer.poll();
    await f.consumer.settled();
    expect(f.inbox.begin).not.toHaveBeenCalled();
    expect(f.deps.dispatch).not.toHaveBeenCalled();
    f.advance(5000);
    await f.consumer.poll();
    await f.consumer.settled();
    expect(f.api.files).toHaveBeenCalledWith("s", "linear:org:alice", [url], false, undefined);
    expect(f.deps.dispatch).toHaveBeenCalledWith(
      expect.objectContaining({ images: [{ name: "screen.png", mediaType: "image/png", data: "cGl4ZWxz" }] }),
      expect.anything(),
    );
    expect(f.inbox.complete).toHaveBeenCalledOnce();
  });
  it("retries an explicitly deferred turn as its own requester instead of treating it as interrupted", async () => {
    const f = fixture();
    await f.store.accept(event());
    f.deps.dispatch.mockResolvedValueOnce({ deferred: true });
    await f.consumer.poll();
    await f.consumer.settled();
    expect(f.inbox.defer).toHaveBeenCalledOnce();
    expect(f.inbox.complete).not.toHaveBeenCalled();
    f.advance(5000);
    await f.consumer.poll();
    await f.consumer.settled();
    expect(f.deps.dispatch).toHaveBeenCalledTimes(2);
    expect(f.deps.recover).not.toHaveBeenCalled();
    expect(f.inbox.complete).toHaveBeenCalledOnce();
  });
  it("holds already claimed later prompts after deferral while stop bypasses the admission wait", async () => {
    const f = fixture();
    let decide!: () => void;
    f.deps.dispatch.mockImplementationOnce(async () => {
      await new Promise<void>((resolve) => {
        decide = resolve;
      });
      return { deferred: true };
    });
    const prompt = (id: string, signal?: string): LinearWebhookEvent => ({
      ...event(),
      key: id,
      payload: {
        ...event().payload,
        action: "prompted",
        agentActivity: { id, agentSessionId: "s", userId: "alice", signal, content: { type: "prompt", body: id } },
      },
    });
    await f.store.accept(event());
    await f.consumer.poll();
    await vi.waitFor(() => expect(f.deps.dispatch).toHaveBeenCalledOnce());
    await f.store.accept(prompt("later"));
    await f.consumer.poll();
    await f.store.accept(prompt("stop", "stop"));
    await f.consumer.poll();
    await vi.waitFor(() => expect(f.deps.stop).toHaveBeenCalledOnce());
    expect(f.deps.dispatch).toHaveBeenCalledOnce();
    decide();
    await f.consumer.settled();
    expect(f.inbox.retry).toHaveBeenCalledWith("later", expect.any(String));
    expect(f.inbox.complete).toHaveBeenCalledTimes(1);
    f.advance(5000);
    await f.consumer.poll();
    await f.consumer.settled();
    await f.consumer.poll();
    await f.consumer.settled();
    expect(f.deps.dispatch.mock.calls.map(([msg]) => msg.text)).toEqual(["Fix login", "Fix login", "later"]);
    expect(f.deps.recover).not.toHaveBeenCalled();
  });
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
