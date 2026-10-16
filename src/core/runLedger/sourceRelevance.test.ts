import { describe, expect, it } from "vitest";
import { InMemoryRunLedger } from "./inMemory.js";

const event = {
  version: 1,
  sourceId: "fixture:repo:1",
  deliveryId: "one",
  objectId: "comment:7",
  changeId: "revision:1",
  kind: "source-evidence",
  payload: { text: "missing check" },
};
const result = {
  version: 1,
  context: {
    runId: "root",
    requester: "fixture:user:1",
    channelId: "fixture:channel:1",
    threadKey: "fixture:thread:1",
    hash: "a".repeat(64),
  },
  inputHash: "b".repeat(64),
  verdict: "unrelated",
  source: "model",
  reason: "About another change.",
};
async function setup() {
  let now = 1_000;
  const ledger = new InMemoryRunLedger(() => now);
  const received = await ledger.receiveSourceEvent(event);
  if (received.kind === "refused") throw new Error("expected reception");
  const claimed = await ledger.claimSourceEvents({ owner: "g1", readerVersion: 3, limit: 1 });
  if (claimed.kind !== "claimed" || !claimed.claims[0]) throw new Error("expected capable claim");
  const request = { receipt: received.receipt, owner: "g1", token: claimed.claims[0].lease.token, result };
  return {
    ledger,
    request,
    clock: (value: number) => {
      now = value;
    },
  };
}

describe("saved source relevance", () => {
  it("retains a context-bound result and replays it after expiry without changing the job", async () => {
    const { ledger, request, clock } = await setup();
    const saved = await ledger.saveSourceRelevance(request);
    expect(saved).toEqual({ kind: "saved", receipt: request.receipt, record: { ...result, at: 1_000 } });
    clock(61_000);
    expect(await ledger.claimSourceEvents({ owner: "old-reader", readerVersion: 2, limit: 1 })).toEqual({
      kind: "claimed",
      claims: [],
      held: 1,
      failed: [],
    });
    const next = await ledger.claimSourceEvents({ owner: "g2", readerVersion: 3, limit: 1 });
    expect(next).toMatchObject({ kind: "claimed", claims: [{ attempts: 2, lease: { owner: "g2" } }] });
    expect(await ledger.saveSourceRelevance(request)).toEqual(saved);
    expect((await ledger.readSourceEvent(request.receipt.key))?.job).toMatchObject({
      version: 3,
      state: "leased",
      attempts: 2,
      lease: { owner: "g2" },
      relevance: [{ ...result, at: 1_000 }],
    });
    expect(await ledger.saveSourceRelevance({ ...request, result: { ...result, verdict: "relevant" } })).toEqual({
      kind: "refused",
      reason: "result-conflict",
    });
  });

  it("fences an unsaved late result and keeps the saved result through retry and failure", async () => {
    const { ledger, request, clock } = await setup();
    expect((await ledger.saveSourceRelevance(request)).kind).toBe("saved");
    clock(61_000);
    expect(
      await ledger.saveSourceRelevance({
        ...request,
        result: { ...result, context: { ...result.context, hash: "c".repeat(64) } },
      }),
    ).toEqual({ kind: "refused", reason: "fenced" });
    const next = await ledger.claimSourceEvents({ owner: "g2", readerVersion: 3, limit: 1 });
    if (next.kind !== "claimed" || !next.claims[0]) throw new Error("expected claim");
    expect(
      await ledger.releaseSourceEvent({
        key: request.receipt.key,
        owner: "g2",
        token: next.claims[0].lease.token,
        disposition: "hold",
        reason: "permission-refused",
      }),
    ).toMatchObject({ kind: "released", receipt: { state: "failed" } });
    expect((await ledger.readSourceEvent(request.receipt.key))?.job).toMatchObject({
      version: 3,
      state: "failed",
      relevance: [{ ...result, at: 1_000 }],
    });
    expect(await ledger.saveSourceRelevance(request)).toEqual({
      kind: "saved",
      receipt: request.receipt,
      record: { ...result, at: 1_000 },
    });
  });

  it("separates task contexts and refuses changed inputs under the same context", async () => {
    const { ledger, request } = await setup();
    expect((await ledger.saveSourceRelevance(request)).kind).toBe("saved");
    expect(await ledger.saveSourceRelevance({ ...request, result: { ...result, inputHash: "d".repeat(64) } })).toEqual({
      kind: "refused",
      reason: "result-conflict",
    });
    const second = { ...result, context: { ...result.context, hash: "c".repeat(64) }, verdict: "relevant" };
    expect(await ledger.saveSourceRelevance({ ...request, result: second })).toEqual({
      kind: "saved",
      receipt: request.receipt,
      record: { ...second, at: 1_000 },
    });
    expect((await ledger.readSourceEvent(request.receipt.key))?.job).toMatchObject({
      relevance: [
        { ...result, at: 1_000 },
        { ...second, at: 1_000 },
      ],
    });
  });

  it("binds reception and rejects unsafe or contradictory results without losing valid work", async () => {
    const { ledger, request } = await setup();
    expect(
      await ledger.saveSourceRelevance({ ...request, receipt: { ...request.receipt, bodyHash: "e".repeat(64) } }),
    ).toEqual({ kind: "refused", reason: "source-mismatch" });
    for (const invalid of [
      { ...result, source: "timeout" },
      { ...result, requester: "borrowed" },
      { ...result, reason: "x".repeat(1025) },
      { ...result, context: { ...result.context, hash: "bad" } },
    ]) {
      expect(await ledger.saveSourceRelevance({ ...request, result: invalid })).toEqual({
        kind: "refused",
        reason: "invalid-request",
      });
    }
    expect(await ledger.saveSourceRelevance(request)).toEqual({
      kind: "saved",
      receipt: request.receipt,
      record: { ...result, at: 1_000 },
    });
  });

  it("captures immutable input and bounds UTF-8 metadata without evaluating accessors", async () => {
    const { ledger, request } = await setup();
    let reads = 0;
    const unsafe = {
      ...request,
      get result() {
        reads++;
        return result;
      },
    };
    expect(await ledger.saveSourceRelevance(unsafe)).toEqual({ kind: "refused", reason: "invalid-request" });
    expect(reads).toBe(0);
    const large = {
      ...result,
      context: {
        ...result.context,
        runId: "😀".repeat(256),
        requester: "😀".repeat(256),
        channelId: "😀".repeat(256),
        threadKey: "😀".repeat(256),
      },
    };
    expect(await ledger.saveSourceRelevance({ ...request, result: large })).toEqual({
      kind: "refused",
      reason: "invalid-request",
    });
    const input = structuredClone(request);
    const pending = ledger.saveSourceRelevance(input);
    input.result.reason = "changed";
    const saved = await pending;
    expect(saved).toEqual({ kind: "saved", receipt: request.receipt, record: { ...result, at: 1_000 } });
    if (saved.kind !== "saved") throw new Error("expected save");
    saved.record.context.runId = "another-root";
    expect((await ledger.readSourceEvent(request.receipt.key))?.job).toMatchObject({
      relevance: [{ ...result, at: 1_000 }],
    });
  });

  it("bounds retained contexts and returns known results at capacity", async () => {
    const { ledger, request } = await setup();
    for (let i = 0; i < 16; i++)
      expect(
        (
          await ledger.saveSourceRelevance({
            ...request,
            result: { ...result, context: { ...result.context, runId: `root-${i}` } },
          })
        ).kind,
      ).toBe("saved");
    expect(await ledger.saveSourceRelevance(request)).toEqual({ kind: "refused", reason: "capacity" });
    expect(
      await ledger.saveSourceRelevance({
        ...request,
        result: { ...result, context: { ...result.context, runId: "root-0" } },
      }),
    ).toEqual({
      kind: "saved",
      receipt: request.receipt,
      record: { ...result, context: { ...result.context, runId: "root-0" }, at: 1_000 },
    });
  });
});
