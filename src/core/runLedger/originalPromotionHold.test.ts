import { describe, expect, it, vi } from "vitest";
import { InMemoryRunLedger } from "./inMemory.js";
import { createLedgerWriteThrough, type OpenRunRequest } from "./writeThrough.js";
import { UnknownAllocationClaimError } from "./allocationAck.js";
import { TransientStoreError, UncertainStoreError } from "../storeFailure.js";
import { storeRequestWitness } from "../storeResponse.js";

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
      channelId: "mcp:fixture",
      userId: "slack:fixture",
      threadKey: "mcp:fixture:original-hold",
      channelVisibility: "machine",
      profile: { machine: "repo-resident", identity: "read", minutes: 25 },
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
