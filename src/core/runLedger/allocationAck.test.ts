import { describe, expect, it } from "vitest";
import { InMemoryRunLedger } from "./inMemory.js";
import { createLedgerWriteThrough } from "./writeThrough.js";
import { WorkerRunLedger } from "../runLedgerWorker.js";
import { TransientStoreError, PermanentStoreError, RouteMissingError } from "../runStoreWorker.js";
import { allocationAckOf, UnknownAllocationClaimError } from "./allocationAck.js";
import type { ClaimRequest, WorkspaceAllocationAck } from "./types.js";
import type { WorkspaceAllocation } from "./workspaceDurability.js";
import { reserveRun } from "../dispatch/provision.js";
import { getAgent } from "../../agents/registry.js";

const id = "aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa",
  threadKey = "mcp:fixture:ack";
const allocation: WorkspaceAllocation = {
  version: 1,
  kind: "exclusive-scratch",
  runId: id,
  threadKey,
  requester: "slack:fixture",
  allocationKey: `review:${id}`,
  custody: "session-report",
};
const request = (): ClaimRequest => ({
  runId: id,
  threadKey,
  gen: "g1",
  leaseMs: 1000,
  startedAt: 1,
  system: "",
  tools: [],
  phase: "attaching",
  meta: {
    channelId: "mcp:fixture",
    userId: allocation.requester,
    threadKey,
    readonly: true,
    profile: { identity: "read", machine: "repo-resident", minutes: 25 },
    workspaceAllocation: structuredClone(allocation),
  },
});
const ack: WorkspaceAllocationAck = { version: 1, runId: id, threadKey, gen: "g1", startedAt: 1, allocation };

describe("original allocation claim acknowledgment", () => {
  it("holds contradictory successful HTTP replies without exposing a reserve handle", async () => {
    for (const body of [{ ok: false }, {}, null]) {
      let calls = 0;
      const client = new WorkerRunLedger({
        baseUrl: "https://fixture.invalid",
        storeKey: "runs:fixture",
        token: "fixture",
        fetch: async () => {
          calls++;
          return new Response(JSON.stringify(body), { status: 200 });
        },
      });
      const writer = createLedgerWriteThrough({
        ledger: client,
        gen: "g1",
        warn: () => {},
        claimAttempts: 3,
        now: () => 2,
        fallback: { put: async () => {}, abandoned: () => {} },
        setInterval: () => {
          throw new Error("unexpected heartbeat");
        },
      });
      await expect(writer.reserve(request())).rejects.toBeInstanceOf(UnknownAllocationClaimError);
      expect(calls).toBe(1);
      expect(writer.liveRuns()).toEqual([]);
    }
  });
  it("holds post-claim session failure without replaying accepted allocation work", async () => {
    for (const failure of [
      new PermanentStoreError("fixture session failure"),
      new RouteMissingError("fixture session route missing"),
    ]) {
      const store = new InMemoryRunLedger(() => 2),
        original = store.claim.bind(store);
      let claims = 0,
        sessions = 0;
      store.claim = async (req) => {
        claims++;
        return original(req);
      };
      store.claimSession = async () => {
        sessions++;
        throw failure;
      };
      const writer = createLedgerWriteThrough({
        ledger: store,
        gen: "g1",
        warn: () => {},
        claimAttempts: 3,
        now: () => 2,
        fallback: { put: async () => {}, abandoned: () => {} },
        setInterval: () => {
          throw new Error("unexpected heartbeat");
        },
      });
      await expect(
        writer.open({
          ...request(),
          seed: { messages: [{ role: "user", content: [{ type: "text", text: "original" }] }], budgetMs: 1000 },
        }),
      ).rejects.toBeInstanceOf(UnknownAllocationClaimError);
      expect({ claims, sessions }).toEqual({ claims: 1, sessions: 1 });
      expect(writer.liveRuns()).toEqual([]);
      expect(store.live.get(id)!.meta.workspaceAllocation).toEqual(allocation);
    }
  });
  it("propagates typed unknown through actual standalone reservation before admission becomes attachable", async () => {
    const agent = getAgent("review");
    const msg = {
      channelId: "mcp:fixture",
      threadKey,
      userId: allocation.requester,
      receivedAt: 1,
      text: "Review fixture",
    };
    const admitted: { runId?: string } = {};
    await expect(
      reserveRun(
        {
          runLedger: {
            reserve: async () => {
              throw new UnknownAllocationClaimError(new Error("fixture unknown"));
            },
          },
        } as never,
        {
          msg,
          agent,
          profile: { machine: agent.machine, identity: agent.identity, minutes: agent.maxMinutes },
          resolved: { modelRef: "fixture/model" },
          repoCtx: {},
          channelVisibility: "machine",
          runId: id,
          startedAt: 1,
          receivedAt: 1,
          resume: undefined,
          restart: undefined,
          card: { update() {}, async done() {} },
          hooks: {},
          admitted,
          root: { span: async (_name: string, run: () => Promise<unknown>) => run() },
        } as never,
      ),
    ).rejects.toBeInstanceOf(UnknownAllocationClaimError);
    expect(admitted.runId).toBeUndefined();
  });
  it("decodes exact receiver identity and canonical absence without accepting malformed or foreign permission", () => {
    expect(allocationAckOf(ack, request())).toEqual(ack);
    expect(allocationAckOf({ ...ack, allocation: null }, request())).toEqual({ ...ack, allocation: null });
    for (const bad of [
      undefined,
      { ok: true },
      { ...ack, version: 2 },
      { ...ack, gen: "foreign" },
      { ...ack, runId: "foreign" },
      { ...ack, threadKey: "mcp:foreign" },
      { ...ack, startedAt: 2 },
      { ...ack, permit: true },
      { ...ack, allocation: { ...allocation, requester: "slack:foreign" } },
      { ...ack, allocation: { ...allocation, custody: "session-report-and-review-publication" } },
    ])
      expect(allocationAckOf(bad, request())).toBeUndefined();
    const read = allocationAckOf(ack, request())!;
    read.allocation!.kind = "retained";
    expect(ack.allocation).toEqual(allocation);
  });
  it("validates the Worker client reply and preserves older successful tracking without a candidate ACK", async () => {
    for (const value of [
      ack,
      undefined,
      { ...ack, gen: "foreign" },
      { ...ack, allocation: { ...allocation, callerFlag: true } },
    ]) {
      const client = new WorkerRunLedger({
        baseUrl: "https://fixture.invalid",
        storeKey: "runs:fixture",
        token: "fixture",
        fetch: async () =>
          new Response(JSON.stringify({ ok: true, ...(value ? { allocationAck: value } : {}) }), { status: 200 }),
      });
      const result = await client.claim(request());
      expect(result).toEqual(value === ack ? { ok: true, allocationAck: ack } : { ok: true });
    }
  });
  it("propagates only a validated canonical reserve ACK and isolates each exposed copy", async () => {
    for (const mode of ["canonical", "missing", "foreign"] as const) {
      const store = new InMemoryRunLedger(() => 2),
        original = store.claim.bind(store);
      store.claim = async (req) => {
        const result = await original(req);
        if (!result.ok) return result;
        return mode === "canonical"
          ? result
          : mode === "missing"
            ? { ok: true }
            : { ok: true, allocationAck: { ...result.allocationAck!, gen: "foreign" } };
      };
      const writer = createLedgerWriteThrough({
        ledger: store,
        gen: "g1",
        now: () => 2,
        warn: () => {},
        fallback: { put: async () => {}, abandoned: () => {} },
        setInterval: () => ({ unref() {} }),
        clearInterval: () => {},
      });
      const req = request(),
        result = await writer.reserve(req);
      expect(result.kind).toBe("tracked");
      if (result.kind !== "tracked") throw new Error("missing fixture tracking");
      expect(result.allocationAck).toEqual(mode === "canonical" ? ack : undefined);
      expect(result.run.allocationAck).toEqual(mode === "canonical" ? ack : undefined);
      if (result.allocationAck) {
        result.allocationAck.allocation!.kind = "retained";
        const exposed = result.run.allocationAck!;
        exposed.allocation!.kind = "retained";
        req.meta.workspaceAllocation!.kind = "retained";
        expect(result.run.allocationAck).toEqual(ack);
        expect(store.live.get(id)!.meta.workspaceAllocation).toEqual(allocation);
      }
    }
  });
  it("rejects an unknown allocation-bearing claim after a committed lost reply without retry or handle", async () => {
    const store = new InMemoryRunLedger(() => 2),
      original = store.claim.bind(store);
    let claims = 0,
      heartbeats = 0,
      sleeps = 0;
    store.claim = async (req) => {
      claims++;
      await original(req);
      delete req.meta.workspaceAllocation; // a reply path cannot undo the original attempt's identity
      throw new TransientStoreError("fixture lost ACK after commit");
    };
    const writer = createLedgerWriteThrough({
      ledger: store,
      gen: "g1",
      now: () => 2,
      warn: () => {},
      fallback: { put: async () => {}, abandoned: () => {} },
      claimAttempts: 3,
      sleep: async () => {
        sleeps++;
      },
      setInterval: () => {
        heartbeats++;
        return { unref() {} };
      },
      clearInterval: () => {},
    });
    await expect(writer.reserve(request())).rejects.toBeInstanceOf(UnknownAllocationClaimError);
    expect({ claims, heartbeats, sleeps }).toEqual({ claims: 1, heartbeats: 0, sleeps: 0 });
    expect(writer.liveRuns()).toEqual([]);
    expect(store.live.get(id)!.meta.workspaceAllocation).toEqual(allocation);
    expect(store.sessions.size).toBe(0);
  });
});
