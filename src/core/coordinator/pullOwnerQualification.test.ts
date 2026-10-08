// Feature: docs/reference/specs/run-history.md — private ownership qualification.
import { describe, expect, it, vi } from "vitest";
import { InMemoryRunLedger } from "../runLedger/inMemory.js";
import { analyzeRunFriction } from "../runFriction.js";
import {
  InMemoryCoordinatorInstanceStore,
  WorkerCoordinatorInstanceStore,
  type CoordinatorInstanceStore,
} from "./instanceStore.js";
import { findPullOwnersInRows, type PullOwnershipDiagnostics } from "./pullOwnership.js";
import {
  pullOwnerQualificationSnapshot,
  qualifyPullOwnerSnapshot,
  pullOwnerQualificationFrom,
} from "./pullOwnerQualification.js";
import { isCoordinatorInstance, isCoordinatorUnit } from "./contract.js";

const target = { repo: "acme/api", pr: 7 };
const instance = {
  id: "original_owner",
  kind: "ship" as const,
  userId: "cli:owner",
  channelId: "cli:local",
  threadKey: "cli:original",
  repo: "acme/api",
  branch: "fix/original",
  base: "main",
  createdAt: 1,
};
const unit = {
  instanceId: instance.id,
  unit: "UOWNER",
  slug: "original",
  branch: instance.branch,
  dependsOn: [],
  rounds: [],
};
const record = {
  id: "original_coding",
  agent: "coding",
  channelId: instance.channelId,
  userId: instance.userId,
  threadKey: instance.threadKey,
  channelVisibility: "unknown" as const,
  repo: instance.repo,
  startedAt: 1,
  finishedAt: 2,
  status: "completed" as const,
  eventCount: 0,
  storedEventCount: 0,
  truncated: false,
  events: [],
  diagnosis: analyzeRunFriction([]),
  parentInstanceId: instance.id,
  coordinatorUnit: unit.unit,
  coordinatorAttempt: 0,
  idempotencyKey: `${instance.id}:${unit.unit}/0/coding`,
  branchPublication: { version: 1 as const, repo: "acme/api", branches: [], complete: false },
};
const row = () => ({
  runId: record.id,
  repo: record.repo,
  live: false,
  record: structuredClone(record),
  publication: structuredClone(record.branchPublication),
});

describe("private initial publication owner qualification", () => {
  it("locates the exact canonical failed record without changing its incomplete ownership decision", async () => {
    const ledger = new InMemoryRunLedger();
    ledger.finished.set("original_coding", {
      id: "original_coding",
      agent: "coding",
      channelId: "cli:local",
      userId: "cli:owner",
      threadKey: "cli:original",
      channelVisibility: "unknown",
      repo: "acme/api",
      startedAt: 1,
      finishedAt: 2,
      status: "completed",
      eventCount: 0,
      storedEventCount: 0,
      truncated: false,
      events: [],
      diagnosis: analyzeRunFriction([]),
      branchPublication: { version: 1, repo: "acme/api", branches: [], complete: false },
    });
    const store: CoordinatorInstanceStore = new InMemoryCoordinatorInstanceStore(ledger);
    const target = { repo: "acme/api", pr: 7 };
    const original = JSON.stringify([...ledger.finished]);
    const result = await store.findPullOwners(target, { diagnostic: true, qualifyRecord: true } as Parameters<
      CoordinatorInstanceStore["findPullOwners"]
    >[1]);
    expect(result).toMatchObject({
      ok: false,
      reason: "incomplete",
      qualification: {
        version: 1,
        runId: "original_coding",
        failedPredicate: "canonical_unit",
        targetDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
        ownerProjectionDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
        dependencyDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
      },
    });
    expect(await store.findPullOwners(target)).toEqual({ ok: false, reason: "incomplete" });
    expect(JSON.stringify([...ledger.finished])).toBe(original);
  });

  it.each([{}, { ...record, id: "foreign_identity" }, { ...record, repo: "other/repo" }, null])(
    "binds a canonical terminal key to malformed identity without claiming empty dependencies",
    async (identity) => {
      const current = { ...row(), record: identity };
      const diagnostics: PullOwnershipDiagnostics = { qualifyRecord: true };
      expect(
        findPullOwnersInRows(target, { complete: true, units: [], runs: [current], effects: [] }, diagnostics),
      ).toEqual({ ok: false, reason: "incomplete" });
      const snapshot = diagnostics.qualificationSnapshot!;
      expect(snapshot.runId).toBe(record.id);
      expect(snapshot.failedPredicate).toBe("record_identity");
      expect(JSON.parse(snapshot.dependencies)).toEqual({ kind: "unbound", reason: "record_identity" });
      expect((await qualifyPullOwnerSnapshot(snapshot)).runId).toBe(record.id);
      expect(
        pullOwnerQualificationSnapshot(target, { ...current, runId: "bad\nkey" }, [], "record_identity"),
      ).toBeUndefined();
      expect(pullOwnerQualificationSnapshot(target, { ...current, live: true }, [], "record_identity")).toBeUndefined();
    },
  );

  it("binds the wrapper identity separately from identical record fields", async () => {
    const matching = pullOwnerQualificationSnapshot(target, row(), [], "native_confirmation")!;
    const mismatched = pullOwnerQualificationSnapshot(target, { ...row(), repo: "other/repo" }, [], "record_identity")!;
    expect((await qualifyPullOwnerSnapshot(matching)).ownerProjectionDigest).not.toBe(
      (await qualifyPullOwnerSnapshot(mismatched)).ownerProjectionDigest,
    );
    expect(JSON.parse(mismatched.dependencies)).toEqual({ kind: "unbound", reason: "record_identity" });
  });

  it("sorts dependency permutations by deterministic code units, including case and non-ASCII metadata", async () => {
    const dependencies = ["Zed", "aardvark", "Élodie"].map((userName) => ({
      instance: { ...instance, userName },
      unit,
    }));
    expect(dependencies.every((value) => isCoordinatorInstance(value.instance) && isCoordinatorUnit(value.unit))).toBe(
      true,
    );
    const forward = pullOwnerQualificationSnapshot(target, row(), dependencies, "canonical_unit")!;
    const reverse = pullOwnerQualificationSnapshot(target, row(), dependencies.slice().reverse(), "canonical_unit")!;
    expect(forward.dependencies).toBe(reverse.dependencies);
    const canonical = JSON.parse(forward.dependencies).units.map((value: unknown) => JSON.stringify(value));
    expect(canonical).toEqual(canonical.slice().sort());
    expect((await qualifyPullOwnerSnapshot(forward)).dependencyDigest).toBe(
      (await qualifyPullOwnerSnapshot(reverse)).dependencyDigest,
    );
  });

  it("hashes captured owner and dependencies after mutation without changing the captured observation into authority", async () => {
    const ledger = new InMemoryRunLedger();
    const current = structuredClone(record);
    ledger.finished.set(current.id, current);
    const store = new InMemoryCoordinatorInstanceStore(ledger);
    const cells = store as unknown as { rows: Map<string, string>; units: Map<string, string> };
    cells.rows.set(instance.id, JSON.stringify(instance));
    cells.units.set(`${instance.id}\0${unit.unit}`, JSON.stringify(unit));
    const expected = await qualifyPullOwnerSnapshot(
      pullOwnerQualificationSnapshot(target, row(), [{ instance, unit }], "native_confirmation")!,
    );
    const pending = store.findPullOwners(target, { diagnostic: true, qualifyRecord: true });
    current.threadKey = "cli:changed";
    cells.rows.set(instance.id, JSON.stringify({ ...instance, userName: "changed" }));
    const result = await pending;
    expect(result).toEqual({ ok: false, reason: "incomplete", qualification: expected });
    const later = await store.findPullOwners(target, { diagnostic: true, qualifyRecord: true });
    expect(later.ok).toBe(false);
    if (!later.ok) expect(later.qualification!.ownerProjectionDigest).not.toBe(expected.ownerProjectionDigest);
  });

  it("omits malformed, foreign and unsupported locator payloads without creating owner credit", async () => {
    const valid = await qualifyPullOwnerSnapshot(pullOwnerQualificationSnapshot(target, row(), [], "canonical_unit")!);
    expect(pullOwnerQualificationFrom(valid, valid.targetDigest)).toEqual(valid);
    for (const patch of [
      { version: 2 },
      { runId: "bad key" },
      { failedPredicate: "private-error" },
      { targetDigest: "a".repeat(64) },
      { ownerProjectionDigest: "partial" },
      { dependencyDigest: null },
      { privateBody: "NEVER_RETURN" },
    ])
      expect(pullOwnerQualificationFrom({ ...valid, ...patch }, valid.targetDigest)).toBeUndefined();
    expect(JSON.stringify(valid)).not.toMatch(/cli:|acme\/|NEVER_RETURN|fix\/|userId|threadKey|ownerGen/);
  });

  it("keeps the established client default and anonymous read shape while requiring exact opt-in and target binding", async () => {
    const qualification = await qualifyPullOwnerSnapshot(
      pullOwnerQualificationSnapshot(target, row(), [], "canonical_unit")!,
    );
    const diagnostic = {
      version: 1,
      stage: "run_initial_coding_owner",
      cause: "validation",
      source: "runs",
      rowIndex: 0,
      rowsRead: 1,
      sourceBytes: 200,
    };
    let sent: unknown;
    let payload: unknown = qualification;
    const client = new WorkerCoordinatorInstanceStore({
      baseUrl: "https://memory.test",
      token: "fixture",
      storeKey: "runs:default",
      fetch: async (_url, init) => {
        sent = JSON.parse(String(init?.body));
        return Response.json({ ok: false, reason: "incomplete", diagnostic, qualification: payload });
      },
    });
    expect(await client.findPullOwners(target)).toEqual({ ok: false, reason: "incomplete" });
    expect(sent).toEqual({ storeKey: "runs:default", target });
    expect(await client.findPullOwners(target, { diagnostic: true })).toEqual({
      ok: false,
      reason: "incomplete",
      diagnostic,
    });
    expect(sent).toEqual({ storeKey: "runs:default", target, diagnostic: true });
    expect(await client.findPullOwners(target, { qualifyRecord: true })).toEqual({ ok: false, reason: "incomplete" });
    expect(sent).toEqual({ storeKey: "runs:default", target });
    expect(await client.findPullOwners(target, { diagnostic: true, qualifyRecord: true })).toEqual({
      ok: false,
      reason: "incomplete",
      diagnostic,
      qualification,
    });
    expect(sent).toEqual({ storeKey: "runs:default", target, diagnostic: true, qualifyRecord: true });
    for (const value of [
      undefined,
      null,
      { ...qualification, targetDigest: "f".repeat(64) },
      { ...qualification, privateBody: "NEVER_RETURN" },
      { ...qualification, failedPredicate: "unknown error" },
    ]) {
      payload = value;
      expect(await client.findPullOwners(target, { diagnostic: true, qualifyRecord: true })).toEqual({
        ok: false,
        reason: "incomplete",
        diagnostic,
      });
    }
  });

  it("keeps unavailable, invalid and success decisions free of diagnostic identity", async () => {
    const ledger = new InMemoryRunLedger();
    const store = new InMemoryCoordinatorInstanceStore(ledger);
    expect(await store.findPullOwners(target, { diagnostic: true, qualifyRecord: true })).toEqual({
      ok: true,
      owners: [],
    });
    expect(await store.findPullOwners({ repo: "invalid", pr: 7 }, { diagnostic: true, qualifyRecord: true })).toEqual({
      ok: false,
      reason: "invalid",
    });
    expect(
      await new InMemoryCoordinatorInstanceStore().findPullOwners(target, { diagnostic: true, qualifyRecord: true }),
    ).toEqual({ ok: false, reason: "unavailable" });
  });

  it("does not change refusal or default operation when observational hashing fails", async () => {
    const ledger = new InMemoryRunLedger();
    ledger.finished.set(record.id, structuredClone(record));
    const store = new InMemoryCoordinatorInstanceStore(ledger);
    const digest = vi.spyOn(crypto.subtle, "digest").mockRejectedValue(new Error("private-hash-error"));
    try {
      expect(await store.findPullOwners(target)).toEqual({ ok: false, reason: "incomplete" });
      expect(digest).not.toHaveBeenCalled();
      expect(await store.findPullOwners(target, { diagnostic: true, qualifyRecord: true })).toEqual({
        ok: false,
        reason: "incomplete",
      });
    } finally {
      digest.mockRestore();
    }
  });
});
