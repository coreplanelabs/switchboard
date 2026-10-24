import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { prepareSourceRelevanceEvidence } from "./sourceRelevancePreparation.js";
import { captureSourceTaskSnapshot } from "./sourceTaskSnapshot.js";
import { InMemoryRunLedger } from "../runLedger/inMemory.js";
import type { SourceEventRecord, SourceRelevanceRequest } from "../runLedger/sourceEvents.js";

async function fixture() {
  const ledger = new InMemoryRunLedger(() => 100);
  await ledger.claim({
    runId: "root",
    threadKey: "cli:thread",
    gen: "g1",
    startedAt: 100,
    leaseMs: 30_000,
    system: "Root",
    tools: [],
    meta: {
      agent: "orchestrator",
      userId: "cli:alice",
      channelId: "cli:main",
      threadKey: "cli:thread",
      repo: "fixture/api",
      ref: "feature",
      baseRef: "main",
      headSha: "a".repeat(40),
      pr: 7,
    },
  });
  const received = await ledger.receiveSourceEvent({
    version: 2,
    sourceId: "fixture:source",
    deliveryId: "one",
    objectId: "comment:7",
    changeId: "edit:1",
    kind: "source-evidence",
    payload: { opaque: true },
    content: { kind: "text", state: "present", text: "The retry can lose data." },
  });
  if (received.kind === "refused") throw new Error("expected source");
  const claims = await ledger.claimSourceEvents({ owner: "g1", readerVersion: 3, limit: 1 });
  if (claims.kind !== "claimed" || !claims.claims[0]) throw new Error("expected claim");
  const task = captureSourceTaskSnapshot((await ledger.listLive())[0]!);
  if (!task) throw new Error("expected task");
  const input = { receipt: received.receipt, task, classifierPolicy: "fixture:policy:v1" };
  const preparation = (await prepareSourceRelevanceEvidence(input, ledger)).preparation;
  if (!preparation) throw new Error("expected private preparation");
  const request: SourceRelevanceRequest = {
    receipt: received.receipt,
    owner: claims.claims[0].lease.owner,
    token: claims.claims[0].lease.token,
    result: {
      version: 1,
      context: preparation.context,
      inputHash: preparation.inputHash,
      verdict: "relevant",
      source: "model",
      reason: "Affects retry correctness.",
    },
  };
  return { ledger, input, request, preparation };
}

describe("private source relevance preparation", () => {
  it("prepares detached exact identity while always holding admission", async () => {
    const s = await fixture();
    const pending = prepareSourceRelevanceEvidence(s.input, s.ledger);
    s.input.task.task.headSha = "b".repeat(40);
    expect(await pending).toEqual({ kind: "held", reason: "admission-unproved", preparation: s.preparation });
    expect(s.preparation.context).toEqual({
      runId: "root",
      requester: "cli:alice",
      channelId: "cli:main",
      threadKey: "cli:thread",
      hash: createHash("sha256").update(JSON.stringify(s.preparation.task)).digest("hex"),
    });
    expect(s.preparation.task.task.headSha).toBe("a".repeat(40));
    expect(await s.ledger.readSourceEvent(s.input.receipt.key)).toMatchObject({ job: { version: 2 } });
  });

  it("uses effective defaults and changes identity with task, policy or settings", async () => {
    const s = await fixture();
    expect(await prepareSourceRelevanceEvidence({ ...s.input, timeoutMs: 8_000 }, s.ledger)).toEqual({
      kind: "held",
      reason: "admission-unproved",
      preparation: s.preparation,
    });
    const otherPolicy = await prepareSourceRelevanceEvidence(
      { ...s.input, classifierPolicy: "fixture:policy:v2" },
      s.ledger,
    );
    expect(otherPolicy).toMatchObject({
      kind: "held",
      reason: "admission-unproved",
      preparation: { context: s.preparation.context },
    });
    expect(otherPolicy.preparation?.inputHash).not.toBe(s.preparation.inputHash);
    const otherSettings = await prepareSourceRelevanceEvidence({ ...s.input, timeoutMs: 5_000 }, s.ledger);
    expect(otherSettings).toMatchObject({
      kind: "held",
      reason: "admission-unproved",
      preparation: { context: s.preparation.context },
    });
    expect(otherSettings.preparation?.inputHash).not.toBe(s.preparation.inputHash);
    expect(await prepareSourceRelevanceEvidence({ ...s.input, classifierPolicy: "" }, s.ledger)).toEqual({
      kind: "held",
      reason: "input-unproved",
    });
  });

  it.each([new Error("PRIVATE_ORIGINAL"), null, undefined])(
    "retains an original save and its exact error (%s) through missing readback",
    async (error) => {
      const s = await fixture();
      const original = { request: s.request, error };
      const result = await prepareSourceRelevanceEvidence({ ...s.input, original }, s.ledger);
      expect(result).toEqual({ kind: "held", reason: "admission-unproved", preparation: s.preparation, original });
      expect(Object.is(result.original?.error, error)).toBe(true);
      expect((await s.ledger.readSourceEvent(s.input.receipt.key))?.job.version).toBe(2);
    },
  );

  it("reads the exact original saved record only as private held evidence", async () => {
    const s = await fixture();
    const original = { request: s.request, error: new Error("PRIVATE_TRANSPORT") };
    expect(await s.ledger.saveSourceRelevance(s.request)).toMatchObject({
      kind: "saved",
      record: { verdict: "relevant" },
    });
    expect(await prepareSourceRelevanceEvidence({ ...s.input, original }, s.ledger)).toEqual({
      kind: "held",
      reason: "admission-unproved",
      preparation: s.preparation,
      original,
      originalRecord: { ...s.request.result, at: 100 },
    });
    // Stored results are not exposed without the original request to reconcile.
    expect(await prepareSourceRelevanceEvidence(s.input, s.ledger)).toEqual({
      kind: "held",
      reason: "admission-unproved",
      preparation: s.preparation,
    });
  });

  it("refuses changed original receipt, context, input or saved result without changing custody", async () => {
    const s = await fixture();
    const error = new Error("ORIGINAL_ERROR");
    const changed = [
      { ...s.request, receipt: { ...s.request.receipt, bodyHash: "e".repeat(64) } },
      { ...s.request, result: { ...s.request.result, context: { ...s.request.result.context, hash: "f".repeat(64) } } },
      { ...s.request, result: { ...s.request.result, inputHash: "f".repeat(64) } },
    ];
    for (const request of changed) {
      const result = await prepareSourceRelevanceEvidence({ ...s.input, original: { request, error } }, s.ledger);
      expect(result).toEqual({ kind: "held", reason: "identity-conflict", original: { request, error } });
      expect(result.original?.error).toBe(error);
    }
    await s.ledger.saveSourceRelevance({
      ...s.request,
      result: { ...s.request.result, reason: "Different original." },
    });
    expect(
      await prepareSourceRelevanceEvidence({ ...s.input, original: { request: s.request, error } }, s.ledger),
    ).toEqual({ kind: "held", reason: "identity-conflict", original: { request: s.request, error } });
    expect((await s.ledger.readSourceEvent(s.input.receipt.key))?.job).toMatchObject({
      version: 3,
      relevance: [{ reason: "Different original." }],
    });
  });

  it("keeps original custody across unavailable reads, unsupported jobs and ended roots", async () => {
    const s = await fixture();
    const original = { request: s.request, error: null };
    const deps = {
      listLive: s.ledger.listLive.bind(s.ledger),
      readSourceEvent: s.ledger.readSourceEvent.bind(s.ledger),
    };
    deps.readSourceEvent = async () => {
      throw new Error("PRIVATE_READ");
    };
    expect(await prepareSourceRelevanceEvidence({ ...s.input, original }, deps)).toEqual({
      kind: "held",
      reason: "unavailable",
      original,
    });
    deps.readSourceEvent = async (key) => {
      const record = await s.ledger.readSourceEvent(key);
      return record && ({ ...record, job: { ...record.job, version: 99 } } as unknown as SourceEventRecord);
    };
    expect(await prepareSourceRelevanceEvidence({ ...s.input, original }, deps)).toEqual({
      kind: "held",
      reason: "source-unproved",
      original,
    });
    deps.readSourceEvent = s.ledger.readSourceEvent.bind(s.ledger);
    deps.listLive = async () => [];
    expect(await prepareSourceRelevanceEvidence({ ...s.input, original }, deps)).toEqual({
      kind: "held",
      reason: "context-changed",
      original,
    });
  });

  it("returns no admission result when access changes during canonical reads", async () => {
    const s = await fixture();
    let allowed = true;
    const deps = {
      readSourceEvent: s.ledger.readSourceEvent.bind(s.ledger),
      listLive: async () => {
        allowed = false;
        return s.ledger.listLive();
      },
    };
    expect(await prepareSourceRelevanceEvidence(s.input, deps)).toEqual({
      kind: "held",
      reason: "admission-unproved",
      preparation: s.preparation,
    });
    expect(allowed).toBe(false);
  });

  it("holds canonical source or task changes across preparation reads", async () => {
    const s = await fixture();
    let reads = 0;
    const deps = {
      listLive: s.ledger.listLive.bind(s.ledger),
      readSourceEvent: async (key: string) => {
        const record = await s.ledger.readSourceEvent(key);
        return record && ++reads > 1 ? { ...record, event: { ...record.event, payload: { changed: true } } } : record;
      },
    };
    expect(await prepareSourceRelevanceEvidence(s.input, deps)).toEqual({ kind: "held", reason: "source-unproved" });
    deps.readSourceEvent = s.ledger.readSourceEvent.bind(s.ledger);
    const rows = await s.ledger.listLive();
    deps.listLive = async () => rows.map((row) => ({ ...row, meta: { ...row.meta, headSha: "b".repeat(40) } }));
    expect(await prepareSourceRelevanceEvidence(s.input, deps)).toEqual({ kind: "held", reason: "context-changed" });
  });
});
