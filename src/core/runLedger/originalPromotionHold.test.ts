import { describe, expect, it, vi } from "vitest";
import { InMemoryRunLedger } from "./inMemory.js";
import { createLedgerWriteThrough, type OpenRunRequest } from "./writeThrough.js";
import { UnknownAllocationClaimError } from "./allocationAck.js";
import { TransientStoreError, UncertainStoreError } from "../storeFailure.js";
import { storeRequestWitness } from "../storeResponse.js";
import { RunRegistry } from "../runRegistry.js";
import { createRunsService } from "../runsService.js";
import { createRunStop } from "../../execution/runStop.js";
import { secretsFrom } from "../../secrets.js";
import { reclaimedRunRecord } from "../dispatch/record.js";

// Feature: docs/reference/specs/run-history.md — an original may be committed
// and its source verified while confirmation remains held. Diagnosis must not
// turn that observed phase into permission to repeat or complete a mutation.
async function world() {
  const store = new InMemoryRunLedger(() => 10_000);
  const sleeps: number[] = [];
  const writer = createLedgerWriteThrough({
    ledger: store,
    gen: "g1",
    now: () => 10_000,
    warn: () => {},
    sleep: async (ms) => void sleeps.push(ms),
    fallback: { put: async () => {}, abandoned: () => {} },
    setInterval: () => ({ unref() {} }),
    clearInterval: () => {},
  });
  const req: OpenRunRequest = {
    runId: "aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa",
    threadKey: "mcp:fixture:original-hold",
    startedAt: 9_000,
    meta: {
      agent: "review",
      selection: "none",
      channelId: "mcp:fixture",
      userId: "slack:fixture",
      threadKey: "mcp:fixture:original-hold",
      channelVisibility: "machine",
      profile: { machine: "none", identity: "read", minutes: 25 },
    },
    system: "original system",
    tools: [],
    seed: {
      key: "task:fixture:original-hold",
      messages: [{ role: "user", content: [{ type: "text", text: "original input" }] }],
      context: { version: 1, status: "known", revision: 0, origins: [], slack: [], mcp: [] },
      notepad: "",
      budgetMs: 1_500_000,
    },
  };
  const reserved = await writer.reserve(req);
  if (reserved.kind !== "tracked") throw new Error("original reservation missing");
  const originalConfirm = store.confirmPromotion.bind(store);
  const claim = vi.spyOn(store, "claim");
  const confirm = vi.spyOn(store, "confirmPromotion");
  const release = vi.spyOn(store, "releaseExpectedSeed");
  const abandon = vi.spyOn(store, "abandon");
  return { store, writer, req, reserved: reserved.run, sleeps, claim, confirm, originalConfirm, release, abandon };
}

describe("original promotion hold diagnosis", () => {
  it("cancelled resident work retains exact terminal settlement ownership", async () => {
    const store = new InMemoryRunLedger(() => 20_000);
    const runId = "cccccccc-cccc-4ccc-cccc-cccccccccccc";
    const binding = {
      backend: "resident",
      ref: "main",
      workspace: "/workspace/threads/fixture/main",
      user: "worker2",
      container: "fixture-container",
      ownerGen: "g1",
      ownerFence: 7,
    };
    expect(
      await store.claim({
        runId,
        threadKey: "mcp:fixture:resident",
        gen: "g1",
        leaseMs: 30_000,
        startedAt: 1,
        meta: {
          agent: "review",
          channelId: "mcp:fixture",
          userId: "slack:fixture",
          threadKey: "mcp:fixture:resident",
          repo: "fixture/repo",
          selection: "resident",
        },
        state: { binding },
        system: "",
        tools: [],
      }),
    ).toMatchObject({ ok: true });
    expect(await store.requestStop(runId, "hard")).toMatchObject({ ok: true });
    const prepared = await store.prepareCancellation(runId, { kind: "chat", id: "slack:operator" });
    if (!prepared.ok) throw new Error("cancellation not prepared");
    const record = reclaimedRunRecord({ row: prepared.row, events: [], status: "stopped_hard", finishedAt: 20_000 });
    record.cancellation = {
      version: 1,
      actor: prepared.cancellation.actor,
      cancellation: prepared.cancellation,
      disposition: "processes-stopped",
    };
    expect(await store.finishCancellation(prepared.cancellation, record)).toEqual({ ok: true, stored: true });
    expect(await store.workspaceSettlement({ runId, ownerGen: "g1", ownerFence: 7 })).toMatchObject({
      owner: { runId, ownerGen: "g1", ownerFence: 7 },
      binding,
      record: { id: runId, status: "stopped_hard" },
    });
  });
  it("unsupported local fallback retains ordinary hard stop and canonical finish", async () => {
    const store = new InMemoryRunLedger(() => 10_000);
    const runId = "dddddddd-dddd-4ddd-dddd-dddddddddddd";
    expect(
      await store.claim({
        runId,
        threadKey: "mcp:fixture:local",
        gen: "g1",
        leaseMs: 30_000,
        startedAt: 1,
        meta: {
          agent: "coding",
          channelId: "mcp:fixture",
          userId: "slack:fixture",
          threadKey: "mcp:fixture:local",
          selection: "local",
        },
        state: { binding: { backend: "local", workspace: "/fixture" } },
        system: "",
        tools: [],
      }),
    ).toMatchObject({ ok: true });
    const service = createRunsService({
      registry: new RunRegistry(),
      store: null,
      ledger: store,
      generation: "g2",
      stopRuntime: createRunStop(
        { type: "cloudflare", url: "https://sandbox.example", resident: { baseUrl: "https://resident.example" } },
        secretsFrom({}),
      ),
    });
    expect(await service.stopRun(runId, "hard", { kind: "chat", id: "slack:operator" })).toEqual({
      ok: true,
      value: { id: runId, mode: "hard", state: "stopping" },
    });
    const owned = (await store.listLive())[0];
    expect(owned).toMatchObject({ stop: "hard", ownerGen: "g1" });
    expect(owned.state).not.toHaveProperty("cancellation");
    const record = reclaimedRunRecord({ row: owned, events: [], status: "stopped_hard", finishedAt: 20_000 });
    expect(await store.finish(runId, "g1", record)).toEqual({ ok: true, stored: true });
  });
  it("hard stop cancels an unconfirmed original without confirming its source or retaining an active run", async () => {
    const w = await world();
    w.confirm.mockResolvedValue({ kind: "held", reason: "mismatch" });
    await expect(w.writer.open({ ...w.req, reservation: w.reserved })).rejects.toBeInstanceOf(
      UnknownAllocationClaimError,
    );
    const before = await w.store.readPromotion({ runId: w.req.runId, gen: "g1" });
    expect(before.kind).toBe("committed");
    const registry = new RunRegistry({ now: () => 20_000 });
    registry.create("review", w.req.meta, { id: w.req.runId, startedAt: w.req.startedAt });
    const service = createRunsService({
      registry,
      store: null,
      ledger: w.store,
      generation: "g2",
      clock: () => 20_000,
      stopRuntime: async () => {
        registry.finish(w.req.runId, "failed");
        return { stopped: true, disposition: "no-workspace" };
      },
    });
    expect(await service.stopRun(w.req.runId, "hard", { kind: "chat", id: "slack:operator" })).toEqual({
      ok: true,
      value: { id: w.req.runId, mode: "hard", state: "stopped" },
    });
    expect(w.store.finished.get(w.req.runId)).toMatchObject({
      id: w.req.runId,
      status: "stopped_hard",
      cancellation: { version: 1, actor: { kind: "chat", id: "slack:operator" }, disposition: "no-workspace" },
    });
    expect((await service.listRuns({ visibleTo: { kind: "all" }, status: "active" })).runs).toEqual([]);
    expect(registry.getById(w.req.runId)).toMatchObject({ finished: true, status: "stopped_hard", persisted: true });
    expect(w.confirm).toHaveBeenCalledTimes(1);
    expect(w.release).not.toHaveBeenCalled();
    expect(await w.store.readPromotion({ runId: w.req.runId, gen: "g1" })).toMatchObject({ kind: "held" });
    w.confirm.mockRestore();
    const nextWriter = createLedgerWriteThrough({
      ledger: w.store,
      gen: "g2",
      now: () => 20_000,
      setInterval: () => ({ unref() {} }),
      clearInterval: () => {},
      warn: () => {},
      fallback: { put: async () => {}, abandoned: () => {} },
    });
    const next = {
      ...w.req,
      runId: "bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb",
      startedAt: 20_000,
      seed: {
        ...w.req.seed!,
        messages: [{ role: "user" as const, content: [{ type: "text" as const, text: "new request" }] }],
      },
    };
    const reservation = await nextWriter.reserve(next);
    expect(reservation.kind).toBe("tracked");
    if (reservation.kind !== "tracked") throw new Error("next request was not reserved");
    const opened = await nextWriter.open({ ...next, reservation: reservation.run });
    expect(opened.kind).toBe("tracked");
    expect(await w.store.readPromotion({ runId: next.runId, gen: "g2" })).toMatchObject({
      kind: "confirmed",
      receipt: { phase: "confirmed" },
    });
    if (opened.kind === "tracked") await opened.run.close();
  });
  it("an unacknowledged runtime stop keeps the exact cancellation fenced and a retry uses the same target", async () => {
    const w = await world();
    w.confirm.mockResolvedValue({ kind: "held", reason: "mismatch" });
    await expect(w.writer.open({ ...w.req, reservation: w.reserved })).rejects.toBeInstanceOf(
      UnknownAllocationClaimError,
    );
    const ids: string[] = [];
    let stopped = false;
    const service = createRunsService({
      registry: new RunRegistry(),
      store: null,
      ledger: w.store,
      generation: "g2",
      stopRuntime: async (_row, cancellation) => {
        ids.push(cancellation.id);
        return stopped ? { stopped: true, disposition: "no-workspace" } : { stopped: false };
      },
    });
    expect(await service.stopRun(w.req.runId, "hard", { kind: "chat", id: "slack:operator" })).toEqual({
      ok: false,
      error: "unavailable",
    });
    expect((await w.store.listLive())[0]).toMatchObject({
      runId: w.req.runId,
      stop: "hard",
      state: { cancellation: { version: 1 } },
    });
    expect(await w.store.append(w.req.runId, "g1", [{ type: "answer", text: "late answer", seq: 100 }])).toEqual({
      ok: false,
      reason: "fenced",
    });
    stopped = true;
    expect(await service.stopRun(w.req.runId, "hard", { kind: "chat", id: "slack:operator" })).toMatchObject({
      ok: true,
      value: { state: "stopped" },
    });
    expect(ids[0]).toBe(ids[1]);
    expect(w.store.finished.get(w.req.runId)).toMatchObject({ status: "stopped_hard" });
  });
  it.each(["unknown", "transient", "foreign"] as const)(
    "retains a committed and verified original when its source read is %s",
    async (mode) => {
      const w = await world();
      const read = w.store.readExpectedSeed.bind(w.store);
      w.store.readExpectedSeed = async (...args) => {
        if (mode === "transient") throw new TransientStoreError("private backend detail");
        if (mode === "unknown") return { kind: "held", reason: "unknown" };
        const actual = await read(...args);
        return actual.kind === "verified" ? { ...actual, receipt: { ...actual.receipt, gen: "foreign" } } : actual;
      };
      try {
        const error = await w.writer.open({ ...w.req, reservation: w.reserved }).catch((e: unknown) => e);
        expect(error).toBeInstanceOf(UnknownAllocationClaimError);

        expect(String(error)).not.toContain("private backend detail");
        const actual = await w.store.readPromotion({ runId: w.req.runId, gen: "g1" });
        expect(actual.kind).toBe("committed");
        if (actual.kind === "committed") {
          expect(
            await read(w.req.seed!.key!, {
              storeKey: "runs:default",
              runId: w.req.runId,
              gen: "g1",
              bodySha256: actual.receipt.bodySha256,
              expectedSeedSha256: actual.receipt.expectedSeedSha256!,
            }),
          ).toMatchObject({ kind: "verified", receipt: { phase: "pending-confirmation" } });
        }
        expect(w.claim).toHaveBeenCalledTimes(1);
        expect(w.confirm).not.toHaveBeenCalled();
        expect(w.release).not.toHaveBeenCalled();
        expect(w.abandon).not.toHaveBeenCalled();
        expect(w.sleeps).toEqual([]);
        expect(w.writer.liveRuns()).toEqual([w.reserved]);
        expect(error).toMatchObject({
          diagnosis: {
            phase: "source-verification",
            operation: "read",
            reason: mode === "foreign" ? "mismatch" : mode,
          },
        });
      } finally {
        await w.reserved.close();
      }
    },
  );

  it.each(["refused", "lost", "read-unknown"] as const)(
    "keeps the original held when confirmation is %s",
    async (mode) => {
      const w = await world();
      const read = w.store.readPromotion.bind(w.store);
      if (mode === "refused") w.confirm.mockResolvedValue({ kind: "held", reason: "mismatch" });
      if (mode === "lost")
        w.confirm.mockImplementation(async (ref) => {
          throw new UncertainStoreError(
            "private transport detail",
            await storeRequestWitness("/runs/claim", JSON.stringify({ confirm: ref })),
          );
        });
      if (mode === "read-unknown")
        w.store.readPromotion = async (...args) => {
          const actual = await read(...args);
          return actual.kind === "confirmed" ? { kind: "held", reason: "unknown" } : actual;
        };
      try {
        const error = await w.writer.open({ ...w.req, reservation: w.reserved }).catch((e: unknown) => e);
        expect(error).toBeInstanceOf(UnknownAllocationClaimError);

        expect(String(error)).not.toMatch(/private (transport|backend) detail/);
        expect((await read({ runId: w.req.runId, gen: "g1" })).kind).toBe(
          mode === "read-unknown" ? "confirmed" : "committed",
        );
        expect(w.claim).toHaveBeenCalledTimes(1);
        expect(w.confirm).toHaveBeenCalledTimes(1);
        expect(w.release).not.toHaveBeenCalled();
        expect(w.abandon).not.toHaveBeenCalled();
        expect(w.sleeps).toEqual([]);
        expect(w.writer.liveRuns()).toEqual([w.reserved]);
        expect(error).toMatchObject({
          diagnosis: {
            phase: "confirmation",
            operation: mode === "read-unknown" ? "read" : "write",
            reason: mode === "refused" ? "mismatch" : "unknown",
          },
        });
      } finally {
        await w.reserved.close();
      }
    },
  );

  it.each(["lost", "malformed"] as const)(
    "uses exact committed confirmation readback after a %s reply without repeating confirmation",
    async (mode) => {
      const w = await world();
      w.confirm.mockImplementation(async (ref) => {
        expect((await w.originalConfirm(ref)).kind).toBe("confirmed");
        if (mode === "lost")
          throw new UncertainStoreError(
            "reply lost",
            await storeRequestWitness("/runs/claim", JSON.stringify({ confirm: ref })),
          );
        return { kind: "held", reason: "unknown" };
      });
      try {
        expect(await w.writer.open({ ...w.req, reservation: w.reserved })).toMatchObject({ kind: "tracked" });
        expect(w.claim).toHaveBeenCalledTimes(1);
        expect(w.confirm).toHaveBeenCalledTimes(1);
        expect(w.release).toHaveBeenCalledTimes(1);
        expect(w.sleeps).toEqual([]);
      } finally {
        await w.reserved.close();
      }
    },
  );

  it("copies only bounded diagnosis fields into the error and keeps private causes out of its rendered trace", async () => {
    const diagnosis = {
      phase: "confirmation",
      operation: "write",
      reason: "mismatch",
      private: "private extra field",
    } as const;
    const witness = await storeRequestWitness("/runs/claim", "private original body");
    const cause = new UncertainStoreError("private backend detail", witness);
    const error = new UnknownAllocationClaimError(cause, diagnosis);
    Object.assign(diagnosis, { phase: "private replacement" });
    expect(error.diagnosis).toEqual({ phase: "confirmation", operation: "write", reason: "mismatch" });
    expect(Object.isFrozen(error.diagnosis)).toBe(true);
    expect(error.cause).toBe(cause);
    expect(error.message).toContain("Phase: confirmation; write: mismatch.");
    expect(JSON.stringify(error) + error.message).not.toMatch(/private|original body|backend detail/);
  });
});
