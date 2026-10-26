import type { IncomingMessage as HttpRequest, ServerResponse } from "node:http";
import { Secret } from "../../secrets.js";
import { handleAdminTraceLog, TRACE_LOG_PATH } from "../../channels/adminTraceLog.js";
import { NO_GRANTS } from "../authz/types.js";
import { classifyError } from "../trace/classify.js";
import { logOwnerFailure, type OrganizationOwnerFailure } from "./ownerFailure.js";
import { createSpanLog } from "../trace/spanLog.js";
import { analyzeRunFriction } from "../runFriction.js";
import { describe, expect, it, vi } from "vitest";
import { InMemoryRunLedger } from "../runLedger/inMemory.js";
import { InMemoryOrganizationStore } from "./memory.js";
import { OrganizationService } from "./service.js";
import { createOrganizationRuntime, type OrganizationExecutionRequest } from "./runtime.js";
import type { Actor } from "../authz/types.js";
import type { OrganizationEnvelope } from "./contract.js";
import type { ChannelIO } from "../types.js";
const reference = {
  actorId: "http:credential",
  userId: "http:alice",
  authenticatedAs: "http:credential",
  channelId: "http:home",
  threadKey: "http:home:alice",
};
const actor: Actor = {
  id: reference.actorId,
  kind: "user",
  grants: { actions: new Set(["agent:run:general"]), channels: new Set(["http:home"]), repos: new Set() },
  self: [reference.actorId, reference.userId],
};
function setup(authorize = async () => true, clock = () => 1) {
  const store = new InMemoryOrganizationStore(clock);
  const ledger = new InMemoryRunLedger(clock);
  const service = new OrganizationService({
    store,
    directory: store.directory,
    mappings: [{ source: "http", issuer: "http:test", tenant: null, organization: "org:test" }],
    authorize,
    currentIdentityRead: async (source) => (source.issuer === "http:test" ? "allowed" : "denied"),
    limits: {
      pendingPerActor: 10,
      pendingPerSource: 10,
      pendingPerOrganization: 20,
      reservedReconciliation: 1,
      contentTtlMs: 90,
      receiptTtlMs: 365,
    },
  });
  const tasks: (() => Promise<void>)[] = [];
  const effects: { actor: string; userId: string; thread: string; text: string; runId: string; kind: string }[] = [];
  const options = {
    store,
    ledger,
    service,
    owner: "process",
    leaseMs: 30,
    batchSize: 10,
    contentTtlMs: 90,
    resolveActor: async (_envelope: OrganizationEnvelope) => ({
      actor,
      msg: { ...reference, text: "", userId: reference.userId },
    }),
    sink: (): ChannelIO => ({
      reply: async () => {},
      status: async () => ({ update() {}, done: async () => {} }),
      history: async () => [],
    }),
    dispatchOwned: async (request: OrganizationExecutionRequest) => {
      effects.push({
        actor: request.actor.id,
        userId: request.msg.userId,
        thread: request.msg.threadKey,
        text: request.msg.text,
        runId: request.runId,
        kind: "message",
      });
      return { status: "completed" as const };
    },
    launch: (task: () => Promise<void>) => tasks.push(task),
  };
  const runtime = createOrganizationRuntime(options);
  const authentication = {
    source: "http" as const,
    identity: { issuer: "http:test", tenant: null, subject: "credential" },
    kind: "human" as const,
    organizations: ["org:test"],
    sourceReference: reference,
  };
  const send = (
    key: string,
    continuation?: OrganizationEnvelope["continuation"],
    target: OrganizationEnvelope["target"] = null,
  ) =>
    service.admit(
      {
        source: "http",
        identity: { issuer: "http:test", tenant: null, subject: "credential" },
        kind: "human",
        organizations: ["org:test"],
        sourceReference: reference,
      },
      {
        sourceEvent: key,
        key,
        content: continuation ? "" : "Start original work",
        workload: continuation || target ? "act" : "message",
        destination: { kind: "broad" },
        target,
        context: [],
        ...(continuation ? { continuation } : {}),
      },
    );
  return { ...options, runtime, send, tasks, effects, authentication };
}
describe("organization runtime", () => {
  describe("owner failure diagnostics", () => {
    it("reports a failed launch write when readback has no launch receipt", async () => {
      const s = setup();
      const reports: OrganizationOwnerFailure[] = [];
      const runtime = createOrganizationRuntime({
        ...s,
        reportOwnerFailure: (failure) => {
          reports.push(failure);
        },
      });
      const admitted = await s.send("launch-write-failed");
      if (admitted.status !== "receipt" || !admitted.receipt.effectKey) throw new Error("not admitted");
      s.ledger.launchIngress = async () => {
        throw classifyError(new Error("private launch detail"), { kind: "transport" });
      };
      await runtime.reconcile("org:test");
      await s.tasks.shift()!();
      const original = await s.ledger.readIngress(admitted.receipt.effectKey);
      if (original.status !== "record") throw new Error("original owner missing");
      expect(reports).toEqual([
        {
          runId: original.record.runId,
          receiptId: admitted.receipt.id,
          requestDigest: admitted.receipt.digest,
          branch: "dispatch",
          failure: { stage: "launch", kind: "transport" },
        },
      ]);
      expect(JSON.stringify(reports)).not.toContain("private launch detail");
      expect(original.record).toMatchObject({ status: "uncertain", ownerStage: "launch" });
      expect(original.record).not.toHaveProperty("launch");
      expect(s.effects).toEqual([]);
    });
    it("keeps safe failure output readable through the authorized trace reader before an agent run exists", async () => {
      const s = setup();
      const log = createSpanLog();
      const runtime = createOrganizationRuntime({
        ...s,
        reportOwnerFailure: (report) =>
          logOwnerFailure({ spanLog: log, clock: () => 7, buildCommit: "a".repeat(40) }, report),
        dispatchOwned: async () => {
          throw classifyError(new Error("private source body"), {
            kind: "refused",
            code: "history_producer_unavailable",
          });
        },
      });
      const admitted = await s.send("trace-output");
      if (admitted.status !== "receipt") throw new Error("not admitted");
      await runtime.reconcile("org:test");
      await s.tasks.shift()!();
      const original = await s.ledger.readIngress(admitted.receipt.effectKey!);
      if (original.status !== "record") throw new Error("missing owner");
      expect(log.read({ runId: original.record.runId }).lines).toMatchObject([
        {
          span: "organization.owner_failure",
          status: "error",
          errorKind: "refused",
          errorCode: "history_producer_unavailable",
          attrs: {
            runId: original.record.runId,
            organizationReceiptId: admitted.receipt.id,
            requestDigest: original.record.digest,
            ownerStage: "execute",
            ownerBranch: "dispatch",
            buildCommit: "a".repeat(40),
          },
        },
      ]);
      const tokens = new Secret(
        JSON.stringify({ "fixture-reader": { subject: "reader" } }),
        "SWITCHBOARD_INGRESS_TOKENS",
      );
      for (const allowed of [false, true]) {
        let status = 0,
          body = "";
        handleAdminTraceLog(
          {
            method: "GET",
            url: `${TRACE_LOG_PATH}?runId=${original.record.runId}&span=organization.owner_failure`,
            headers: { authorization: "Bearer fixture-reader" },
          } as HttpRequest,
          {
            writeHead: (value: number) => {
              status = value;
            },
            end: (value: string) => {
              body = value;
            },
          } as unknown as ServerResponse,
          {
            tokens,
            spanLog: log,
            grantsFor: () =>
              allowed ? { actions: new Set(["trace:read"]), channels: new Set(), repos: new Set() } : NO_GRANTS,
            log: () => {},
          },
        );
        expect(status).toBe(allowed ? 200 : 403);
        if (allowed)
          expect(JSON.parse(body)).toMatchObject({
            ok: true,
            matched: 1,
            lines: [
              {
                span: "organization.owner_failure",
                errorCode: "history_producer_unavailable",
                attrs: {
                  runId: original.record.runId,
                  organizationReceiptId: admitted.receipt.id,
                  ownerStage: "execute",
                },
              },
            ],
          });
        else expect(JSON.parse(body)).toMatchObject({ ok: false });
        expect(body).not.toContain("private source body");
      }
      expect(JSON.stringify(log.read())).not.toContain("private source body");
      expect(original.record).toMatchObject({
        status: "uncertain",
        outcome: "The original owner's outcome could not be confirmed.",
        handlerOutcome: "uncertain",
        ownerStage: "execute",
        failure: { stage: "execute", kind: "refused", code: "history_producer_unavailable" },
      });
    });

    it.each(["actor", "authorization", "execution-fence", "source-snapshot", "sink", "execute", "settlement"] as const)(
      "reports %s without exposing the exception or replaying the owner",
      async (stage) => {
        const s = setup();
        const reports: OrganizationOwnerFailure[] = [];
        let failing = false;
        const secret = classifyError(new Error("private body TOKEN=private-credential"), {
          kind: "transport",
          code: "private-arbitrary-code",
        });
        const runtime = createOrganizationRuntime({
          ...s,
          reportOwnerFailure: (report) => {
            reports.push(report);
          },
          resolveActor: async (envelope) => {
            if (failing && stage === "actor") throw secret;
            return s.resolveActor(envelope);
          },
          sink: () => {
            if (failing && stage === "sink") throw secret;
            return s.sink();
          },
          dispatchOwned: async (request) => {
            if (failing && stage === "execute") throw secret;
            return s.dispatchOwned(request);
          },
        });
        const admitted = await s.send("diagnostic-owner");
        if (admitted.status !== "receipt") throw new Error("not admitted");
        await runtime.reconcile("org:test");
        const original = await s.ledger.readIngress(admitted.receipt.effectKey!);
        if (original.status !== "record") throw new Error("missing owner");
        failing = true;
        if (stage === "authorization") vi.spyOn(s.service, "authorizeExecution").mockRejectedValueOnce(secret);
        if (stage === "execution-fence") vi.spyOn(s.store, "execute").mockRejectedValueOnce(secret);
        if (stage === "source-snapshot") vi.spyOn(s.ledger, "readIngress").mockRejectedValueOnce(secret);
        if (stage === "settlement") vi.spyOn(s.ledger, "finishIngress").mockRejectedValueOnce(secret);
        await s.tasks.shift()!();
        expect(reports).toEqual([
          {
            runId: original.record.runId,
            receiptId: admitted.receipt.id,
            requestDigest: original.record.digest,
            branch: "dispatch",
            failure: { stage, kind: "transport" },
          },
        ]);
        expect(await s.ledger.readIngress(admitted.receipt.effectKey!)).toMatchObject({
          status: "record",
          record: {
            runId: original.record.runId,
            status: "uncertain",
            outcome: "The original owner's outcome could not be confirmed.",
            handlerOutcome: "uncertain",
            ownerStage: stage,
            failure: { stage, kind: "transport" },
          },
        });
        expect(JSON.stringify(await s.ledger.readIngress(admitted.receipt.effectKey!))).not.toContain(
          "private-credential",
        );
        expect(s.effects).toEqual(
          stage === "settlement"
            ? [
                {
                  actor: "http:credential",
                  userId: "http:alice",
                  thread: "http:home:alice",
                  text: "Start original work",
                  runId: original.record.runId,
                  kind: "message",
                },
              ]
            : [],
        );
        failing = false;
        await runtime.reconcile("org:test");
        expect(s.tasks).toEqual([]);
        expect(s.effects).toHaveLength(stage === "settlement" ? 1 : 0);
      },
    );
    it("retains the first failure when uncertain settlement also throws", async () => {
      const s = setup();
      const reports: OrganizationOwnerFailure[] = [];
      const log = createSpanLog();
      const runtime = createOrganizationRuntime({
        ...s,
        reportOwnerFailure: (report) => {
          reports.push(structuredClone(report));
          logOwnerFailure({ spanLog: log, buildCommit: "unknown" }, report);
          report.failure.stage = "schedule";
          report.failure.code = "history_context_unavailable";
        },
        dispatchOwned: async () => {
          throw classifyError(new Error("private original"), {
            kind: "refused",
            code: "history_producer_unavailable",
          });
        },
      });
      const admitted = await s.send("double-failure");
      if (admitted.status !== "receipt") throw new Error("not admitted");
      await runtime.reconcile("org:test");
      vi.spyOn(s.ledger, "finishIngress").mockRejectedValueOnce(new Error("private settlement"));
      await expect(s.tasks.shift()!()).rejects.toThrow("private settlement");
      const original = await s.ledger.readIngress(admitted.receipt.effectKey!);
      if (original.status !== "record") throw new Error("missing owner");
      const identity = {
        runId: original.record.runId,
        receiptId: admitted.receipt.id,
        requestDigest: original.record.digest,
        branch: "dispatch",
      };
      expect(reports).toEqual([
        { ...identity, failure: { stage: "execute", kind: "refused", code: "history_producer_unavailable" } },
        {
          ...identity,
          failure: { stage: "uncertain-settlement", kind: "other" },
          firstFailure: { stage: "execute", kind: "refused", code: "history_producer_unavailable" },
        },
      ]);
      expect(log.read({ runId: original.record.runId }).lines).toMatchObject([
        { errorCode: "history_producer_unavailable", attrs: { ownerStage: "execute" } },
        {
          errorKind: "other",
          attrs: {
            ownerStage: "uncertain-settlement",
            firstOwnerStage: "execute",
            firstOwnerErrorKind: "refused",
            firstOwnerErrorCode: "history_producer_unavailable",
          },
        },
      ]);
      expect(original.record).toMatchObject({ status: "dispatching", outcome: null });
      await runtime.reconcile("org:test");
      expect(s.tasks).toEqual([]);
      expect(s.effects).toEqual([]);
    });
    it.each(["sync", "async", "span-log"] as const)(
      "a %s reporter failure cannot change settlement or replay",
      async (mode) => {
        const s = setup();
        const reports: OrganizationOwnerFailure[] = [];
        const runtime = createOrganizationRuntime({
          ...s,
          reportOwnerFailure: (report) => {
            reports.push(report);
            if (mode === "span-log") {
              const log = createSpanLog();
              vi.spyOn(log.sink, "onEnd").mockImplementation(() => {
                throw new Error("private sink failure");
              });
              logOwnerFailure({ spanLog: log, buildCommit: "unknown" }, report);
              return;
            }
            if (mode === "sync") throw new Error("logger failed");
            return Promise.reject(new Error("logger failed"));
          },
          dispatchOwned: async () => {
            throw new Error("private original");
          },
        });
        const admitted = await s.send("reporter-failure");
        if (admitted.status !== "receipt") throw new Error("not admitted");
        await runtime.reconcile("org:test");
        await s.tasks.shift()!();
        expect(await s.ledger.readIngress(admitted.receipt.effectKey!)).toMatchObject({
          status: "record",
          record: { status: "uncertain", outcome: "The original owner's outcome could not be confirmed." },
        });
        expect(reports).toMatchObject([{ branch: "dispatch", failure: { stage: "execute", kind: "other" } }]);
        await runtime.reconcile("org:test");
        expect(s.tasks).toEqual([]);
        expect(s.effects).toEqual([]);
      },
    );
    it.each(["dispatch", "answer", "confirm"] as const)(
      "reports the selected %s branch when scheduling fails",
      async (branch) => {
        const s = setup();
        const reports: OrganizationOwnerFailure[] = [];
        const target = branch === "answer" ? { key: "question", revision: 7 } : null;
        if (target)
          await s.store.execute({ action: "observe", organization: "org:test", target: target.key, revision: 7 });
        const continuation =
          branch === "confirm" ? { kind: "confirm" as const, id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" } : undefined;
        const runtime = createOrganizationRuntime({
          ...s,
          answerOwned: s.dispatchOwned,
          confirmOwned: s.dispatchOwned,
          reportOwnerFailure: (report) => {
            reports.push(report);
          },
          launch: () => {
            throw new Error("private scheduling failure");
          },
        });
        const admitted = await s.send("schedule-failure", continuation, target);
        if (admitted.status !== "receipt") throw new Error("not admitted");
        await runtime.reconcile("org:test");
        expect(await s.ledger.readIngress(admitted.receipt.effectKey!)).toMatchObject({
          status: "record",
          record: { status: "uncertain", outcome: "The original owner could not be scheduled." },
        });
        expect(reports).toMatchObject([{ branch, failure: { stage: "schedule", kind: "other" } }]);
        expect(s.effects).toEqual([]);
      },
    );
  });

  it("lets another source reconcile the next bounded batch while the first original model remains unfinished", async () => {
    const s = setup();
    const peer = { actorId: "mcp:peer", userId: "mcp:peer", channelId: "mcp:home", threadKey: "mcp:home:peer" };
    const service = new OrganizationService({
      store: s.store,
      directory: s.store.directory,
      mappings: [
        { source: "http", issuer: "http:test", tenant: null, organization: "org:test" },
        { source: "mcp", issuer: "mcp:test", tenant: null, organization: "org:test" },
      ],
      authorize: async () => true,
      limits: {
        pendingPerActor: 10,
        pendingPerSource: 10,
        pendingPerOrganization: 20,
        reservedReconciliation: 1,
        contentTtlMs: 90,
        receiptTtlMs: 365,
      },
    });
    expect(await s.send("alice-first")).toMatchObject({ status: "receipt", receipt: { status: "pending" } });
    expect(await s.send("alice-next")).toMatchObject({ status: "receipt", receipt: { status: "pending" } });
    expect(
      await service.admit(
        {
          source: "mcp",
          identity: { issuer: "mcp:test", tenant: null, subject: "peer" },
          kind: "service",
          organizations: ["org:test"],
          sourceReference: peer,
        },
        {
          sourceEvent: "peer-first",
          key: "peer-first",
          content: "Peer work",
          workload: "message",
          destination: { kind: "broad" },
          target: null,
          context: [],
        },
      ),
    ).toMatchObject({ status: "receipt", receipt: { status: "pending" } });
    let release!: () => void, firstStarted!: () => void, peerStarted!: () => void;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const first = new Promise<void>((resolve) => {
      firstStarted = resolve;
    });
    const second = new Promise<void>((resolve) => {
      peerStarted = resolve;
    });
    const started: string[] = [],
      finished: string[] = [],
      tasks: Promise<void>[] = [];
    const runtime = createOrganizationRuntime({
      ...s,
      service,
      batchSize: 1,
      resolveActor: async (envelope) =>
        envelope.source === "mcp"
          ? {
              actor: { id: "mcp:peer", kind: "service" as const, grants: actor.grants },
              msg: { ...peer, text: envelope.content },
            }
          : s.resolveActor(envelope),
      launch: (task) => {
        tasks.push(task());
      },
      dispatchOwned: async (request) => {
        started.push(request.msg.userId);
        if (request.envelope.source === "http") {
          firstStarted();
          await blocked;
        } else peerStarted();
        finished.push(request.msg.userId);
        return { status: "completed" };
      },
    });
    try {
      const batch = await runtime.reconcile("org:test");
      await first;
      expect(batch.status).toBe("state");
      expect((await runtime.reconcile("org:test")).status).toBe("state");
      await second;
      expect(started).toEqual(["http:alice", "mcp:peer"]);
      expect(finished).toEqual(["mcp:peer"]);
      expect(await s.store.execute({ action: "get", organization: "org:test" })).toMatchObject({
        status: "state",
        state: { lease: { generation: 2, expiresAt: 1 } },
      });
    } finally {
      release();
      await Promise.all(tasks);
    }
  });

  it("cannot release a replacement process lease after a finished batch loses its generation", async () => {
    let now = 1;
    const s = setup(
      async () => true,
      () => now,
    );
    await s.send("first-batch");
    await s.send("remaining-batch");
    const execute = s.store.execute.bind(s.store);
    s.store.execute = async (command) => {
      const result = await execute(command);
      if (command.action === "complete" && result.status === "busy") {
        now = 31;
        expect(
          await execute({ action: "claim", organization: "org:test", owner: "replacement", leaseMs: 30 }),
        ).toMatchObject({ status: "state", state: { lease: { generation: 2, owner: "replacement" } } });
      }
      return result;
    };
    const runtime = createOrganizationRuntime({ ...s, batchSize: 1 });
    expect(await runtime.reconcile("org:test")).toEqual({ status: "fenced" });
    expect(await execute({ action: "get", organization: "org:test" })).toMatchObject({
      status: "state",
      state: { lease: { owner: "replacement", generation: 2, expiresAt: 61 } },
    });
    expect(s.effects).toEqual([]);
  });

  it.each(["message", "answer", "confirm"] as const)(
    "keeps %s pending across unavailable directory effect checks and executes once after fresh proof",
    async (workload) => {
      const s = setup();
      const target = workload === "answer" ? { key: "recorded-question", revision: 7 } : null;
      const continuation =
        workload === "confirm" ? { kind: "confirm" as const, id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" } : undefined;
      if (target)
        await s.store.execute({ action: "observe", organization: "org:test", target: target.key, revision: 7 });
      const admitted = await s.send("held-admission", continuation, target);
      if (admitted.status !== "receipt") throw new Error("not admitted");
      const resolve = s.store.directory.resolve.bind(s.store.directory);
      s.store.directory.resolve = async () => ({ status: "unavailable" });
      const runtime = createOrganizationRuntime({ ...s, answerOwned: s.dispatchOwned, confirmOwned: s.dispatchOwned });
      await runtime.reconcile("org:test");
      s.store.directory.resolve = resolve;
      expect(await s.send("held-admission", continuation, target)).toMatchObject({
        status: "receipt",
        duplicate: true,
        receipt: { status: "pending" },
      });
      expect(await s.ledger.readIngress(admitted.receipt.effectKey!)).toEqual({ status: "not_found" });
      expect(s.effects).toEqual([]);
      await runtime.reconcile("org:test");
      await s.tasks.shift()!();
      const owner = await s.ledger.readIngress(admitted.receipt.effectKey!);
      if (owner.status !== "record") throw new Error("missing original owner");
      expect(s.effects).toMatchObject([{ runId: owner.record.runId, actor: "http:credential", userId: "http:alice" }]);
      await runtime.reconcile("org:test");
      expect(s.effects).toHaveLength(1);
    },
  );
  it.each(["effect-store", "owner-store", "actor-proof", "policy-proof"] as const)(
    "keeps admission pending after unavailable %s and admits the original key once on recovery",
    async (failure) => {
      let available = true;
      const s = setup(async () => {
        if (!available && failure === "policy-proof") throw new Error("policy unavailable");
        return true;
      });
      const admitted = await s.send("held-key");
      if (admitted.status !== "receipt") throw new Error("not admitted");
      const execute = s.store.execute.bind(s.store);
      const consume = s.ledger.consumeIngress.bind(s.ledger);
      s.store.execute = async (command) =>
        !available && failure === "effect-store" && command.action === "effect"
          ? { status: "unavailable" }
          : execute(command);
      s.ledger.consumeIngress = async (input) => {
        if (!available && failure === "owner-store") throw new Error("ingress unavailable");
        return consume(input);
      };
      const runtime = createOrganizationRuntime({
        ...s,
        resolveActor: async (envelope) => {
          if (!available && failure === "actor-proof") throw new Error("actor unavailable");
          return s.resolveActor(envelope);
        },
      });
      available = false;
      await runtime.reconcile("org:test");
      available = true;
      expect(await s.send("held-key")).toMatchObject({
        status: "receipt",
        duplicate: true,
        receipt: { status: "pending" },
      });
      expect(await s.ledger.readIngress(admitted.receipt.effectKey!)).toEqual({ status: "not_found" });
      await runtime.reconcile("org:test");
      await s.tasks.shift()!();
      const owner = await s.ledger.readIngress(admitted.receipt.effectKey!);
      if (owner.status !== "record") throw new Error("missing original owner");
      expect(s.effects).toMatchObject([
        { runId: owner.record.runId, actor: "http:credential", text: "Start original work" },
      ]);
      await runtime.reconcile("org:test");
      expect(s.effects).toHaveLength(1);
    },
  );
  it.each(["directory", "execution-store", "snapshot-store"] as const)(
    "retains accepted target ownership and uncertainty after unavailable %s at launch",
    async (failure) => {
      const s = setup();
      const target = { key: "recorded-question", revision: 7 };
      await s.store.execute({ action: "observe", organization: "org:test", target: target.key, revision: 7 });
      const admitted = await s.send("original-answer", undefined, target);
      if (admitted.status !== "receipt") throw new Error("not admitted");
      const runtime = createOrganizationRuntime({ ...s, answerOwned: s.dispatchOwned });
      await runtime.reconcile("org:test");
      const owned = await s.ledger.readIngress(admitted.receipt.effectKey!);
      if (owned.status !== "record") throw new Error("missing owner");
      const directory = s.store.directory.resolve.bind(s.store.directory);
      const execute = s.store.execute.bind(s.store);
      const read = s.ledger.readIngress.bind(s.ledger);
      if (failure === "directory") s.store.directory.resolve = async () => ({ status: "unavailable" });
      if (failure === "execution-store")
        s.store.execute = async (command) =>
          command.action === "execution" ? { status: "unavailable" } : execute(command);
      if (failure === "snapshot-store")
        s.ledger.readIngress = async () => {
          throw new Error("snapshot unavailable");
        };
      await s.tasks.shift()!();
      s.store.directory.resolve = directory;
      s.store.execute = execute;
      s.ledger.readIngress = read;
      const after = await s.ledger.readIngress(admitted.receipt.effectKey!);
      expect(after).toMatchObject({ status: "record", record: { status: "uncertain", runId: owned.record.runId } });
      expect(after.status === "record" ? after.record.refusalPending : null).toBeUndefined();
      expect(await s.send("original-answer", undefined, target)).toMatchObject({
        status: "receipt",
        duplicate: true,
        receipt: { status: "accepted" },
      });
      expect(await s.send("new-answer", undefined, target)).toMatchObject({
        status: "receipt",
        receipt: { status: "stale" },
      });
      expect(s.effects).toEqual([]);
      const seen: string[] = [];
      const recovered = createOrganizationRuntime({
        ...s,
        readOriginalRun: async (id) => {
          seen.push(id);
          return { status: "completed", outcome: "Original owner reported completion" };
        },
      });
      expect(await recovered.readOwner(admitted.receipt.effectKey!)).toMatchObject({
        status: "record",
        record: { status: "completed", runId: owned.record.runId },
      });
      expect(seen).toEqual([owned.record.runId]);
      expect(s.effects).toEqual([]);
    },
  );
  it("holds an addressed reply through temporary proof loss and writes once after current proof returns", async () => {
    const s = setup();
    let request: OrganizationExecutionRequest | undefined;
    const runtime = createOrganizationRuntime({
      ...s,
      dispatchOwned: async (input) => {
        request = input;
        return { status: "completed" };
      },
    });
    await s.send("reply-owner");
    await runtime.reconcile("org:test");
    await s.tasks.shift()!();
    if (!request) throw new Error("missing original request");
    const resolve = s.store.directory.resolve.bind(s.store.directory);
    s.store.directory.resolve = async () => ({ status: "unavailable" });
    expect(await runtime.reply(request, "reply-key", "Owner reply")).toEqual({ status: "unavailable" });
    s.store.directory.resolve = resolve;
    expect(await runtime.reply(request, "reply-key", "Owner reply")).toEqual({ status: "ok", removed: 0 });
    expect(await runtime.reply(request, "reply-key", "Owner reply")).toEqual({ status: "ok", removed: 0 });
    const history = await s.service.streamTail(s.authentication);
    expect(history.status === "stream_tail" ? history.entries.map((entry) => entry.content) : null).toEqual([
      "Start original work",
      "Owner reply",
    ]);
  });
  it("expires the original source snapshot before consuming an owner while private history and replay receipts remain retained", async () => {
    let now = 1;
    const s = setup(
      async () => true,
      () => now,
    );
    const runtime = createOrganizationRuntime({ ...s, now: () => now, sourceSnapshotTtlMs: 30 });
    const admitted = await s.send("source-snapshot");
    if (admitted.status !== "receipt" || !admitted.receipt.effectKey) throw new Error("not admitted");
    now = 32;
    await runtime.reconcile("org:test");
    const disposition = await s.send("source-snapshot");
    expect(disposition).toMatchObject({
      status: "receipt",
      duplicate: true,
      receipt: { id: admitted.receipt.id, status: "rejected" },
    });
    expect(await s.ledger.readIngress(admitted.receipt.effectKey)).toEqual({ status: "not_found" });
    const history = await s.service.streamTail(s.authentication);
    expect(history.status === "stream_tail" ? history.entries.map((entry) => entry.content) : null).toEqual([
      "Start original work",
    ]);
    expect(s.effects).toEqual([]);
    now = 360;
    expect(await s.send("source-snapshot")).toMatchObject({
      status: "receipt",
      duplicate: true,
      receipt: { id: admitted.receipt.id, status: "rejected" },
    });
  });
  it("refuses a delayed launch after its original snapshot deadline and refuses an explicitly cleared snapshot before executing", async () => {
    for (const disposition of ["expired", "cleared"] as const) {
      let now = 1;
      const s = setup(
        async () => true,
        () => now,
      );
      const runtime = createOrganizationRuntime({ ...s, now: () => now, sourceSnapshotTtlMs: 30 });
      const admitted = await s.send(`delayed-${disposition}`);
      if (admitted.status !== "receipt" || !admitted.receipt.effectKey) throw new Error("not admitted");
      await runtime.reconcile("org:test");
      const accepted = await s.send(`delayed-${disposition}`);
      expect(accepted).toMatchObject({ status: "receipt", duplicate: true, receipt: { status: "accepted" } });
      if (disposition === "expired") now = 32;
      else await s.ledger.clearIngressContent(admitted.receipt.effectKey);
      await s.tasks.shift()!();
      const original = await runtime.readOwner(admitted.receipt.effectKey);
      expect(original).toMatchObject({
        status: "record",
        record: { status: "completed", outcome: "The original source snapshot is unavailable." },
      });
      const history = await s.service.streamTail(s.authentication);
      expect(history.status === "stream_tail" ? history.entries.map((entry) => entry.content) : null).toEqual([
        "Start original work",
      ]);
      expect(s.effects).toEqual([]);
    }
  });

  it("repairs a proved unread input after restart and fresh proof under the same consumed owner once", async () => {
    const s = setup();
    const admitted = await s.send("unread-original");
    if (admitted.status !== "receipt" || !admitted.receipt.effectKey) throw new Error("not admitted");
    const initial = createOrganizationRuntime({
      ...s,
      dispatchOwned: async () => ({ status: "uncertain" as const, reason: "Input queued on receiver." }),
    });
    await initial.reconcile("org:test");
    await s.tasks.shift()!();
    const owned = await s.ledger.readIngress(admitted.receipt.effectKey);
    if (owned.status !== "record") throw new Error("no original owner");
    const receiver = "actual-old-receiver";
    await s.ledger.claim({
      runId: receiver,
      gen: "old-generation",
      threadKey: reference.threadKey,
      leaseMs: 30,
      startedAt: 1,
      meta: { channelId: reference.channelId, userId: reference.userId, threadKey: reference.threadKey },
      card: null,
      system: "",
      tools: [],
    });
    const { withOriginalOrganizationDispatch } = await import("../dispatch/originalOrganizationInput.js");
    const { durableInboxMessage } = await import("../runLedger/inboxMessage.js");
    const message = withOriginalOrganizationDispatch(
      { ...reference, text: "Start original work" },
      { ingressRunId: owned.record.runId, organizationSequence: admitted.receipt.revision },
    );
    const pushed = await s.ledger.pushInbox(receiver, durableInboxMessage(message, message.text, 1));
    expect(
      await s.ledger.holdUnreadIngress({
        ingressRunId: owned.record.runId,
        receiverRunId: receiver,
        receiverGen: "old-generation",
        inboxSeq: pushed.seq!,
      }),
    ).toMatchObject({ status: "record", record: { unread: { status: "pending" } } });
    await s.ledger.finish(receiver, "old-generation", {
      id: receiver,
      channelId: reference.channelId,
      userId: reference.userId,
      threadKey: reference.threadKey,
      channelVisibility: "unknown",
      startedAt: 1,
      finishedAt: 2,
      status: "completed",
      eventCount: 0,
      storedEventCount: 0,
      truncated: false,
      events: [],
      diagnosis: analyzeRunFriction([]),
    });
    const unavailable = createOrganizationRuntime({
      ...s,
      resolveActor: async () => ({ status: "unavailable" as const }),
    });
    await unavailable.reconcile("org:test");
    expect(s.tasks).toEqual([]);
    expect(s.effects).toEqual([]);
    expect(await s.ledger.pendingUnreadIngress("org:test", 10)).toMatchObject({
      status: "unread",
      records: [
        {
          runId: owned.record.runId,
          unread: { status: "pending" },
          request: { envelope: { content: "Start original work" } },
        },
      ],
    });
    // A transient execution read must not take the one-time unread claim.
    const execution = s.store.execute.bind(s.store);
    for (const failure of ["directory", "execution", "snapshot"] as const) {
      const blocked = createOrganizationRuntime({ ...s });
      await blocked.reconcile("org:test");
      const resolve = s.store.directory.resolve.bind(s.store.directory);
      const read = s.ledger.readIngress.bind(s.ledger);
      if (failure === "directory") s.store.directory.resolve = async () => ({ status: "unavailable" });
      if (failure === "execution")
        s.store.execute = async (command) =>
          command.action === "execution" ? { status: "unavailable" } : execution(command);
      if (failure === "snapshot")
        s.ledger.readIngress = async () => {
          throw new Error("snapshot unavailable");
        };
      await s.tasks.shift()!();
      s.store.directory.resolve = resolve;
      s.store.execute = execution;
      s.ledger.readIngress = read;
      expect(await s.ledger.pendingUnreadIngress("org:test", 10)).toMatchObject({
        status: "unread",
        records: [{ runId: owned.record.runId, unread: { status: "pending" } }],
      });
    }
    // Both generations can discover the obligation; only one obtains the claim.
    const replacement = createOrganizationRuntime({ ...s });
    await replacement.reconcile("org:test");
    await replacement.reconcile("org:test");
    for (const task of s.tasks.splice(0)) await task();
    expect(s.effects).toEqual([
      {
        actor: reference.actorId,
        userId: reference.userId,
        thread: reference.threadKey,
        text: "Start original work",
        runId: owned.record.runId,
        kind: "message",
      },
    ]);
    expect(await s.ledger.readIngress(admitted.receipt.effectKey)).toMatchObject({
      status: "record",
      record: { runId: owned.record.runId, status: "completed", unread: { status: "claimed" } },
    });
    await replacement.reconcile("org:test");
    expect(s.tasks).toEqual([]);
  });

  it("replaces a queued result with the refusal from its unread continuation", async () => {
    const s = setup();
    const admitted = await s.send("unread-refusal");
    if (admitted.status !== "receipt" || !admitted.receipt.effectKey) throw new Error("not admitted");
    const first = createOrganizationRuntime({
      ...s,
      dispatchOwned: async () => ({
        status: "uncertain",
        reason: "Input queued on receiver.",
        dispatchResult: { status: "input_queued" },
      }),
    });
    await first.reconcile("org:test");
    await s.tasks.shift()!();
    const original = await s.ledger.readIngress(admitted.receipt.effectKey);
    if (original.status !== "record") throw new Error("original owner not found");
    expect(original.record.dispatchResult).toEqual({ status: "input_queued" });
    const receiver = "unread-refusal-receiver";
    await s.ledger.claim({
      runId: receiver,
      gen: "old-generation",
      threadKey: reference.threadKey,
      leaseMs: 30,
      startedAt: 1,
      meta: { channelId: reference.channelId, userId: reference.userId, threadKey: reference.threadKey },
      card: null,
      system: "",
      tools: [],
    });
    const { withOriginalOrganizationDispatch } = await import("../dispatch/originalOrganizationInput.js");
    const { durableInboxMessage } = await import("../runLedger/inboxMessage.js");
    const message = withOriginalOrganizationDispatch(
      { ...reference, text: "Start original work" },
      { ingressRunId: original.record.runId, organizationSequence: admitted.receipt.revision },
    );
    const pushed = await s.ledger.pushInbox(receiver, durableInboxMessage(message, message.text, 1));
    await s.ledger.holdUnreadIngress({
      ingressRunId: original.record.runId,
      receiverRunId: receiver,
      receiverGen: "old-generation",
      inboxSeq: pushed.seq!,
    });
    await s.ledger.finish(receiver, "old-generation", {
      id: receiver,
      channelId: reference.channelId,
      userId: reference.userId,
      threadKey: reference.threadKey,
      channelVisibility: "unknown",
      startedAt: 1,
      finishedAt: 2,
      status: "completed",
      eventCount: 0,
      storedEventCount: 0,
      truncated: false,
      events: [],
      diagnosis: analyzeRunFriction([]),
    });
    const resumed = createOrganizationRuntime({
      ...s,
      owner: "replacement",
      dispatchOwned: async () => ({
        status: "uncertain",
        reason: "pr_head_unknown",
        dispatchResult: { status: "refused", cause: "system", refusalCode: "pr_head_unknown" },
      }),
    });
    await resumed.reconcile("org:test");
    await s.tasks.shift()!();
    expect(await s.ledger.readIngressByRun(original.record.runId)).toMatchObject({
      status: "record",
      record: {
        runId: original.record.runId,
        status: "uncertain",
        unread: { status: "claimed" },
        handlerOutcome: "uncertain",
        ownerStage: "execute",
        dispatchResult: { status: "refused", cause: "system", refusalCode: "pr_head_unknown" },
      },
    });
    expect(s.effects).toEqual([]);
  });

  it("holds a pending request across missing proof and admits the same key once after fresh proof", async () => {
    const s = setup();
    let available = false;
    const runtime = createOrganizationRuntime({
      ...s,
      resolveActor: async (envelope) => (available ? s.resolveActor(envelope) : { status: "unavailable" as const }),
    });
    const admitted = await s.send("fresh-proof");
    if (admitted.status !== "receipt") throw new Error("not admitted");
    await runtime.reconcile("org:test");
    expect(s.tasks).toHaveLength(0);
    expect(await s.ledger.readIngress(admitted.receipt.effectKey!)).toEqual({ status: "not_found" });
    expect(await s.send("fresh-proof")).toMatchObject({
      status: "receipt",
      duplicate: true,
      receipt: { status: "pending" },
    });
    available = true;
    await runtime.reconcile("org:test");
    expect(s.tasks).toHaveLength(1);
    await s.tasks[0]!();
    await runtime.reconcile("org:test");
    expect(s.effects).toHaveLength(1);
    expect(await s.send("fresh-proof")).toMatchObject({
      status: "receipt",
      duplicate: true,
      receipt: { status: "accepted" },
    });
  });
  it("repairs a known refused answer after a store outage and keeps uncertain reservations", async () => {
    const s = setup();
    await s.store.execute({ action: "observe", organization: "org:test", target: "unit:question", revision: 7 });
    let unavailable = true;
    const runtime = createOrganizationRuntime({
      ...s,
      store: {
        execute: (command) =>
          command.action === "owner-refused" && unavailable
            ? Promise.resolve({ status: "unavailable" })
            : s.store.execute(command),
      },
      answerOwned: async () => ({ status: "refused", reason: "Original owner declined without an effect." }),
    });
    const first = await s.send("answer-1", undefined, { key: "unit:question", revision: 7 });
    if (first.status !== "receipt" || !first.receipt.effectKey) throw new Error("not admitted");
    await runtime.reconcile("org:test");
    await s.tasks[0]!();
    expect(await s.ledger.readIngress(first.receipt.effectKey)).toMatchObject({
      status: "record",
      record: { status: "completed", refusalPending: true },
    });
    expect(await s.send("blocked", undefined, { key: "unit:question", revision: 7 })).toMatchObject({
      status: "receipt",
      receipt: { status: "stale", currentRevision: 7 },
    });
    unavailable = false;
    await createOrganizationRuntime({ ...s, owner: "replacement" }).reconcile("org:test");
    expect(await s.send("answer-2", undefined, { key: "unit:question", revision: 7 })).toMatchObject({
      status: "receipt",
      receipt: { status: "pending", currentRevision: 7 },
    });
    expect(await s.ledger.readIngress(first.receipt.effectKey)).toMatchObject({
      status: "record",
      record: { refusalPending: false },
    });
    const t = setup();
    await t.store.execute({ action: "observe", organization: "org:test", target: "unit:question", revision: 7 });
    const uncertain = createOrganizationRuntime({
      ...t,
      answerOwned: async () => ({ status: "uncertain", reason: "Original owner outcome unknown." }),
    });
    await t.send("uncertain", undefined, { key: "unit:question", revision: 7 });
    await uncertain.reconcile("org:test");
    await t.tasks[0]!();
    expect(await t.send("must-hold", undefined, { key: "unit:question", revision: 7 })).toMatchObject({
      status: "receipt",
      receipt: { status: "stale", currentRevision: 7 },
    });
  });
  it("releases a known refusal after private content expiry without needing the old reply address", async () => {
    let now = 1;
    const s = setup(
      async () => true,
      () => now,
    );
    await s.store.execute({ action: "observe", organization: "org:test", target: "unit:question", revision: 7 });
    const runtime = createOrganizationRuntime({ ...s, answerOwned: async () => ({ status: "completed" }) });
    await s.send("expired", undefined, { key: "unit:question", revision: 7 });
    await runtime.reconcile("org:test");
    now = 100;
    await s.tasks[0]!();
    expect(await s.send("fresh", undefined, { key: "unit:question", revision: 7 })).toMatchObject({
      status: "receipt",
      receipt: { status: "pending", currentRevision: 7 },
    });
  });
  it("refuses organization permission revoked after scheduling even when credential identity remains valid", async () => {
    let allowed = true;
    const s = setup(async () => allowed);
    const admitted = await s.send("policy-revoke");
    if (admitted.status !== "receipt" || !admitted.receipt.effectKey) throw new Error("not admitted");
    await s.runtime.reconcile("org:test");
    allowed = false;
    await s.tasks[0]!();
    expect(await s.runtime.readOwner(admitted.receipt.effectKey)).toMatchObject({
      status: "record",
      record: { status: "completed", outcome: "Current organization authority could not be verified." },
    });
    expect(s.effects).toEqual([]);
    expect(await s.send("new-refused")).toEqual({ status: "not_found" });
  });
  it("persists deleted original-owner cleanup across an unavailable store and process replacement", async () => {
    const s = setup();
    const admitted = await s.send("delete");
    if (admitted.status !== "receipt" || !admitted.receipt.effectKey) throw new Error("not admitted");
    await s.runtime.reconcile("org:test");
    expect(await s.ledger.readIngress(admitted.receipt.effectKey)).toMatchObject({
      status: "record",
      record: { request: { envelope: { content: "Start original work" } } },
    });
    const failing = createOrganizationRuntime({
      ...s,
      ledger: {
        pendingUnreadIngress: s.ledger.pendingUnreadIngress.bind(s.ledger),
        claimUnreadIngress: s.ledger.claimUnreadIngress.bind(s.ledger),
        consumeIngress: s.ledger.consumeIngress.bind(s.ledger),
        launchIngress: s.ledger.launchIngress.bind(s.ledger),
        readIngress: s.ledger.readIngress.bind(s.ledger),
        finishIngress: s.ledger.finishIngress.bind(s.ledger),
        pendingIngressRefusals: s.ledger.pendingIngressRefusals.bind(s.ledger),
        ackIngressRefusal: s.ledger.ackIngressRefusal.bind(s.ledger),
        clearIngressContent: async () => {
          throw new Error("store unavailable");
        },
      },
    });
    expect(await failing.deleteContent(s.authentication, admitted.receipt.id)).toEqual({ status: "unavailable" });
    expect(await s.store.execute({ action: "owner-clears", organization: "org:test", limit: 10 })).toEqual({
      status: "owner-clears",
      items: [
        {
          receiptId: admitted.receipt.id,
          effectKey: admitted.receipt.effectKey,
          expiresAt: admitted.receipt.expiresAt,
        },
      ],
    });
    const clearing = vi.spyOn(s.ledger, "clearIngressContent");
    const replacement = createOrganizationRuntime({ ...s, owner: "replacement" });
    expect(await replacement.reconcile("org:test")).toMatchObject({ status: "state" });
    expect(clearing.mock.calls).toEqual([
      [
        admitted.receipt.effectKey,
        { receiptTtlMs: s.service.receiptRetentionMs, expiresAt: admitted.receipt.expiresAt },
      ],
    ]);
    expect(await s.ledger.readIngress(admitted.receipt.effectKey)).toMatchObject({
      status: "record",
      record: { request: null },
    });
    expect(await s.store.execute({ action: "owner-clears", organization: "org:test", limit: 10 })).toEqual({
      status: "owner-clears",
      items: [],
    });
    await s.tasks[0]!();
    expect(await s.ledger.readIngress(admitted.receipt.effectKey)).toMatchObject({
      status: "record",
      record: { status: "completed", outcome: "Access, retention or the original target changed." },
    });
    expect(s.effects).toEqual([]);
  });
  it("consumes the original ingress before scheduling and preserves credential and credited person", async () => {
    const s = setup();
    const admitted = await s.send("first");
    if (admitted.status !== "receipt" || !admitted.receipt.effectKey) throw new Error("not admitted");
    expect(await s.runtime.reconcile("org:test")).toMatchObject({ status: "state", state: { reconciledSequence: 1 } });
    const original = await s.runtime.readOwner(admitted.receipt.effectKey);
    expect(original).toMatchObject({
      status: "record",
      record: {
        status: "dispatching",
        request: { envelope: { content: "Start original work", sourceReference: reference } },
      },
    });
    if (original.status !== "record") throw new Error("not owned");
    const replacement = createOrganizationRuntime({ ...s, owner: "replacement" });
    await replacement.reconcile("org:test");
    expect(await s.send("first")).toMatchObject({
      status: "receipt",
      duplicate: true,
      receipt: { status: "accepted" },
    });
    await s.tasks[0]!();
    expect(s.effects).toEqual([
      {
        actor: "http:credential",
        userId: "http:alice",
        thread: "http:home:alice",
        text: "Start original work",
        runId: original.record.runId,
        kind: "message",
      },
    ]);
    expect(await s.runtime.readOwner(admitted.receipt.effectKey)).toMatchObject({
      status: "record",
      record: { status: "completed", outcome: "completed", handlerOutcome: "completed", ownerStage: "execute" },
    });
  });
  it("refuses revoked or replaced credentials after admission without dispatching a rival owner", async () => {
    const s = setup();
    const admitted = await s.send("revoke");
    if (admitted.status !== "receipt" || !admitted.receipt.effectKey) throw new Error("not admitted");
    await s.runtime.reconcile("org:test");
    await s.store.execute({
      action: "access",
      organization: "org:test",
      identity: { issuer: "http:test", tenant: null, subject: "credential" },
      allowed: false,
    });
    await s.tasks[0]!();
    expect(await s.runtime.readOwner(admitted.receipt.effectKey)).toMatchObject({
      status: "record",
      record: { status: "completed", outcome: "Access, retention or the original target changed." },
    });
    expect(
      await s.ledger.consumeIngress({
        effectKey: admitted.receipt.effectKey,
        digest: admitted.receipt.digest,
        requester: reference.userId,
        threadKey: reference.threadKey,
        request: {},
        contentExpiresAt: 91,
      }),
    ).toMatchObject({ status: "duplicate", record: { status: "completed" } });
    expect(s.effects).toEqual([]);
    const t = setup();
    const wrong = createOrganizationRuntime({
      ...t,
      resolveActor: async () => ({ actor: { ...actor, id: "http:rival" }, msg: { ...reference, text: "" } }),
    });
    await t.send("wrong");
    await wrong.reconcile("org:test");
    expect(await t.send("wrong")).toMatchObject({
      status: "receipt",
      duplicate: true,
      receipt: { status: "rejected" },
    });
  });
  it("retains scheduling uncertainty and reconciles only evidence about the original run", async () => {
    const s = setup();
    const runtime = createOrganizationRuntime({
      ...s,
      launch: () => {
        throw new Error("host stopped");
      },
      readOriginalRun: async () => ({ status: "completed", outcome: "Original run succeeded" }),
    });
    const admitted = await s.send("crash");
    if (admitted.status !== "receipt" || !admitted.receipt.effectKey) throw new Error("not admitted");
    await runtime.reconcile("org:test");
    const original = await s.ledger.readIngress(admitted.receipt.effectKey);
    expect(original).toMatchObject({
      status: "record",
      record: {
        status: "uncertain",
        outcome: "The original owner could not be scheduled.",
        handlerOutcome: "uncertain",
        ownerStage: "schedule",
        failure: { stage: "schedule", kind: "other" },
      },
    });
    expect(await runtime.readOwner(admitted.receipt.effectKey)).toMatchObject({
      status: "record",
      record: {
        status: "completed",
        outcome: "Original run succeeded",
        handlerOutcome: "uncertain",
        ownerStage: "schedule",
        failure: { stage: "schedule", kind: "other" },
      },
    });
    expect(s.effects).toEqual([]);
  });
  it("records the original producer before dispatch after a lost launch acknowledgement", async () => {
    const s = setup();
    const reports: OrganizationOwnerFailure[] = [];
    const runtime = createOrganizationRuntime({
      ...s,
      reportOwnerFailure: (failure) => {
        reports.push(failure);
      },
    });
    const admitted = await s.send("lost-launch-ack");
    if (admitted.status !== "receipt" || !admitted.receipt.effectKey) throw new Error("not admitted");
    const launch = s.ledger.launchIngress.bind(s.ledger);
    s.ledger.launchIngress = async (request) => {
      await launch(request);
      throw new Error("ack lost");
    };
    await runtime.reconcile("org:test");
    expect(s.effects).toEqual([]);
    await s.tasks.shift()!();
    expect(reports).toMatchObject([{ failure: { stage: "launch", kind: "other" } }]);
    expect(s.effects).toHaveLength(1);
    expect(await s.ledger.readIngress(admitted.receipt.effectKey)).toMatchObject({
      status: "record",
      record: {
        status: "completed",
        launch: { producerGeneration: "process" },
        terminal: { producerGeneration: "process", outcome: "completed" },
      },
    });
    await createOrganizationRuntime({ ...s, owner: "replacement" }).reconcile("org:test");
    expect(s.effects).toHaveLength(1);
    expect(s.tasks).toEqual([]);
  });
  it("does not execute when a lost launch acknowledgement cannot be read back", async () => {
    const s = setup();
    const admitted = await s.send("unreadable-launch-ack");
    if (admitted.status !== "receipt" || !admitted.receipt.effectKey) throw new Error("not admitted");
    const launch = s.ledger.launchIngress.bind(s.ledger);
    const read = s.ledger.readIngress.bind(s.ledger);
    s.ledger.launchIngress = async (request) => {
      await launch(request);
      throw new Error("ack lost");
    };
    let reads = 0;
    s.ledger.readIngress = async (effectKey) => {
      if (++reads > 1) throw new Error("read unavailable");
      return read(effectKey);
    };
    await s.runtime.reconcile("org:test");
    await expect(s.tasks.shift()!()).rejects.toThrow("Original ingress settlement was not recorded.");
    expect(s.effects).toEqual([]);
    expect(await read(admitted.receipt.effectKey)).toMatchObject({
      status: "record",
      record: { status: "dispatching", launch: { producerGeneration: "process" } },
    });
  });
  it("holds a delayed producer through reclaim and never starts a second effect", async () => {
    const s = setup();
    const admitted = await s.send("delayed-producer");
    if (admitted.status !== "receipt" || !admitted.receipt.effectKey) throw new Error("not admitted");
    await s.runtime.reconcile("org:test");
    const before = await s.ledger.readIngress(admitted.receipt.effectKey);
    expect(before).toMatchObject({ status: "record", record: { status: "dispatching" } });
    if (before.status !== "record") throw new Error("original owner missing");
    expect(before.record).not.toHaveProperty("launch");
    await createOrganizationRuntime({ ...s, owner: "replacement" }).reconcile("org:test");
    expect(s.tasks).toHaveLength(1);
    await s.tasks.shift()!();
    expect(s.effects).toHaveLength(1);
    expect(await s.ledger.readIngress(admitted.receipt.effectKey)).toMatchObject({
      status: "record",
      record: { launch: { producerGeneration: "process" }, terminal: { outcome: "completed" } },
    });
  });
  it("keeps missing launch proof uncertain without dispatching", async () => {
    const s = setup();
    const admitted = await s.send("missing-launch-row");
    if (admitted.status !== "receipt" || !admitted.receipt.effectKey) throw new Error("not admitted");
    s.ledger.launchIngress = async () => ({ status: "not_found" });
    await s.runtime.reconcile("org:test");
    await s.tasks.shift()!();
    expect(s.effects).toEqual([]);
    const held = await s.ledger.readIngress(admitted.receipt.effectKey);
    expect(held).toMatchObject({ status: "record", record: { status: "uncertain" } });
    if (held.status !== "record") throw new Error("original owner missing");
    expect(held.record).not.toHaveProperty("launch");
    expect(held.record).not.toHaveProperty("terminal");
  });
  it("does not repeat model, workspace or GitHub publication after an uncertain original Review", async () => {
    const s = setup();
    const effects = { model: 0, workspace: 0, githubReview: 0 };
    const original = createOrganizationRuntime({
      ...s,
      dispatchOwned: async () => {
        effects.model++;
        effects.workspace++;
        effects.githubReview++;
        return { status: "uncertain", reason: "The original publication acknowledgement is missing." };
      },
    });
    const admitted = await s.send("review-with-existing-github-publication");
    if (admitted.status !== "receipt" || !admitted.receipt.effectKey) throw new Error("not admitted");
    await original.reconcile("org:test");
    await s.tasks.shift()!();
    expect(effects).toEqual({ model: 1, workspace: 1, githubReview: 1 });
    expect(await s.ledger.readIngress(admitted.receipt.effectKey)).toMatchObject({
      status: "record",
      record: { status: "uncertain", launch: { producerGeneration: "process" } },
    });
    expect(await s.send("review-with-existing-github-publication")).toMatchObject({
      status: "receipt",
      duplicate: true,
      receipt: { status: "accepted" },
    });
    await createOrganizationRuntime({ ...s, owner: "replacement" }).reconcile("org:test");
    expect(s.tasks).toEqual([]);
    expect(effects).toEqual({ model: 1, workspace: 1, githubReview: 1 });
  });
  it("passes saved confirmation ids to the original consumer without making them message text", async () => {
    const s = setup();
    const confirmations: unknown[] = [];
    const runtime = createOrganizationRuntime({
      ...s,
      confirmOwned: async (request) => {
        confirmations.push({
          continuation: request.envelope.continuation,
          text: request.msg.text,
          actor: request.actor.id,
        });
        return { status: "completed" };
      },
    });
    const continuation = { kind: "confirm" as const, id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" };
    await s.send("confirm", continuation);
    await runtime.reconcile("org:test");
    await s.tasks[0]!();
    expect(confirmations).toEqual([{ continuation, text: "", actor: "http:credential" }]);
    expect(await s.send("confirm", { ...continuation, kind: "cancel" })).toEqual({ status: "conflict" });
  });
});
