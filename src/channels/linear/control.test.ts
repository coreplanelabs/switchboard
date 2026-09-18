import { describe, expect, it, vi } from "vitest";
import { stopLinearSession } from "./control.js";
import { RunRegistry } from "../../core/runRegistry.js";
import { createRunsService } from "../../core/runsService.js";
import { ALL_GRANTS, grantsFor } from "../../core/authz/grants.js";
import { NO_GRANTS } from "../../core/authz/types.js";
import { assembleRunRecord } from "../../core/dispatch/record.js";
import { analyzeRunFriction } from "../../core/runFriction.js";
import { InMemoryRunStore, NullRunStore } from "../../core/runStore.js";
import { nullChannelIO } from "../../core/nullChannelIo.js";

describe("Linear stop authorization", () => {
  it("cancels only the authorized current question and never closes a newer or another person's session", async () => {
    const registry = new RunRegistry({ now: () => 150 });
    const store = new InMemoryRunStore({ now: () => 150 });
    await store.put(
      assembleRunRecord({
        run: { id: "question" },
        snap: null,
        msg: { channelId: "linear:org:team", userId: "linear:org:alice", threadKey: "linear:org:s" },
        channelVisibility: "private",
        finishedAt: 100,
        status: "completed",
        awaitingInput: true,
        diagnosis: analyzeRunFriction([]),
      }),
    );
    const runs = createRunsService({ registry, store });
    const deps = { runs, config: { grantsFor: (id: string) => grantsFor(id, {}) } };
    const input = {
      kind: "stop" as const,
      threadKey: "linear:org:s",
      channelId: "linear:org:team",
      userId: "linear:org:alice",
      receivedAt: 101,
    };
    const io = { ...nullChannelIO("test"), reply: vi.fn(async () => {}), status: vi.fn() };
    await stopLinearSession(deps, { ...input, userId: "linear:org:bob" }, io);
    await stopLinearSession(deps, { ...input, receivedAt: 99 }, io);
    expect(io.reply).not.toHaveBeenCalled();
    expect(io.status).not.toHaveBeenCalled();
    await stopLinearSession(deps, input, io);
    expect(io.reply).toHaveBeenCalledExactlyOnceWith(
      "Stopped waiting for input. Send a new prompt when you want to continue.",
    );
    expect(await store.get("question")).toMatchObject({ status: "stopped_hard", inputStop: { at: 101 } });
    expect((await store.get("question"))?.awaitingInput).toBeUndefined();
    // Replaying the same delivery after a process restart can finish native delivery.
    const restarted = createRunsService({ registry: new RunRegistry(), store });
    await stopLinearSession({ ...deps, runs: restarted }, input, io);
    expect(io.reply).toHaveBeenCalledTimes(2);
    io.reply.mockClear();
    registry.create(undefined, { threadKey: input.threadKey, channelId: input.channelId, userId: "linear:org:bob" });
    await stopLinearSession(deps, { ...input, receivedAt: 151 }, io);
    expect(io.reply).not.toHaveBeenCalled();
    expect(io.status).not.toHaveBeenCalled();
  });
  it("retries a failed durable stop without closing the native question", async () => {
    const store = new InMemoryRunStore({ now: () => 150 });
    await store.put(
      assembleRunRecord({
        run: { id: "question" },
        snap: null,
        msg: { channelId: "linear:org:team", userId: "linear:org:alice", threadKey: "linear:org:s" },
        channelVisibility: "private",
        finishedAt: 100,
        status: "completed",
        awaitingInput: true,
        diagnosis: analyzeRunFriction([]),
      }),
    );
    vi.spyOn(store, "stopWaiting").mockRejectedValueOnce(new Error("offline"));
    const runs = createRunsService({ registry: new RunRegistry(), store });
    const io = { ...nullChannelIO("test"), reply: vi.fn(async () => {}) };
    await expect(
      stopLinearSession(
        { runs, config: { grantsFor: (id) => grantsFor(id, {}) } },
        {
          kind: "stop",
          userId: "linear:org:alice",
          channelId: "linear:org:team",
          threadKey: "linear:org:s",
          receivedAt: 101,
        },
        io,
      ),
    ).rejects.toThrow("offline");
    expect(io.reply).not.toHaveBeenCalled();
    expect((await store.get("question"))?.awaitingInput).toBe(true);
  });
  it("does not emit a lifecycle-changing reply for denied or empty stops, and retries unavailable history", async () => {
    const store = new InMemoryRunStore({ now: () => 150 });
    const runs = createRunsService({ registry: new RunRegistry(), store, warn: () => {} });
    const deps = { runs, config: { grantsFor: (id: string) => grantsFor(id, {}) } };
    const input = {
      kind: "stop" as const,
      threadKey: "linear:org:s",
      channelId: "linear:org:team",
      userId: "linear:org:alice",
      receivedAt: 100,
    };
    const io = { ...nullChannelIO("test"), reply: vi.fn(async () => {}), status: vi.fn() };
    await stopLinearSession(deps, input, io);
    expect(io.reply).not.toHaveBeenCalled();
    expect(io.status).not.toHaveBeenCalled();
    vi.spyOn(store, "list").mockRejectedValueOnce(new Error("offline"));
    await expect(stopLinearSession(deps, input, io)).rejects.toThrow("linear_stop_unavailable");
    expect(io.reply).not.toHaveBeenCalled();
  });
  it("lets a person stop their own session without operator or team-wide grants, but not another person's work", async () => {
    const registry = new RunRegistry({ now: () => 100 });
    const own = registry.create(undefined, {
      threadKey: "linear:org:s",
      channelId: "linear:org:team",
      userId: "linear:org:alice",
    });
    const other = registry.create(undefined, {
      threadKey: "linear:org:s",
      channelId: "linear:org:team",
      userId: "linear:org:bob",
    });
    const runs = createRunsService({ registry, store: new NullRunStore() });
    await stopLinearSession(
      { runs, config: { grantsFor: (id) => grantsFor(id, {}) } },
      {
        kind: "stop",
        threadKey: "linear:org:s",
        channelId: "linear:org:team",
        userId: "linear:org:alice",
        receivedAt: 101,
      },
      nullChannelIO("test"),
    );
    expect(own.control.requested).toBe("hard");
    expect(other.control.requested).toBeUndefined();
  });
  it("requires the policy's write permission and scopes control to the signed session and arrival", async () => {
    const registry = new RunRegistry({ now: () => 100 });
    const run = registry.create(undefined, {
      threadKey: "linear:org:s",
      channelId: "linear:org:team",
      userId: "linear:org:alice",
    });
    const other = registry.create(undefined, {
      threadKey: "linear:org:other",
      channelId: "linear:org:team",
      userId: "linear:org:alice",
    });
    const runs = createRunsService({ registry, store: new NullRunStore() });
    const input = {
      kind: "stop" as const,
      threadKey: "linear:org:s",
      channelId: "linear:org:team",
      userId: "linear:org:alice",
      receivedAt: 101,
    };
    const io = { ...nullChannelIO("test"), reply: vi.fn(async () => {}) };
    await stopLinearSession({ runs, config: { grantsFor: () => NO_GRANTS } }, input, io);
    expect(run.control.requested).toBeUndefined();
    await stopLinearSession({ runs, config: { grantsFor: () => ALL_GRANTS } }, { ...input, receivedAt: 99 }, io);
    expect(run.control.requested).toBeUndefined();
    await stopLinearSession({ runs, config: { grantsFor: () => ALL_GRANTS } }, input, io);
    expect(run.control.requested).toBe("hard");
    expect(other.control.requested).toBeUndefined();
  });
});
