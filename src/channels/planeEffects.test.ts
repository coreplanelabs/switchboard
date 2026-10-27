import { describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import * as receipts from "../core/references/receipts.js";
import { seedSourceInputCheckpoints } from "../core/testing/sourceInputs.js";
import { unreadInbox } from "../core/runLedger/decisions.js";
import type { StepRecord } from "../core/runLedger/types.js";
import type { IncomingMessage, ServerResponse } from "node:http";
import { Secret } from "../secrets.js";
import { FollowUpInbox } from "../core/threadAdmission.js";
import { InMemoryRunLedger } from "../core/runLedger/inMemory.js";
import type { RunLedger } from "../core/runLedger/ledger.js";
import { LEASE_MS } from "../core/runLedger/types.js";
import { createLedgerWriteThrough, createPlaneSteerSender, deliverPlaneSteer } from "../core/runLedger/writeThrough.js";
import { handlePlaneEffects, type PlaneEffectsDeps } from "./planeEffects.js";
import type {
  CoordinatorReconcileEffect,
  CoordinatorReconcileReceipt,
} from "../core/coordinator/workflowReconciliation.js";
import type { PlaneAckOutcome, PlaneEffect } from "../core/plane/decide.js";

// `POST /plane/effects` — the plane transport's push half (record 0064, "Where
// it lives"): the state Worker's committed effects, forwarded by the shim,
// run through the SAME executor the heartbeat answers use and are acked on
// the object; a failed ack leaves the offer standing to ride the next answer.

const TOKEN = new Secret("memory-token", "MEMORY_TOKEN");

function effect(runId = "q-run-1"): PlaneEffect {
  return { id: `admit:${runId}`, kind: "admit", runId, threadKey: "slack:C1:1.0", request: { text: "queued ask" } };
}

function steer(runId = "live-run-1", seq = 7): PlaneEffect {
  return {
    id: `steer:${runId}:${seq}`,
    kind: "steer",
    runId,
    seq,
    message: {
      version: 1,
      kind: "provider-reissue",
      targetRunId: runId,
      channelId: "slack:C1",
      threadKey: "slack:C1:1.0",
      text: "the model provider anthropic is answering again — re-issue the held turn and continue",
      at: 2_000,
      userId: "plane",
      userName: "plane",
      plane: { steer: "reissue", provider: "anthropic" },
    },
  };
}

function request(body: unknown, over: { method?: string; bearer?: string } = {}) {
  const writes: { status?: number; body?: string } = {};
  const raw = typeof body === "string" ? body : JSON.stringify(body);
  const req = {
    method: over.method ?? "POST",
    headers: over.bearer === undefined ? {} : { authorization: `Bearer ${over.bearer}` },
    async *[Symbol.asyncIterator]() {
      yield Buffer.from(raw, "utf8");
    },
  } as unknown as IncomingMessage;
  const res = {
    headersSent: false,
    writeHead: (status: number) => void (writes.status = status),
    end: (b: string) => void (writes.body = b),
  } as unknown as ServerResponse;
  return { req, res, writes };
}

function harness(over: Partial<PlaneEffectsDeps> = {}) {
  const acked: { id: string; outcome: PlaneAckOutcome }[] = [];
  const admitted: PlaneEffect[] = [];
  const steered: PlaneEffect[] = [];
  const warnings: string[] = [];
  const deps: PlaneEffectsDeps = {
    token: TOKEN,
    execute: {
      draining: () => false,
      admit: async (e) => {
        admitted.push(e);
        return "done";
      },
      steer: async (e) => {
        steered.push(e);
        return "done";
      },
    },
    fenceSteer: async () => true,
    ack: async (effect, outcome) => void acked.push({ id: effect.id, outcome }),
    warn: (l) => void warnings.push(l),
    log: () => {},
    ...over,
  };
  return { deps, acked, admitted, steered, warnings };
}

const settle = () => new Promise((r) => setTimeout(r, 0));

describe("exact provider recovery delivery", () => {
  it.each([false, true])(
    "acknowledges the original pushed row while keeping display text separate: changed=%s",
    async (changed) => {
      const ledger = new InMemoryRunLedger(() => 1000);
      const fixture = await seedSourceInputCheckpoints(ledger);
      const original = {
        version: 1 as const,
        kind: "provider-reissue" as const,
        targetRunId: fixture.id,
        channelId: "cli:main",
        threadKey: fixture.thread,
        text: changed
          ? "stored display bytes"
          : "the model provider anthropic is answering again — re-issue the held turn and continue",
        at: 2000,
        userId: "plane" as const,
        userName: "plane" as const,
        plane: { steer: "reissue" as const, provider: "anthropic" },
        // The canonical writer appends custody after the original message.
        target: {
          version: 1,
          runId: fixture.id,
          channelId: "cli:main",
          threadKey: fixture.thread,
          requester: "cli:alice",
          producerGen: fixture.gen,
        },
      };
      ledger.inbox.get(fixture.id)!.push({ seq: 5, message: original });
      const inbox = new FollowUpInbox();
      const sender = createPlaneSteerSender({
        draining: () => false,
        getRun: () => ({ threadKey: fixture.thread }),
        getInbox: () => ({ runId: fixture.id, inbox }),
      });
      const h = harness({ execute: { draining: () => false, admit: async () => "done", steer: sender } });
      const r = request(
        { effects: [{ id: "steer:source-consumer:5", kind: "steer", runId: fixture.id, seq: 5, message: original }] },
        { bearer: "memory-token" },
      );
      handlePlaneEffects(r.req, r.res, h.deps);
      await vi.waitFor(() => expect(r.writes.status).toBe(200));
      expect(h.acked).toEqual([{ id: "steer:source-consumer:5", outcome: "done" }]);
      const [delivered] = inbox.drain();
      expect(delivered.text).toBe(
        "the model provider anthropic is answering again — re-issue the held turn and continue",
      );
      expect(
        await ledger.step(
          fixture.id,
          fixture.gen,
          {
            ...fixture.step,
            step: 1,
            inboxConsumedSeq: 5,
            inboxAcknowledgedRows: [delivered.ledgerWitness!],
          },
          [],
          fixture.session,
        ),
      ).toEqual({ ok: true });
      const after = await ledger.peekInbox(fixture.id, fixture.gen, 0);
      if (!after.ok) throw new Error("missing canonical provider row");
      expect(after.items.filter(unreadInbox(after.boundary.lastStep as StepRecord)).map((row) => row.seq)).toEqual([
        1, 2, 3, 4,
      ]);
      expect(delivered.ledgerWitness).toEqual({
        version: 1,
        runId: fixture.id,
        seq: 5,
        digest: createHash("sha256").update(JSON.stringify(original)).digest("hex"),
      });
    },
  );

  it.each(["push", "heartbeat"] as const)(
    "defers %s recovery if drain begins while receipt hashing waits",
    async (transport) => {
      const offered = steer("live-run-1", 7) as Extract<PlaneEffect, { kind: "steer" }>;
      const inbox = new FollowUpInbox();
      let draining = false;
      let entered!: () => void, release!: () => void;
      const hashing = new Promise<void>((resolve) => {
        entered = resolve;
      });
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const originalHash = receipts.sourceHash;
      const hash = vi.spyOn(receipts, "sourceHash").mockImplementation(async (value) => {
        const digest = await originalHash(value);
        entered();
        await gate;
        return digest;
      });
      const sender = createPlaneSteerSender({
        draining: () => draining,
        getRun: () => ({ threadKey: "slack:C1:1.0" }),
        getInbox: () => ({ runId: "live-run-1", inbox }),
      });
      const execute = { draining: () => draining, admit: async () => "done" as const, steer: sender };
      const outcomes: PlaneAckOutcome[] = [];
      let start: () => void;
      let close: (() => Promise<void>) | undefined;
      if (transport === "push") {
        const h = harness({
          execute,
          ack: async (_effect, outcome) => {
            outcomes.push(outcome);
          },
        });
        const r = request({ effects: [offered] }, { bearer: "memory-token" });
        start = () => handlePlaneEffects(r.req, r.res, h.deps);
      } else {
        const inner = new InMemoryRunLedger(() => 1000);
        await inner.claim({
          runId: "live-run-1",
          threadKey: "slack:C1:1.0",
          gen: "g1",
          startedAt: 1000,
          leaseMs: LEASE_MS,
          meta: { channelId: "slack:C1", userId: "slack:UTEST", threadKey: "slack:C1:1.0", agent: "coding" },
          system: "coding",
          tools: [],
        });
        const ledger = new Proxy(inner, {
          get(target, prop) {
            if (prop === "heartbeat") return async () => ({ ok: true, effects: [offered] });
            if (prop === "planeAck")
              return async (_id: string, outcome: PlaneAckOutcome) => {
                outcomes.push(outcome);
              };
            const value = target[prop as keyof InMemoryRunLedger];
            return typeof value === "function" ? value.bind(target) : value;
          },
        });
        const beats: Array<() => void> = [];
        const wt = createLedgerWriteThrough({
          ledger,
          gen: "g1",
          fallback: { put: async () => {}, abandoned: () => {} },
          warn: () => {},
          planeEffects: execute,
          setInterval: (fn) => {
            beats.push(fn);
            return {};
          },
          clearInterval: () => {},
        });
        const row = inner.live.get("live-run-1")!;
        const run = wt.adopt({
          runId: row.runId,
          threadKey: row.threadKey,
          meta: row.meta,
          startedAt: row.startedAt,
          state: row.state,
          lastStep: 0,
          lastSeq: 0,
        });
        close = () => run.close();
        start = () => beats[0]!();
      }
      try {
        start();
        await hashing;
        draining = true;
        release();
        await vi.waitFor(() => expect(outcomes).toEqual(["deferred"]));
        expect(inbox.drain()).toEqual([]);
        draining = false;
        start();
        await vi.waitFor(() => expect(outcomes).toEqual(["deferred", "done"]));
        expect(inbox.drain().map((input) => input.ledgerSeq)).toEqual([7]);
        start();
        await vi.waitFor(() => expect(outcomes).toEqual(["deferred", "done", "skipped"]));
        expect(inbox.drain()).toEqual([]);
        draining = true;
        start();
        await vi.waitFor(() => expect(outcomes).toEqual(["deferred", "done", "skipped", "deferred"]));
      } finally {
        release();
        hash.mockRestore();
        await close?.();
      }
    },
  );

  it("checks the current run and admission slot before delivery and duplicate handling", async () => {
    const inbox = new FollowUpInbox();
    let run: { finished?: boolean; threadKey?: string } | undefined;
    let slot = { runId: "another-run", inbox };
    let draining = false;
    const sender = createPlaneSteerSender({ draining: () => draining, getRun: () => run, getInbox: () => slot });
    const offered = steer() as Extract<PlaneEffect, { kind: "steer" }>;
    expect(await sender(offered)).toBe("deferred");
    run = { threadKey: "slack:C1:1.0", finished: true };
    expect(await sender(offered)).toBe("deferred");
    run.finished = false;
    expect(await sender(offered)).toBe("deferred");
    slot = { runId: offered.runId, inbox };
    expect(await sender(offered)).toBe("done");
    expect(await sender(offered)).toBe("skipped");
    draining = true;
    expect(await sender(offered)).toBe("deferred");
    expect(inbox.drain().map((input) => input.ledgerSeq)).toEqual([7]);
  });
});

describe("POST /plane/effects — the push transport (record 0064)", () => {
  it("reconciles a closed offer without a runId and passes its verified report receipt to ACK", async () => {
    const offered: CoordinatorReconcileEffect = {
      id: `coordinator-reconcile:${"a".repeat(64)}`,
      kind: "coordinator_reconcile",
      instanceId: "instance-1",
      unit: "unit-1",
      workflowId: "instance-1",
      admissionHash: "b".repeat(64),
    };
    const owner = {
      instanceId: "instance-1",
      unit: "unit-1",
      attempt: 0,
      requester: "slack:U11",
      channelId: "slack:C1",
      threadKey: "slack:C1:1.0",
      deliveryId: "unit-1/end",
    };
    const receipt: CoordinatorReconcileReceipt = {
      reportDelivery: { version: 1, owner, proposalHash: "c".repeat(64) },
      status: { ...owner, destinationThreadKey: owner.threadKey, repo: "acme/api", snapshotHash: "d".repeat(64) },
    };
    const executed: unknown[] = [];
    const acked: unknown[] = [];
    const h = harness({
      execute: {
        draining: () => false,
        admit: async () => "done",
        steer: async () => "done",
        reconcile: async (effect) => {
          executed.push(effect);
          return receipt;
        },
      },
      ack: async (...args) => {
        acked.push(args);
      },
    });
    const r = request({ effects: [offered] }, { bearer: "memory-token" });
    handlePlaneEffects(r.req, r.res, h.deps);
    await settle();
    expect(executed).toEqual([offered]);
    expect(acked).toEqual([[offered, "done", receipt]]);
    expect(JSON.parse(r.writes.body!).acks).toEqual([{ id: offered.id, outcome: "done" }]);
  });

  it("defers reconciliation without an executor, during drain, or without a valid settlement receipt", async () => {
    const offered = {
      id: `coordinator-reconcile:${"a".repeat(64)}`,
      kind: "coordinator_reconcile",
      instanceId: "instance-1",
      unit: "unit-1",
      workflowId: "instance-1",
      admissionHash: "b".repeat(64),
    };
    let executed = 0;
    for (const execute of [
      undefined,
      {
        draining: () => true,
        admit: async () => "done" as const,
        steer: async () => "done" as const,
        reconcile: async () => {
          executed++;
          return undefined;
        },
      },
      { draining: () => false, admit: async () => "done" as const, steer: async () => "done" as const },
      {
        draining: () => false,
        admit: async () => "done" as const,
        steer: async () => "done" as const,
        reconcile: async () => undefined,
      },
      {
        draining: () => false,
        admit: async () => "done" as const,
        steer: async () => "done" as const,
        reconcile: async () => "done" as unknown as CoordinatorReconcileReceipt,
      },
    ]) {
      const h = harness({ execute });
      const r = request({ effects: [offered] }, { bearer: "memory-token" });
      handlePlaneEffects(r.req, r.res, h.deps);
      await settle();
      expect(h.acked).toEqual([{ id: offered.id, outcome: "deferred" }]);
    }
    expect(executed).toBe(0);
  });

  it("rejects malformed reconciliation identity before executing any neighboring effect", async () => {
    const offered = {
      id: `coordinator-reconcile:${"a".repeat(64)}`,
      kind: "coordinator_reconcile",
      instanceId: "instance-1",
      unit: "unit-1",
      workflowId: "instance-1",
      admissionHash: "b".repeat(64),
    };
    for (const invalid of [
      { ...offered, runId: "other" },
      { ...offered, admissionHash: "bad" },
      { ...offered, actionId: "other" },
    ]) {
      const h = harness();
      const r = request({ effects: [effect(), invalid] }, { bearer: "memory-token" });
      handlePlaneEffects(r.req, r.res, h.deps);
      await settle();
      expect(r.writes.status).toBe(400);
      expect(h.admitted).toEqual([]);
      expect(h.acked).toEqual([]);
    }
  });

  it("runs each pushed effect through the wired executor and acks its word on the object", async () => {
    const h = harness();
    const { req, res, writes } = request({ effects: [effect()] }, { bearer: "memory-token" });
    handlePlaneEffects(req, res, h.deps);
    await settle();
    expect(h.admitted.map((e) => e.id)).toEqual(["admit:q-run-1"]);
    expect(h.acked).toEqual([{ id: "admit:q-run-1", outcome: "done" }]);
    expect(writes.status).toBe(200);
    expect(JSON.parse(writes.body!)).toEqual({ ok: true, acks: [{ id: "admit:q-run-1", outcome: "done" }] });
  });

  it("delivers a pushed steer through the wired executor and acks only its outcome; probe effects remain for the heartbeat executor", async () => {
    const h = harness();
    const { req, res, writes } = request(
      { effects: [steer(), { id: "probe:r", kind: "probe", resident: "r" }] },
      { bearer: "memory-token" },
    );
    handlePlaneEffects(req, res, h.deps);
    await settle();
    expect(h.steered).toEqual([steer()]);
    expect(h.acked).toEqual([{ id: "steer:live-run-1:7", outcome: "done" }]);
    expect(JSON.parse(writes.body!)).toEqual({
      ok: true,
      acks: [{ id: "steer:live-run-1:7", outcome: "done" }],
    });
  });

  it("the stale generation defers a pushed steer, then the durable owner heartbeat delivers and acks it", async () => {
    let now = 1_000;
    const inner = new InMemoryRunLedger(() => now);
    await inner.claim({
      runId: "live-run-1",
      threadKey: "slack:C1:1.0",
      gen: "gen-stale",
      leaseMs: LEASE_MS,
      startedAt: now,
      meta: { channelId: "slack:C1", userId: "slack:UTEST", threadKey: "slack:C1:1.0", agent: "coding" },
      system: "coding",
      tools: [],
    });
    now += LEASE_MS;
    const [reclaimed] = await inner.reclaim("gen-owner", now, LEASE_MS);
    expect(reclaimed?.row).toMatchObject({ runId: "live-run-1", ownerGen: "gen-owner" });

    const offered = steer();
    const ownerLedger = new Proxy(inner, {
      get(target, prop) {
        if (prop === "heartbeat")
          return async (runId: string, gen: string, leaseMs: number) => {
            const result = await target.heartbeat(runId, gen, leaseMs);
            return result.ok ? { ...result, effects: [offered] } : result;
          };
        const value = target[prop as keyof InMemoryRunLedger];
        return typeof value === "function" ? (value as (...args: unknown[]) => unknown).bind(target) : value;
      },
    }) as unknown as RunLedger;

    const staleInbox = new FollowUpInbox();
    const staleAcks: { id: string; outcome: PlaneAckOutcome }[] = [];
    const h = harness({
      fenceSteer: async (effect) => inner.planeFenceSteer(effect.id, effect.runId, "gen-stale", LEASE_MS),
      execute: {
        draining: () => false,
        admit: async () => "done",
        steer: async (effect) => deliverPlaneSteer(effect, { runId: "live-run-1", inbox: staleInbox }),
      },
      ack: async (effect, outcome) => {
        staleAcks.push({ id: effect.id, outcome });
        await inner.planeAck(effect.id, outcome);
      },
    });
    const pushed = request({ effects: [offered] }, { bearer: "memory-token" });
    handlePlaneEffects(pushed.req, pushed.res, h.deps);
    await settle();
    expect(staleInbox.drain()).toEqual([]);
    expect(staleAcks).toEqual([{ id: offered.id, outcome: "deferred" }]);

    const beats: Array<() => void> = [];
    const ownerInbox = new FollowUpInbox();
    const writeThrough = createLedgerWriteThrough({
      ledger: ownerLedger,
      gen: "gen-owner",
      fallback: { put: async () => {}, abandoned: () => {} },
      warn: (line) => h.warnings.push(line),
      planeEffects: {
        draining: () => false,
        admit: async () => "done",
        steer: async (effect) => deliverPlaneSteer(effect, { runId: "live-run-1", inbox: ownerInbox }),
      },
      setInterval: (fn) => {
        beats.push(fn);
        return {};
      },
      clearInterval: () => {},
    });
    writeThrough.adopt({
      runId: "live-run-1",
      threadKey: "slack:C1:1.0",
      meta: reclaimed!.row.meta,
      startedAt: reclaimed!.row.startedAt,
      state: reclaimed!.row.state,
      lastStep: 0,
      lastSeq: 0,
    });
    beats[0]!();
    await new Promise((resolve) => setImmediate(resolve));
    expect(ownerInbox.drain()).toHaveLength(1);
    expect(inner.planeAcks).toEqual([
      { id: offered.id, outcome: "deferred" },
      { id: offered.id, outcome: "done" },
    ]);
    expect(h.warnings).toEqual([]);
  });

  it("renews the durable owner fence before registry delivery, so reclaim cannot cross the local wake", async () => {
    let now = 1_000;
    const inner = new InMemoryRunLedger(() => now);
    await inner.claim({
      runId: "live-run-1",
      threadKey: "slack:C1:1.0",
      gen: "gen-stale",
      leaseMs: LEASE_MS,
      startedAt: now,
      meta: { channelId: "slack:C1", userId: "slack:UTEST", threadKey: "slack:C1:1.0", agent: "coding" },
      system: "coding",
      tools: [],
    });
    now += LEASE_MS;
    const staleInbox = new FollowUpInbox();
    const h = harness({
      fenceSteer: async (effect) => {
        const accepted = await inner.planeFenceSteer(effect.id, effect.runId, "gen-stale", LEASE_MS);
        expect(await inner.reclaim("gen-owner", now, LEASE_MS)).toEqual([]);
        return accepted;
      },
      execute: {
        draining: () => false,
        admit: async () => "done",
        steer: async (effect) => deliverPlaneSteer(effect, { runId: "live-run-1", inbox: staleInbox }),
      },
    });
    const pushed = request({ effects: [steer()] }, { bearer: "memory-token" });
    handlePlaneEffects(pushed.req, pushed.res, h.deps);
    await settle();
    expect(staleInbox.drain()).toHaveLength(1);
    expect((await inner.listLive())[0]?.ownerGen).toBe("gen-stale");
    expect(h.acked).toEqual([{ id: "steer:live-run-1:7", outcome: "done" }]);
  });

  it("rechecks drain after the durable fence returns, so handoff cannot wake stale registry state", async () => {
    let draining = false;
    let delivered = 0;
    const h = harness({
      fenceSteer: async () => {
        draining = true;
        return true;
      },
      execute: {
        draining: () => draining,
        admit: async () => "done",
        steer: async () => {
          delivered++;
          return "done";
        },
      },
    });
    const pushed = request({ effects: [steer()] }, { bearer: "memory-token" });
    handlePlaneEffects(pushed.req, pushed.res, h.deps);
    await settle();
    expect(delivered).toBe(0);
    expect(h.acked).toEqual([{ id: "steer:live-run-1:7", outcome: "deferred" }]);
  });

  it("a draining generation defers, and no wired executor defers too — the offer stays for a bot that can run it", async () => {
    const draining = harness({
      execute: { draining: () => true, admit: async () => "done", steer: async () => "done" },
    });
    let r = request({ effects: [effect(), steer()] }, { bearer: "memory-token" });
    handlePlaneEffects(r.req, r.res, draining.deps);
    await settle();
    expect(draining.acked).toEqual([
      { id: "admit:q-run-1", outcome: "deferred" },
      { id: "steer:live-run-1:7", outcome: "deferred" },
    ]);
    const unwired = harness({ execute: undefined });
    r = request({ effects: [effect(), steer()] }, { bearer: "memory-token" });
    handlePlaneEffects(r.req, r.res, unwired.deps);
    await settle();
    expect(unwired.acked).toEqual([
      { id: "admit:q-run-1", outcome: "deferred" },
      { id: "steer:live-run-1:7", outcome: "deferred" },
    ]);
  });

  it("an effect whose execution or ack throws is one warning and stays offered — it rides the next heartbeat answer; the rest of the push still acks", async () => {
    const h = harness({
      execute: {
        draining: () => false,
        admit: async (e) => {
          if (e.runId === "boom") throw new Error("executor failed");
          return "done";
        },
        steer: async () => "done",
      },
    });
    const { req, res, writes } = request({ effects: [effect("boom"), effect("fine")] }, { bearer: "memory-token" });
    handlePlaneEffects(req, res, h.deps);
    await settle();
    expect(h.acked).toEqual([{ id: "admit:fine", outcome: "done" }]);
    expect(h.warnings[0]).toContain("admit:boom");
    expect(h.warnings[0]).toContain("rides the next heartbeat");
    expect(writes.status).toBe(200);
    expect(JSON.parse(writes.body!).acks).toEqual([{ id: "admit:fine", outcome: "done" }]);
  });

  it("refuses a wrong or missing bearer, and everything when the token is unset (fail closed); refuses non-POST", async () => {
    const h = harness();
    let r = request({ effects: [] }, { bearer: "wrong" });
    handlePlaneEffects(r.req, r.res, h.deps);
    expect(r.writes.status).toBe(401);
    r = request({ effects: [] });
    handlePlaneEffects(r.req, r.res, h.deps);
    expect(r.writes.status).toBe(401);
    const unset = harness({ token: undefined });
    r = request({ effects: [] }, { bearer: "memory-token" });
    handlePlaneEffects(r.req, r.res, unset.deps);
    expect(r.writes.status).toBe(401);
    r = request({ effects: [] }, { bearer: "memory-token", method: "GET" });
    handlePlaneEffects(r.req, r.res, h.deps);
    expect(r.writes.status).toBe(405);
    expect(h.acked).toEqual([]);
  });

  it("a non-JSON body, a body without an effects array and a malformed effect are 400 — nothing runs", async () => {
    for (const body of [
      "not json",
      { effects: "nope" },
      { effects: [{ kind: "admit", id: "x" }] },
      { effects: [{ kind: "steer", id: "steer:x:1", runId: "x", seq: 1, message: {} }] },
    ]) {
      const h = harness();
      const { req, res, writes } = request(body, { bearer: "memory-token" });
      handlePlaneEffects(req, res, h.deps);
      await settle();
      expect(writes.status).toBe(400);
      expect(h.admitted).toEqual([]);
      expect(h.acked).toEqual([]);
    }
  });
});
