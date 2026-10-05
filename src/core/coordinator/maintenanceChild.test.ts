import { describe, expect, it, vi } from "vitest";
import { dispatchMaintenanceChild, type MaintenanceChildDeps } from "./maintenanceChild.js";
import type { CoordinatorInstance, CoordinatorUnit } from "./contract.js";
import type { ChannelIO, IncomingMessage } from "../types.js";
import { InMemoryPrivateWorkerLog, privateWorkerThreadKey } from "../privateWorkerLog.js";
import { appendPrivateWorkerInput } from "../../channels/privateWorker.js";

const now = 60_100,
  head = "a".repeat(40),
  maintenanceId = `m_${"b".repeat(64)}`;
function fixture(agent: "coding" | "review" = "coding") {
  const instance: CoordinatorInstance = {
    id: "original_ship",
    kind: "ship",
    userId: "slack:UX",
    authenticatedAs: "cli:bound",
    postedBy: "slack:APP",
    channelId: "slack:CX",
    threadKey: "slack:CX:1.0",
    repo: "acme/api",
    branch: "fix/owned",
    base: "main",
    createdAt: 1,
    attempt: 2,
  };
  const unit: CoordinatorUnit = {
    instanceId: instance.id,
    unit: "ONE",
    slug: "owned",
    branch: instance.branch,
    dependsOn: [],
    rounds: [],
    threadKey: "slack:CX:2.0",
    reviewThread: { threadKey: "slack:CX:3.0" },
    pr: { number: 7, url: "https://github.com/acme/api/pull/7" },
    publication: {
      repo: instance.repo,
      pr: 7,
      headRef: instance.branch,
      publicationRef: instance.branch,
      baseRef: "main",
      expectedHeadSha: head,
      owner: { instanceId: instance.id, unit: "ONE" },
    },
    currentEffect: {
      version: 1,
      id: "original-effect",
      ordinal: 3,
      phase: "active",
      execution: {
        maintenance: {
          id: maintenanceId,
          admittedAt: 100,
          bounds: { leaseMinutes: 15, spendCapUsd: 5 },
          intent: {
            kind: "watch",
            eventId: "github:event",
            instanceId: instance.id,
            unit: "ONE",
            requester: instance.userId,
          },
        },
      },
      target: { repo: instance.repo, pr: 7, ref: instance.branch, base: "main", headSha: head },
      calls:
        agent === "coding"
          ? [{ operation: "spawn", agent, state: "pending" }]
          : [
              { operation: "rebase_push", state: "accepted", commitSha: head },
              { operation: "spawn", state: "pending" },
            ],
    },
  };
  const request = {
    channelId: instance.channelId,
    userId: instance.userId,
    threadKey: agent === "review" ? unit.reviewThread!.threadKey : unit.threadKey!,
    text: "Original private child prompt",
  };
  const io: ChannelIO = {
    reply: vi.fn(async () => {}),
    history: async () => [],
    status: async () => ({ update: async () => {}, done: async () => {} }),
  };
  const release = vi.fn();
  const dispatch = vi.fn<MaintenanceChildDeps["dispatch"]>(async (_msg, channel) => {
    channel.runStarted?.({ id: "actual-native-run" });
    return { status: "completed" };
  });
  const deps: MaintenanceChildDeps = {
    dispatch,
    ioFor: vi.fn(() => io),
    now: () => now,
    childAdmission: { enter: vi.fn(() => release) },
    readOwner: async () => structuredClone({ instance, unit }),
  };
  return { owner: { instance, unit }, request, io, deps, dispatch, release };
}

describe("original maintenance child admission", () => {
  it.each(["coding", "review"] as const)(
    "native callback retains exact %s owner, conversation, lease and cost cap",
    async (agent) => {
      const h = fixture(agent);
      const result = await dispatchMaintenanceChild(h.owner, h.request, agent, h.deps);
      expect(result).toEqual({ state: "accepted", runId: "actual-native-run" });
      const [msg, , options] = h.dispatch.mock.calls[0]!;
      expect(msg).toMatchObject({
        userId: h.owner.instance.userId,
        channelId: h.owner.instance.channelId,
        threadKey: agent === "coding" ? h.owner.unit.threadKey : h.owner.unit.reviewThread!.threadKey,
        authenticatedAs: "cli:bound",
        postedBy: "slack:APP",
      });
      expect(msg.text).toContain("budget:14");
      expect(options.parentDeadlineAt).toBe(15 * 60_000 + 100);
      expect(options.coordinator).toEqual({
        parentInstanceId: "original_ship",
        unit: "ONE",
        instanceAttempt: 2,
        idempotencyKey: "original_ship:original-effect",
        branch: "fix/owned",
        base: "main",
        publication: h.owner.unit.publication,
        maintenanceActionId: maintenanceId,
        costCapUsd: 5,
      });
      expect(h.release).toHaveBeenCalledTimes(1);
    },
  );

  it("a fractional lease bounds the actual dispatcher with exact remaining milliseconds and integer prose", async () => {
    const h = fixture();
    h.deps.now = () => now + 1_234;
    expect(await dispatchMaintenanceChild(h.owner, h.request, "coding", h.deps)).toMatchObject({ state: "accepted" });
    const [msg, , options] = h.dispatch.mock.calls[0]!;
    expect(msg.text).toContain("budget:13");
    expect(msg.text).not.toContain("budget:13.");
    expect(options.parentRemainingMs).toBe(14 * 60_000 - 1_234);
    expect(options.parentDeadlineAt).toBe(15 * 60_000 + 100);
    expect(options.parent).toBeUndefined();
  });

  it.each(["coding", "review"] as const)(
    "retargeted maintenance sends the frozen base to its %s child without changing original custody",
    async (agent) => {
      const h = fixture(agent);
      h.owner.unit.currentEffect!.target.base = "release";
      h.owner.unit.publication!.baseRef = "release";
      h.owner.unit.ending = {
        kind: "aborted",
        report: "Original private report",
        at: 2,
        outcome: { schemaVersion: 1, kind: "aborted", reviewRounds: 0 },
      };
      const original = structuredClone(h.owner);
      expect(await dispatchMaintenanceChild(h.owner, h.request, agent, h.deps)).toEqual({
        state: "accepted",
        runId: "actual-native-run",
      });
      const [msg, , options] = h.dispatch.mock.calls[0]!;
      expect(options.coordinator).toMatchObject({ base: "release", publication: original.unit.publication });
      expect(options.parentDeadlineAt).toBe(15 * 60_000 + 100);
      expect(msg).toMatchObject({
        userId: original.instance.userId,
        authenticatedAs: original.instance.authenticatedAs,
        postedBy: original.instance.postedBy,
      });
      expect(h.owner).toEqual(original);
      expect(h.owner.instance.base).toBe("main");
    },
  );

  it("ordinary Workflow children still refuse a base that differs from the historical instance", async () => {
    const h = fixture();
    h.owner.unit.currentEffect!.execution = { workflowId: h.owner.instance.id };
    h.owner.unit.currentEffect!.target.base = "release";
    h.owner.unit.publication!.baseRef = "release";
    expect(await dispatchMaintenanceChild(h.owner, h.request, "coding", h.deps)).toEqual({ state: "uncertain" });
    expect(h.dispatch).not.toHaveBeenCalled();
  });

  it("remaining lease below the dispatch boundary minimum never starts paid work", async () => {
    const h = fixture();
    h.deps.now = () => 15 * 60_000 + 100 - 119_999;
    expect(await dispatchMaintenanceChild(h.owner, h.request, "coding", h.deps)).toEqual({
      state: "refused",
      cause: "external_refused",
    });
    expect(h.dispatch).not.toHaveBeenCalled();
  });

  it.each(["channelId", "userId", "threadKey"] as const)(
    "a different frozen %s never dispatches the original child",
    async (field) => {
      const h = fixture();
      h.request[field] = "http:other";
      await dispatchMaintenanceChild(h.owner, h.request, "coding", h.deps);
      expect(h.dispatch).not.toHaveBeenCalled();
    },
  );

  it.each(["stop", "requester", "thread", "effect", "publication-base", "effect-base"] as const)(
    "fresh %s after audience awaits refuses before paid dispatch",
    async (change) => {
      const h = fixture();
      h.deps.ioFor = () => {
        if (change === "stop") h.owner.instance.stop = { at: now };
        if (change === "requester") h.owner.instance.userId = "slack:OTHER";
        if (change === "thread") h.owner.unit.threadKey = "slack:CX:other";
        if (change === "effect") h.owner.unit.currentEffect!.id = "new-effect";
        if (change === "publication-base") h.owner.unit.publication!.baseRef = "release";
        if (change === "effect-base") h.owner.unit.currentEffect!.target.base = "release";
        return h.io;
      };
      await dispatchMaintenanceChild(h.owner, h.request, "coding", h.deps);
      expect(h.dispatch).not.toHaveBeenCalled();
      expect(h.deps.childAdmission.enter).not.toHaveBeenCalled();
    },
  );

  it("private input is saved once before its verifier reads it, with stable original effect identity", async () => {
    const h = fixture();
    h.owner.unit.currentEffect!.target.base = "release";
    h.owner.unit.publication!.baseRef = "release";
    const identity = { instanceId: h.owner.instance.id, unit: h.owner.unit.unit };
    h.owner.unit.threadKey = privateWorkerThreadKey(identity);
    h.request.threadKey = h.owner.unit.threadKey;
    h.owner.unit.workBrief = {
      requesterId: h.owner.instance.userId,
      mainThreadKey: "slack:DM:1.0",
      actId: "original-act",
      repo: "acme/api",
      base: "main",
      question: "private question",
      requestedChange: "private change",
      findings: [],
    };
    const log = new InMemoryPrivateWorkerLog();
    h.deps.privateWorkerLog = log;
    h.deps.appendPrivateInput = appendPrivateWorkerInput;
    h.deps.ioFor = vi.fn((_thread, msg) => {
      expect(msg?.messageId).toBe("original_ship:original-effect");
      return {
        ...h.io,
        verifyPrivateWorkerAudience: async (request: IncomingMessage) => {
          const rows = await log.list(privateWorkerThreadKey(identity));
          return rows.some((row) => row.kind === "input" && row.id === request.messageId)
            ? { ok: true as const }
            : { ok: false as const, code: "requester-or-channel-mismatch" as const };
        },
      };
    });
    expect(await dispatchMaintenanceChild(h.owner, h.request, "coding", h.deps)).toMatchObject({ state: "accepted" });
    const rows = await log.list(privateWorkerThreadKey(identity));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      kind: "input",
      id: "original_ship:original-effect",
      sender: h.owner.instance.userId,
    });
    expect(h.dispatch.mock.calls[0]![2].coordinator).toMatchObject({ base: "release" });
    expect(h.owner.instance.base).toBe("main");
    expect(h.owner.unit.workBrief.base).toBe("main");
  });

  it.each(["missing-log", "lost-append", "denied"] as const)(
    "private %s never starts a child or deletes saved input",
    async (mode) => {
      const h = fixture();
      const identity = { instanceId: h.owner.instance.id, unit: h.owner.unit.unit };
      h.owner.unit.threadKey = privateWorkerThreadKey(identity);
      h.request.threadKey = h.owner.unit.threadKey;
      h.owner.unit.workBrief = {
        requesterId: h.owner.instance.userId,
        mainThreadKey: "slack:DM:1.0",
        actId: "original-act",
        repo: "acme/api",
        base: "main",
        question: "private question",
        requestedChange: "private change",
        findings: [],
      };
      const log = new InMemoryPrivateWorkerLog();
      if (mode !== "missing-log") h.deps.privateWorkerLog = log;
      h.deps.appendPrivateInput = async (...args) => {
        await appendPrivateWorkerInput(...args);
        if (mode === "lost-append") throw new Error("private append ACK lost");
      };
      h.io.verifyPrivateWorkerAudience = async () =>
        mode === "denied" ? { ok: false, code: "requester-or-channel-mismatch" } : { ok: true };
      expect(await dispatchMaintenanceChild(h.owner, h.request, "coding", h.deps)).toEqual(
        mode === "lost-append" ? { state: "uncertain" } : { state: "refused", cause: "external_refused" },
      );
      expect(h.dispatch).not.toHaveBeenCalled();
      expect(await log.list(privateWorkerThreadKey(identity))).toHaveLength(mode === "missing-log" ? 0 : 1);
    },
  );

  it.each(["settled", "unstarted", "wrong-owner"] as const)("%s cell evidence cannot start a child", async (mode) => {
    const h = fixture();
    if (mode === "settled") h.owner.unit.currentEffect!.phase = "settled";
    if (mode === "unstarted")
      h.owner.unit.currentEffect!.calls = [{ operation: "spawn", agent: "coding", state: "unstarted" }];
    if (mode === "wrong-owner") h.owner.unit.publication!.owner.unit = "OTHER";
    await dispatchMaintenanceChild(h.owner, h.request, "coding", h.deps);
    expect(h.dispatch).not.toHaveBeenCalled();
  });

  it.each(["void", "complete", "throw", "reject", "invalid-callback"] as const)(
    "dispatch %s without a positive native callback stays uncertain and releases once",
    async (mode) => {
      const h = fixture();
      h.deps.dispatch = (_msg, io) => {
        if (mode === "throw") throw new Error("private dispatch detail");
        if (mode === "invalid-callback") io.runStarted?.({ id: undefined as unknown as string });
        return mode === "reject"
          ? Promise.reject(new Error("private dispatch detail"))
          : Promise.resolve(mode === "void" ? (undefined as never) : { status: "completed" as const });
      };
      expect(await dispatchMaintenanceChild(h.owner, h.request, "coding", h.deps)).toEqual({ state: "uncertain" });
      expect(h.release).toHaveBeenCalledTimes(1);
    },
  );

  it("actual callback resolves admission before background completion and preserves bound adapter methods", async () => {
    const h = fixture();
    let finish!: () => void;
    const background = new Promise<void>((resolve) => {
      finish = resolve;
    });
    class IO {
      calls: string[] = [];
      async reply(text: string) {
        this.calls.push(text);
      }
      async history() {
        return [];
      }
      async status() {
        return { update: async () => {}, done: async () => {} };
      }
      runStarted(started: { id: string }) {
        this.calls.push(started.id);
      }
    }
    const io = new IO();
    h.deps.ioFor = () => io;
    h.deps.dispatch = async (_msg, watched) => {
      await watched.reply("bound callback");
      watched.runStarted?.({ id: "actual-native-run" });
      watched.runStarted?.({ id: "different-run" });
      await background;
      throw new Error("later child failure");
    };
    expect(await dispatchMaintenanceChild(h.owner, h.request, "coding", h.deps)).toEqual({
      state: "accepted",
      runId: "actual-native-run",
    });
    expect(io.calls).toEqual(["bound callback", "actual-native-run"]);
    expect(h.release).toHaveBeenCalledTimes(1);
    finish();
    await Promise.resolve();
    expect(h.release).toHaveBeenCalledTimes(1);
  });

  it.each(["missing-io", "expired", "draining", "stopped"] as const)(
    "%s prevents native child dispatch",
    async (mode) => {
      const h = fixture();
      if (mode === "missing-io") h.deps.ioFor = () => undefined;
      if (mode === "expired") h.deps.now = () => 20 * 60_000;
      if (mode === "draining") h.deps.childAdmission.enter = () => undefined;
      if (mode === "stopped") h.owner.instance.stop = { at: now };
      expect(await dispatchMaintenanceChild(h.owner, h.request, "coding", h.deps)).toEqual({
        state: "refused",
        cause: "external_refused",
      });
      expect(h.dispatch).not.toHaveBeenCalled();
    },
  );

  it("DM stamps require exact requester provenance and fresh verifier success; a lease spent during verification refuses", async () => {
    const h = fixture();
    delete h.owner.instance.authenticatedAs;
    delete h.owner.instance.postedBy;
    h.owner.instance.channelId = "slack:DM";
    h.owner.unit.threadKey = "slack:DM:2.0";
    h.request.channelId = h.owner.instance.channelId;
    h.request.threadKey = h.owner.unit.threadKey;
    let at = now;
    h.deps.now = () => at;
    h.io.directAudience = () => ({ channelId: "slack:DM", userId: "slack:UX", threadKey: "slack:DM:2.0" });
    h.io.verifyDirectAudience = vi.fn(async () => {
      at = 20 * 60_000;
      return { ok: true as const };
    });
    expect(await dispatchMaintenanceChild(h.owner, h.request, "coding", h.deps)).toEqual({
      state: "refused",
      cause: "external_refused",
    });
    expect(h.io.verifyDirectAudience).toHaveBeenCalledOnce();
    expect(h.dispatch).not.toHaveBeenCalled();
    at = now;
    h.io.verifyDirectAudience = vi.fn(async () => ({ ok: true as const }));
    expect(await dispatchMaintenanceChild(h.owner, h.request, "coding", h.deps)).toMatchObject({ state: "accepted" });
    expect(h.dispatch.mock.calls[0]![0].directAudience).toEqual({
      kind: "slack-unshared-im",
      channelId: "slack:DM",
      userId: "slack:UX",
      threadKey: "slack:DM:2.0",
    });
  });
});
