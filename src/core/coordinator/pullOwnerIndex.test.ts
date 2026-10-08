// Feature: docs/reference/specs/run-history.md — bounded canonical pull ownership.
import { describe, expect, it } from "vitest";
import { analyzeRunFriction } from "../runFriction.js";
import { InMemoryRunLedger } from "../runLedger/inMemory.js";
import { InMemoryCoordinatorInstanceStore } from "./instanceStore.js";
import type { RunRecord } from "../runRecord.js";
import type { CoordinatorInstance, CoordinatorUnit } from "./contract.js";

const instance: CoordinatorInstance = {
  id: "target_index",
  kind: "ship",
  userId: "cli:owner",
  channelId: "cli:local",
  threadKey: "cli:target",
  repo: "acme/api",
  branch: "fix/target",
  base: "main",
  createdAt: 1,
};
const unit: CoordinatorUnit = {
  instanceId: instance.id,
  unit: "UINDEX",
  slug: "target",
  branch: instance.branch,
  dependsOn: [],
  rounds: [],
  pr: { number: 8, url: "https://github.com/acme/api/pull/8" },
};

function small(id: string, pr: number): RunRecord {
  const row = retained(id, pr);
  row.branchPublication!.pending!.id = "original-call";
  return row;
}

function retained(id: string, pr: number): RunRecord {
  return {
    id,
    channelId: "cli:local",
    userId: "cli:owner",
    threadKey: `cli:${id}`,
    channelVisibility: "unknown",
    startedAt: 1,
    finishedAt: 2,
    status: "completed",
    eventCount: 0,
    storedEventCount: 0,
    truncated: false,
    events: [],
    diagnosis: analyzeRunFriction([]),
    repo: "acme/api",
    branchPublication: {
      version: 1,
      repo: "acme/api",
      branches: [],
      complete: false,
      pending: { id: "x".repeat(Math.floor(1.4 * 1024 * 1024)), pr, headSha: "a".repeat(40) },
    },
  };
}

describe("bounded terminal pull-owner candidates", () => {
  it("makes bounded progress before proving a target absent without losing unrelated unknown writes", async () => {
    const ledger = new InMemoryRunLedger();
    const store = new InMemoryCoordinatorInstanceStore(ledger);
    for (let i = 0; i < 4; i++) ledger.finished.set(`retained_${i}`, retained(`retained_${i}`, 7));
    const originals = JSON.stringify([...ledger.finished]);
    const target = { repo: "ACME/API", pr: 8 };
    expect(await store.findPullOwners(target)).toEqual({ ok: false, reason: "incomplete" });
    expect(await store.findPullOwners(target)).toEqual({ ok: true, owners: [] });
    expect(await store.findPullOwners(target)).toEqual({ ok: true, owners: [] });
    expect(await store.put(instance)).toEqual({ ok: true });
    expect(await store.putUnits([unit])).toEqual({ ok: true });
    expect(await store.findPullOwners({ repo: "acme/api", pr: 7 })).toEqual({ ok: false, reason: "incomplete" });
    expect(JSON.stringify([...ledger.finished])).toBe(originals);
  });

  it("keeps an unindexed matching owner held until the complete bounded source inventory is covered", async () => {
    const ledger = new InMemoryRunLedger();
    const store = new InMemoryCoordinatorInstanceStore(ledger);
    for (let i = 0; i < 4; i++) ledger.finished.set(`late_${i}`, retained(`late_${i}`, i === 3 ? 8 : 7));
    expect(await store.findPullOwners({ repo: "acme/api", pr: 8 })).toEqual({ ok: false, reason: "incomplete" });
    expect(await store.findPullOwners({ repo: "acme/api", pr: 8 })).toEqual({
      ok: true,
      owners: [{ kind: "run", runId: "late_3" }],
    });
  });

  it("rereads changed source before admission and never transfers a retained write to a new unit", async () => {
    const ledger = new InMemoryRunLedger();
    const store = new InMemoryCoordinatorInstanceStore(ledger);
    const row = small("retained", 7);
    ledger.finished.set(row.id, row);
    expect(await store.findPullOwners({ repo: "acme/api", pr: 8 })).toEqual({ ok: true, owners: [] });
    row.branchPublication!.pending!.pr = 8;
    await store.put(instance);
    expect(await store.putUnits([unit])).toEqual({ ok: false, reason: "owned" });
    expect(await store.listUnits(instance.id)).toEqual([]);
    expect(ledger.finished.get(row.id)).toBe(row);
  });

  it.each(["publication", "door", "identity", "legacy", "record"] as const)(
    "keeps cached foreign %s corruption globally incomplete",
    async (mode) => {
      const ledger = new InMemoryRunLedger();
      const store = new InMemoryCoordinatorInstanceStore(ledger);
      const row = small("foreign", 7);
      ledger.finished.set(row.id, row);
      expect(await store.findPullOwners({ repo: "other/repo", pr: 8 })).toEqual({ ok: true, owners: [] });
      if (mode === "publication") row.branchPublication = { version: 9 } as never;
      if (mode === "door") row.doorPublicationPending = { private: "preserve" } as never;
      if (mode === "identity") row.threadKey = "";
      if (mode === "legacy") row.branchPublication = { version: 1, branches: [], complete: false };
      if (mode === "record") row.diagnosis = null as never;
      const original = JSON.stringify(row);
      expect(await store.findPullOwners({ repo: "other/repo", pr: 8 })).toEqual({ ok: false, reason: "incomplete" });
      expect(await store.findPullOwners({ repo: "other/repo", pr: 8 })).toEqual({ ok: false, reason: "incomplete" });
      expect(JSON.stringify(ledger.finished.get(row.id))).toBe(original);
    },
  );

  it("revalidates deletion and reinsertion instead of reusing a negative candidate", async () => {
    const ledger = new InMemoryRunLedger();
    const store = new InMemoryCoordinatorInstanceStore(ledger);
    ledger.finished.set("retained", small("retained", 7));
    const target = { repo: "acme/api", pr: 8 };
    expect(await store.findPullOwners(target)).toEqual({ ok: true, owners: [] });
    ledger.finished.delete("retained");
    expect(await store.findPullOwners(target)).toEqual({ ok: true, owners: [] });
    ledger.finished.set("retained", small("retained", 8));
    expect(await store.findPullOwners(target)).toEqual({ ok: true, owners: [{ kind: "run", runId: "retained" }] });
  });

  it("keeps unit and workspace dependencies outside negative terminal candidates", async () => {
    const ledger = new InMemoryRunLedger();
    const store = new InMemoryCoordinatorInstanceStore(ledger);
    ledger.finished.set("retained", small("retained", 7));
    const target = { repo: "acme/api", pr: 8 };
    expect(await store.findPullOwners(target)).toEqual({ ok: true, owners: [] });
    ledger.workspacePublicationRows = () => [
      {
        version: 1,
        revision: 1,
        owner: { runId: "workspace", ownerGen: "g1", ownerFence: 7 },
        binding: null,
        record: {
          id: "workspace",
          threadKey: "cli:workspace",
          status: "completed",
          userId: "cli:owner",
          repo: "acme/api",
        },
        publication: small("workspace", 8).branchPublication!,
      },
    ];
    expect(await store.findPullOwners(target)).toEqual({ ok: true, owners: [{ kind: "run", runId: "workspace" }] });
    ledger.workspacePublicationRows = () => [];
    await store.put(instance);
    await store.putUnits([unit]);
    expect(await store.findPullOwners(target)).toEqual({
      ok: true,
      owners: [{ kind: "unit", instanceId: instance.id, unit: unit.unit }],
    });
    (store as unknown as { units: Map<string, string> }).units.set(`${instance.id}\0${unit.unit}`, "{");
    expect(await store.findPullOwners(target)).toEqual({ ok: false, reason: "incomplete" });
  });
  it("includes negative terminal candidates referenced by an audit or settlement", async () => {
    const ledger = new InMemoryRunLedger();
    const store = new InMemoryCoordinatorInstanceStore(ledger);
    const row = {
      ...small("dependency", 7),
      agent: "coding",
      branchPublication: { version: 1 as const, branches: [], complete: true },
    };
    ledger.finished.set(row.id, row);
    const target = { repo: "other/repo", pr: 8 };
    expect(await store.findPullOwners(target)).toEqual({ ok: true, owners: [] });
    const source = store as unknown as {
      units: Map<string, string>;
      pullOwnershipRows: (audit: undefined, targets: (typeof target)[]) => { runs: { runId: string }[] };
    };
    await store.put(instance);
    const spawn = {
      version: 1,
      id: "UINDEX/0/coding",
      ordinal: 2,
      execution: { workflowId: instance.id },
      phase: "settled",
      target: { repo: instance.repo, ref: unit.branch, base: "main", headSha: "a".repeat(40) },
      calls: [{ operation: "spawn", state: "accepted", runId: row.id }],
    };
    source.units.set(
      `${instance.id}\0${unit.unit}`,
      JSON.stringify({
        ...unit,
        adoption: {
          version: 1,
          actionId: "audit-action",
          runId: row.id,
          headSha: "b".repeat(40),
          requester: instance.userId,
          threadKey: instance.threadKey,
          messageId: "source",
          claimedAt: 3,
          state: "claimed",
          audit: {
            version: 1,
            firstHead: "a".repeat(40),
            head: "b".repeat(40),
            eventCount: 1,
            eventDigest: "c".repeat(64),
            spawn,
            projection: "{}",
          },
        },
      }),
    );
    expect(source.pullOwnershipRows(undefined, [target]).runs.map((run) => run.runId)).toContain(row.id);
    source.units.clear();
    ledger.workspacePublicationRows = () => [
      {
        version: 1,
        revision: 1,
        owner: { runId: row.id, ownerGen: "g1", ownerFence: 7 },
        binding: null,
        record: { id: row.id, threadKey: row.threadKey, status: "completed", userId: "cli:owner", repo: "acme/api" },
        publication: small(row.id, 8).branchPublication!,
      },
    ];
    expect(source.pullOwnershipRows(undefined, [target]).runs.map((run) => run.runId)).toContain(row.id);
  });
  it("normalizes target keys and retains a Door write in a different repository", async () => {
    const ledger = new InMemoryRunLedger();
    const store = new InMemoryCoordinatorInstanceStore(ledger);
    const row = small("retained", 7);
    row.branchPublication!.pending!.ref = "refs/heads/fix/held";
    ledger.finished.set(row.id, row);
    expect(await store.findPullOwners({ repo: "ACME/API", ref: "fix/held" })).toEqual({
      ok: true,
      owners: [{ kind: "run", runId: row.id }],
    });
    row.doorPublicationPending = {
      id: "held-door",
      repo: "other/repo",
      pr: 12,
      update: { ref: "refs/heads/fix/door", old: "a".repeat(40), next: "b".repeat(40) },
    };
    expect(await store.findPullOwners({ repo: "OTHER/REPO", ref: "fix/door" })).toEqual({
      ok: true,
      owners: [{ kind: "run", runId: row.id }],
    });
  });
  it("refuses same-cardinality cached key drift without changing canonical source", async () => {
    const ledger = new InMemoryRunLedger();
    const store = new InMemoryCoordinatorInstanceStore(ledger);
    const row = small("retained", 8);
    ledger.finished.set(row.id, row);
    const target = { repo: "acme/api", pr: 8 };
    expect(await store.findPullOwners(target)).toEqual({ ok: true, owners: [{ kind: "run", runId: row.id }] });
    const source = JSON.stringify(row);
    const cache = (store as unknown as { terminalPullIndex: Map<string, { targets: { repo: string; pr: number }[] }> })
      .terminalPullIndex;
    cache.get(row.id)!.targets[0]!.repo = "other/repo";
    expect(await store.findPullOwners(target)).toEqual({ ok: false, reason: "incomplete" });
    expect(JSON.stringify(row)).toBe(source);
    expect(await store.findPullOwners(target)).toEqual({ ok: true, owners: [{ kind: "run", runId: row.id }] });
  });
});
