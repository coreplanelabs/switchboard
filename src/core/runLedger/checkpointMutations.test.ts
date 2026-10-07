import { describe, expect, it, vi } from "vitest";
import { createLedgerWriteThrough } from "./writeThrough.js";
import { InMemoryRunLedger } from "./inMemory.js";
import { InMemoryRunStore } from "../runStore.js";
import { WorkerRunLedger } from "../runLedgerWorker.js";
import { storeRequestWitness } from "../storeResponse.js";
import { analyzeRunFriction } from "../runFriction.js";
import type { RunRecord } from "../runRecord.js";
import type { ContextCheckpointRequest } from "../references/contextCheckpoint.js";
import type { LiveStateAssignRequest, RunState } from "./types.js";

type FixtureBody = ContextCheckpointRequest & {
  storeKey: string;
  state: RunState;
  assignment: LiveStateAssignRequest;
  afterSeq: number;
};

const ending: RunRecord = {
  id: "r1",
  channelId: "slack:C1",
  userId: "slack:UALICE",
  threadKey: "slack:C1:1",
  channelVisibility: "public",
  startedAt: 100,
  finishedAt: 200,
  status: "failed",
  events: [],
  eventCount: 0,
  storedEventCount: 0,
  truncated: false,
  diagnosis: analyzeRunFriction([]),
};
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
async function world() {
  const inner = new InMemoryRunLedger(() => 100);
  let intercept: ((path: string, body: FixtureBody, payload: string) => Promise<Response | undefined>) | undefined;
  const wire = new WorkerRunLedger({
    baseUrl: "https://state.invalid",
    token: "fixture",
    storeKey: "runs:fixture",
    fetch: async (url, init) => {
      const path = new URL(String(url)).pathname;
      const payload = String(init?.body),
        body = JSON.parse(payload) as FixtureBody;
      expect(body.storeKey).toBe("runs:fixture");
      const intercepted = await intercept?.(path, body, payload);
      if (intercepted) return intercepted;
      if (path === "/runs/state") {
        const result = await inner.setState(body.runId, body.gen, body.state);
        return Response.json(result, { status: result.ok ? 200 : 409 });
      }
      if (path === "/runs/live-state")
        return Response.json(await inner.assignLiveState(body.runId, body.gen, body.assignment));
      if (path === "/runs/session/checkpoint") return Response.json(await inner.normalizeContextOrigins(body));
      if (path === "/runs/inbox/read") return Response.json(await inner.peekInbox(body.runId, body.gen, body.afterSeq));
      throw new Error(`unexpected fixture route ${path}`);
    },
  });
  const ledger = new Proxy(inner, {
    get(target, key) {
      if (key === "setState") return wire.setState.bind(wire);
      if (key === "assignLiveState") return wire.assignLiveState.bind(wire);
      if (key === "normalizeContextOrigins") return wire.normalizeContextOrigins.bind(wire);
      if (key === "peekInbox") return wire.peekInbox.bind(wire);
      const value = Reflect.get(target, key, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  const wt = createLedgerWriteThrough({
    ledger,
    gen: "audit-current",
    fallback: new InMemoryRunStore(),
    warn: () => {},
  });
  const opened = await wt.open({
    runId: "r1",
    threadKey: "slack:C1:1",
    startedAt: 100,
    meta: {
      agent: "general",
      channelId: "slack:C1",
      userId: "slack:UALICE",
      threadKey: "slack:C1:1",
      channelVisibility: "public",
    },
    card: null,
    system: "system",
    tools: [],
    seed: {
      messages: [{ role: "user", content: [{ type: "text", text: "original" }] }],
      budgetMs: 10000,
      context: { version: 1, status: "known", revision: 0, origins: [], slack: [], mcp: [] },
    },
  });
  if (opened.kind !== "tracked") throw new Error("original tracked owner required");
  const run = opened.run;
  expect(
    (await run.assignLiveState({ state: "admitted", at: 100, bound: 10000, expectedSeq: 0, eventSeq: 1 })).ok,
  ).toBe(true);
  return {
    inner,
    run,
    intercept: (next: NonNullable<typeof intercept>) => {
      intercept = next;
    },
  };
}
const working = { state: "working", at: 150, bound: 10000, expectedSeq: 1, eventSeq: 2 } as const;

describe("adjacent canonical mutation closure", () => {
  it("qualifies a known normalization ACK before introducing a lost reply", async () => {
    const w = await world();
    try {
      const result = await w.run.normalizeContextOrigins();
      expect(result.ok).toBe(true);
      expect(w.inner.live.get("r1")!.state.contextCheckpointReceipt).toMatchObject({
        runId: "r1",
        ownerGen: "audit-current",
      });
    } finally {
      await w.run.close();
    }
  });
  it.each([true, false])(
    "retains the original live-state request after an unknown reply: committed=%s",
    async (committed) => {
      const w = await world();
      let original: Awaited<ReturnType<typeof storeRequestWitness>> | undefined;
      let didCommit = false,
        requests = 0;
      w.intercept(async (path, body, payload) => {
        if (path !== "/runs/live-state") return;
        requests++;
        original = await storeRequestWitness(path, payload);
        if (committed) didCommit = (await w.inner.assignLiveState(body.runId, body.gen, body.assignment)).ok;
        return new Response("reply unavailable", { status: 500 });
      });
      try {
        expect(await w.run.assignLiveState(working)).toEqual({ ok: false, reason: "unavailable" });
        expect(didCommit).toBe(committed);
        expect(requests).toBe(1);
        expect(w.run.writeBoundaryFailure).toMatchObject({
          runId: "r1",
          gen: "audit-current",
          requestDigest: original!.digest,
        });
        if (committed) {
          await w.run.sink.put(ending);
          expect(w.run.writeBoundaryFailure).toBeUndefined();
        } else {
          const before = structuredClone(w.inner.live.get("r1"));
          await expect(w.run.sink.put(ending)).rejects.toMatchObject({ request: original });
          expect(w.inner.live.get("r1")).toEqual(before);
        }
      } finally {
        await w.run.close();
      }
    },
  );

  it.each(["projection", "normalization"] as const)(
    "terminal closure joins an already-started %s mutation",
    async (kind) => {
      const w = await world(),
        entered = deferred(),
        release = deferred();
      const finish = vi.spyOn(w.inner, "finish");
      w.intercept(async (path) => {
        if (path !== (kind === "projection" ? "/runs/live-state" : "/runs/session/checkpoint")) return;
        entered.resolve();
        await release.promise;
        return undefined;
      });
      const mutation = kind === "projection" ? w.run.assignLiveState(working) : w.run.normalizeContextOrigins();
      await entered.promise;
      const terminal = w.run.sink.put(ending).then(
        (value) => ({ value }),
        (error: unknown) => ({ error }),
      );
      try {
        await new Promise((resolve) => setImmediate(resolve));
        expect(finish).not.toHaveBeenCalled();
        release.resolve();
        expect(await mutation).toMatchObject({ ok: true });
        expect(await terminal).toHaveProperty("value");
        expect(finish).toHaveBeenCalledTimes(1);
      } finally {
        release.resolve();
        await Promise.allSettled([mutation, terminal]);
        await w.run.close();
      }
    },
  );

  it.each([true, false])(
    "retains the original normalization request after an unknown reply: committed=%s",
    async (committed) => {
      const w = await world();
      let original: Awaited<ReturnType<typeof storeRequestWitness>> | undefined;
      let didCommit = false;
      let requests = 0;
      w.intercept(async (path, body, payload) => {
        if (path !== "/runs/session/checkpoint") return;
        requests++;
        original = await storeRequestWitness(path, payload);
        if (committed) didCommit = (await w.inner.normalizeContextOrigins(body)).ok;
        return new Response("reply unavailable", { status: 500 });
      });
      try {
        expect(await w.run.normalizeContextOrigins()).toEqual({ ok: false, reason: "checkpoint-unavailable" });
        expect(didCommit).toBe(committed);
        expect(requests).toBe(1);
        if (committed) {
          const payload = JSON.parse(original!.payload);
          expect(w.inner.live.get("r1")!.state.contextCheckpointReceipt).toMatchObject({
            runId: "r1",
            ownerGen: "audit-current",
            session: { key: payload.key },
            beforeHash: payload.expected.beforeHash,
            beforeRevision: payload.expected.revision,
            inputs: payload.expected.inputs,
          });
        } else expect(w.inner.live.get("r1")!.state.contextCheckpointReceipt).toBeUndefined();
        expect(w.run.writeBoundaryFailure).toMatchObject({
          runId: "r1",
          gen: "audit-current",
          requestDigest: original!.digest,
        });
        if (committed) {
          await w.run.sink.put(ending);
          expect(w.run.writeBoundaryFailure).toBeUndefined();
          expect(w.inner.live.has("r1")).toBe(false);
        }
        if (!committed) {
          const before = structuredClone(w.inner.live.get("r1"));
          await expect(w.run.sink.put(ending)).rejects.toMatchObject({ request: original });
          expect(w.inner.live.get("r1")).toEqual(before);
        }
      } finally {
        await w.run.close();
      }
    },
  );
  it.each(["foreign-owner", "wrong-input", "pending-only"] as const)(
    "keeps normalization held for %s readback",
    async (caseName) => {
      const w = await world();
      let original: Awaited<ReturnType<typeof storeRequestWitness>> | undefined;
      w.intercept(async (path, body, payload) => {
        if (path !== "/runs/session/checkpoint") return;
        original = await storeRequestWitness(path, payload);
        await w.inner.normalizeContextOrigins(body);
        return new Response("reply unavailable", { status: 500 });
      });
      try {
        expect((await w.run.normalizeContextOrigins()).ok).toBe(false);
        const row = w.inner.live.get("r1")!;
        const receipt = structuredClone(row.state.contextCheckpointReceipt) as {
          ownerGen: string;
          inputs: { notepadHash: string };
        };
        expect(receipt).toMatchObject({ ownerGen: "audit-current" });
        if (caseName === "foreign-owner") receipt.ownerGen = "other-generation";
        if (caseName === "wrong-input") receipt.inputs.notepadHash = "f".repeat(64);
        if (caseName === "pending-only") {
          delete row.state.contextCheckpointReceipt;
          row.state.pendingContextCheckpoint = receipt;
        } else row.state.contextCheckpointReceipt = receipt;
        const before = structuredClone(row);
        await expect(w.run.sink.put(ending)).rejects.toMatchObject({ request: original });
        expect(w.inner.live.get("r1")).toEqual(before);
        expect(w.run.writeBoundaryFailure).toMatchObject({ requestDigest: original!.digest });
      } finally {
        await w.run.close();
      }
    },
  );
});
