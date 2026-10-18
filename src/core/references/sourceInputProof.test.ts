import { afterEach, describe, expect, it, vi } from "vitest";
import { readSourceInputProof } from "./sourceInputProof.js";
import { sourceHash } from "./receipts.js";
import type { SourceInputReference } from "./sourceInputReference.js";
import { sourceEvidenceMessageFromRecord } from "../runLedger/sourceEvidence.js";
import { sourceSnapshot } from "../runLedger/sourceEvents.js";
import { InMemoryRunLedger } from "../runLedger/inMemory.js";
import { LEASE_MS, type LiveRunRow } from "../runLedger/types.js";
import { InMemoryRunStore } from "../runStore.js";
import type { RunRecord } from "../runRecord.js";
import { analyzeRunFriction } from "../runFriction.js";
import { orchestratorDecisionsOf, type OrchestratorSourceFoldDecision } from "../dispatch/orchestratorDecisions.js";

const owner = { runId: "root", requesterId: "cli:alice", channelId: "cli:main", threadKey: "cli:thread" };
afterEach(() => vi.restoreAllMocks());
const task = {
  repo: "fixture/api",
  ref: null,
  baseRef: null,
  headSha: null,
  pr: 7,
  operationTarget: null,
  githubSource: null,
  recordTaskKey: null,
};
async function fixture(fold = false) {
  const ledger = new InMemoryRunLedger(() => 123);
  const store = new InMemoryRunStore({ now: () => 200 });
  const saved = await ledger.receiveSourceEvent({
    version: 2,
    kind: "source-evidence",
    sourceId: "fixture:source",
    deliveryId: "one",
    objectId: "comment:7",
    changeId: "revision:1",
    authorId: "fixture:bot",
    payload: {},
    content: { kind: "text", state: "present", text: "Check the retry limit." },
  });
  if (saved.kind !== "received") throw new Error("Expected canonical source");
  const record = (await ledger.readSourceEvent(saved.receipt.key))!;
  const routing = fold
    ? { kind: "fold" as const, owner, decision: { runId: owner.runId, id: '["root","fold-1"]' } }
    : { kind: "notice" as const, owner };
  const message = (await sourceEvidenceMessageFromRecord(record, routing))!;
  const inputHash = await sourceHash(sourceSnapshot(message));
  const decision: OrchestratorSourceFoldDecision = {
    version: 2,
    kind: "source-fold",
    id: '["root","fold-1"]',
    owner,
    source: { kind: "source-evidence", receipt: saved.receipt },
    target: { kind: "run", hash: "a".repeat(64) },
    inputHash,
    contextHash: "b".repeat(64),
  };
  const reference: SourceInputReference = {
    version: 1,
    receipt: saved.receipt,
    root: { runId: owner.runId, requester: owner.requesterId, channelId: owner.channelId, threadKey: owner.threadKey },
    routing: fold
      ? { kind: "fold", decision: { id: decision.id, hash: await sourceHash(sourceSnapshot(decision)) } }
      : { kind: "notice" },
    inputHash,
    accessHash: "c".repeat(64),
  };
  await ledger.claim({
    runId: owner.runId,
    threadKey: owner.threadKey,
    gen: "g1",
    startedAt: 100,
    leaseMs: LEASE_MS,
    system: "Root",
    tools: [],
    meta: {
      agent: "orchestrator",
      userId: owner.requesterId,
      channelId: owner.channelId,
      threadKey: owner.threadKey,
      repo: task.repo,
      pr: task.pr,
    },
  });
  await ledger.setState(owner.runId, "g1", { orchestratorDecisions: [decision] });
  const root = (await ledger.listLive())[0]!;
  const read = () => readSourceInputProof(reference, { ledger });
  return { ledger, store, reference, message, record, root, decision, read };
}
function archived(root: LiveRunRow): RunRecord {
  return {
    id: root.runId,
    agent: "orchestrator",
    label: "Original root",
    model: "fixture/model",
    userId: root.meta.userId,
    channelId: root.meta.channelId,
    threadKey: root.meta.threadKey,
    channelVisibility: "unknown",
    repo: root.meta.repo,
    targetPr: root.meta.pr,
    startedAt: 100,
    finishedAt: 150,
    status: "completed",
    eventCount: 0,
    storedEventCount: 0,
    truncated: false,
    events: [],
    diagnosis: analyzeRunFriction([]),
    orchestratorDecisions: orchestratorDecisionsOf(root.state.orchestratorDecisions, owner),
  };
}

describe("canonical source input proof", () => {
  it.each([false, true])("reconstructs notice/fold=%s from the stored event and original root", async (fold) => {
    const f = await fixture(fold);
    expect(await f.read()).toEqual({ kind: "consistent", message: f.message, task });
  });
  it("holds archived roots without an exact retained source task", async () => {
    const f = await fixture(true);
    f.root.meta.ref = "original-branch";
    f.root.meta.baseRef = "original-base";
    f.root.meta.headSha = "a".repeat(40);
    f.root.meta.operationTarget = { repo: "fixture/api", ref: "accepted-target" };
    const rows = vi.spyOn(f.ledger, "listLive").mockResolvedValue([f.root]);
    expect(await f.read()).toEqual({
      kind: "consistent",
      message: f.message,
      task: {
        ...task,
        ref: "original-branch",
        baseRef: "original-base",
        headSha: "a".repeat(40),
        operationTarget: { repo: "fixture/api", ref: "accepted-target" },
      },
    });
    await f.store.put({ ...archived(f.root), headSha: "b".repeat(40) });
    expect(await f.store.get("root")).toMatchObject({ id: "root", targetPr: 7 });
    rows.mockResolvedValue([]);
    expect(await f.read()).toEqual({ kind: "held", reason: "root-unproved" });
  });
  it.each([false, true])("holds notice/fold=%s when an archive carries inherited child context", async (fold) => {
    const f = await fixture(fold);
    const inherited = {
      version: 1 as const,
      source: {
        runId: "earlier-root",
        requester: owner.requesterId,
        channelId: owner.channelId,
        threadKey: owner.threadKey,
      },
      session: { key: "earlier-session", from: 0, to: -1 },
      assets: [],
    };
    await f.store.put({ ...archived(f.root), childHandoff: inherited });
    expect(await f.store.get("root")).toMatchObject({ id: "root", childHandoff: inherited });
    const rows = vi.spyOn(f.ledger, "listLive").mockResolvedValue([]);
    expect(await f.read()).toEqual({ kind: "held", reason: "root-unproved" });
    rows.mockResolvedValue([{ ...f.root, meta: { ...f.root.meta, childHandoff: inherited } }]);
    expect(await f.read()).toEqual({ kind: "held", reason: "root-unproved" });
  });
  it("does not replace malformed live proof with an older valid archive", async () => {
    const f = await fixture();
    await f.store.put(archived(f.root));
    const invalid = structuredClone(f.root);
    invalid.meta.agent = "review";
    vi.spyOn(f.ledger, "listLive").mockResolvedValue([invalid]);
    expect(await f.read()).toEqual({ kind: "held", reason: "root-unproved" });
  });
  it("reads only the selected live root body", async () => {
    const f = await fixture();
    let reads = 0;
    const unrelated = { ...f.root, runId: "unrelated" };
    Object.defineProperty(unrelated, "state", {
      enumerable: true,
      get: () => {
        reads++;
        throw new Error("unrelated private data");
      },
    });
    vi.spyOn(f.ledger, "listLive").mockResolvedValue([unrelated, f.root]);
    expect(await f.read()).toEqual({ kind: "consistent", message: f.message, task });
    expect(reads).toBe(0);
  });
  it("holds ambiguous or unsafe live identities instead of using an archive", async () => {
    const f = await fixture();
    await f.store.put(archived(f.root));
    const live = vi.spyOn(f.ledger, "listLive").mockResolvedValue([f.root, f.root]);
    expect(await f.read()).toEqual({ kind: "held", reason: "root-unproved" });
    let reads = 0;
    const unsafe = { ...f.root };
    Object.defineProperty(unsafe, "runId", {
      enumerable: true,
      get: () => {
        reads++;
        return "root";
      },
    });
    live.mockResolvedValue([unsafe]);
    expect(await f.read()).toEqual({ kind: "held", reason: "root-unproved" });
    expect(reads).toBe(0);
  });
  it("refuses a missing source or original root", async () => {
    const f = await fixture();
    vi.spyOn(f.ledger, "readSourceEvent").mockResolvedValue(undefined);
    expect(await f.read()).toEqual({ kind: "held", reason: "source-unproved" });
    vi.restoreAllMocks();
    vi.spyOn(f.ledger, "listLive").mockResolvedValue([]);
    expect(await f.read()).toEqual({ kind: "held", reason: "root-unproved" });
  });
  it("checks every original receipt field and the complete common input hash", async () => {
    const f = await fixture();
    f.reference.receipt.sequence++;
    expect(await f.read()).toEqual({ kind: "held", reason: "source-unproved" });
    f.reference.receipt.sequence--;
    f.reference.inputHash = "d".repeat(64);
    expect(await f.read()).toEqual({ kind: "held", reason: "input-unproved" });
  });
  it.each(["requester", "channelId", "threadKey"] as const)("holds a changed original %s", async (field) => {
    const f = await fixture();
    f.reference.root[field] = "other";
    expect(await f.read()).toEqual({ kind: "held", reason: "root-unproved" });
  });
  it("requires the exact owned fold decision, its receipt and its input", async () => {
    const f = await fixture(true);
    if (f.reference.routing.kind !== "fold") throw new Error("Expected fold");
    f.reference.routing.decision.hash = "e".repeat(64);
    expect(await f.read()).toEqual({ kind: "held", reason: "decision-unproved" });
    f.reference.routing.decision.hash = await sourceHash(sourceSnapshot(f.decision));
    await f.ledger.setState(owner.runId, "g1", {
      orchestratorDecisions: [{ ...f.decision, inputHash: "e".repeat(64) }],
    });
    expect(await f.read()).toEqual({ kind: "held", reason: "decision-unproved" });
  });
  it("does not read a live decision from the archive metadata slot", async () => {
    const f = await fixture(true);
    const root = structuredClone(f.root);
    delete root.state.orchestratorDecisions;
    Object.assign(root.meta, { orchestratorDecisions: [f.decision] });
    vi.spyOn(f.ledger, "listLive").mockResolvedValue([root]);
    expect(await f.read()).toEqual({ kind: "held", reason: "decision-unproved" });
  });
  it("holds changes to the source or task while validation waits", async () => {
    const f = await fixture();
    const originalRead = f.ledger.readSourceEvent.bind(f.ledger);
    let n = 0;
    vi.spyOn(f.ledger, "readSourceEvent").mockImplementation(async (key) => {
      const value = await originalRead(key);
      if (++n === 2) {
        const changed = structuredClone(value!);
        changed.receipt.sequence++;
        return changed;
      }
      return value;
    });
    expect(await f.read()).toEqual({ kind: "held", reason: "source-changed" });
    vi.restoreAllMocks();
    const roots = f.ledger.listLive.bind(f.ledger);
    n = 0;
    vi.spyOn(f.ledger, "listLive").mockImplementation(async () => {
      const rows = await roots();
      if (++n === 2) rows[0]!.meta.recordTaskKey = "a".repeat(16);
      return rows;
    });
    expect(await f.read()).toEqual({ kind: "held", reason: "root-changed" });
  });
  it("keeps immutable source proof valid when only job scheduling metadata changes", async () => {
    const f = await fixture();
    const readSource = f.ledger.readSourceEvent.bind(f.ledger);
    let reads = 0;
    vi.spyOn(f.ledger, "readSourceEvent").mockImplementation(async (key) => {
      const record = await readSource(key);
      if (++reads === 2 && record && typeof record.job.nextAttemptAt === "number") record.job.nextAttemptAt++;
      return record;
    });
    expect(await f.read()).toEqual({ kind: "consistent", message: f.message, task });
  });
  it("captures the supplied reference before asynchronous reads", async () => {
    const f = await fixture();
    const pending = f.read();
    f.reference.inputHash = "f".repeat(64);
    expect(await pending).toEqual({ kind: "consistent", message: f.message, task });
  });
  it("holds unsafe references and storage errors with fixed reasons and no private details", async () => {
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
    const f = await fixture();
    let reads = 0;
    Object.defineProperty(f.reference, "inputHash", {
      enumerable: true,
      get: () => {
        reads++;
        return "private";
      },
    });
    expect(await f.read()).toEqual({ kind: "held", reason: "reference-unproved" });
    expect(reads).toBe(0);
    const valid = await fixture();
    vi.spyOn(valid.ledger, "listLive").mockRejectedValue(new Error("private record body"));
    expect(await valid.read()).toEqual({ kind: "held", reason: "unavailable" });
    expect(warning.mock.calls.map(([line]) => JSON.parse(String(line)))).toEqual([
      { event: "source.input.proof.unavailable" },
    ]);
  });
});
