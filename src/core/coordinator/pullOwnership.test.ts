// Feature: docs/reference/specs/run-history.md — canonical pull ownership.
import { analyzeRunFriction } from "../runFriction.js";
import { describe, expect, it } from "vitest";
import { InMemoryCoordinatorInstanceStore, NullCoordinatorInstanceStore } from "./instanceStore.js";
import { InMemoryRunLedger } from "../runLedger/inMemory.js";
import { findPullOwnersInRows, type PullOwnershipDiagnostics } from "./pullOwnership.js";
import type { CoordinatorInstance, CoordinatorUnit } from "./contract.js";

const instance: CoordinatorInstance = {
  id: "unhosted_owner",
  kind: "ship",
  userId: "cli:owner",
  channelId: "cli:local",
  threadKey: "cli:task",
  repo: "acme/api",
  branch: "fix/task",
  base: "main",
  merge: "person",
  createdAt: 1,
};
const unit: CoordinatorUnit = {
  instanceId: instance.id,
  unit: "UOWNER",
  slug: "task",
  branch: "fix/task",
  dependsOn: [],
  rounds: [],
  pr: { number: 7, url: "https://github.com/acme/api/pull/7" },
};

describe("complete canonical pull ownership", () => {
  it("keeps an accepted pre-PR coding publication under its original unit", () => {
    const runId = "original_coding";
    const head = "b".repeat(40);
    const current: CoordinatorUnit = {
      ...unit,
      pr: undefined,
      currentEffect: {
        version: 1,
        id: `${unit.unit}/0/coding`,
        ordinal: 2,
        execution: { workflowId: instance.id },
        phase: "settled",
        target: { repo: instance.repo, ref: unit.branch, base: "main", headSha: "a".repeat(40) },
        calls: [{ operation: "spawn", state: "accepted", runId }],
      },
    };
    const record = {
      id: runId,
      agent: "coding",
      status: "completed",
      repo: instance.repo,
      userId: instance.userId,
      channelId: instance.channelId,
      threadKey: instance.threadKey,
      parentInstanceId: instance.id,
      coordinatorUnit: unit.unit,
      coordinatorAttempt: 0,
      idempotencyKey: `${instance.id}:${unit.unit}/0/coding`,
      publicationSettlement: {
        version: 1,
        binding: {
          runId,
          instanceId: instance.id,
          step: `${instance.id}:${unit.unit}/0/coding`,
          repo: instance.repo,
          branch: unit.branch,
          requester: instance.userId,
          threadKey: instance.threadKey,
          generation: "g1",
        },
        checkpoint: { kind: "created", head },
        publication: { kind: "accepted", head },
        preservation: { kind: "pending" },
        release: { kind: "pending" },
      },
    };
    const publication = { version: 1, repo: instance.repo, branches: [], complete: false };
    const run = {
      runId,
      repo: instance.repo,
      live: false,
      publication,
      record,
      pushReceipts: [{ ref: unit.branch, sha: head, by: "push" }],
    };
    const rows = { complete: true, units: [{ instance, unit: current }], runs: [run], effects: [] };
    const expected = { ok: true, owners: [{ kind: "unit", instanceId: instance.id, unit: unit.unit }] };
    expect(findPullOwnersInRows({ repo: instance.repo, ref: unit.branch }, rows)).toEqual(expected);
    const publish = {
      ...current,
      currentEffect: {
        ...current.currentEffect!,
        id: `${unit.unit}/0/coding/pr-check`,
        ordinal: 3,
        phase: "active" as const,
        target: { ...current.currentEffect!.target, headSha: head },
        calls: [{ operation: "pull_create" as const, state: "unstarted" as const }],
      },
    };
    expect(
      findPullOwnersInRows(
        { repo: instance.repo, ref: unit.branch },
        { ...rows, units: [{ instance, unit: publish }] },
      ),
    ).toEqual(expected);
    const mapped = {
      ...publish,
      pr: unit.pr,
      publication: {
        repo: instance.repo,
        pr: 7,
        headRef: unit.branch,
        publicationRef: unit.branch,
        baseRef: "main",
        expectedHeadSha: head,
        owner: { instanceId: instance.id, unit: unit.unit },
      },
      currentEffect: {
        ...publish.currentEffect,
        id: `${unit.unit}/1/review`,
        target: { ...publish.currentEffect.target, pr: 7 },
        calls: [{ operation: "spawn" as const, state: "accepted" as const, runId: "next_review" }],
      },
    };
    expect(
      findPullOwnersInRows({ repo: instance.repo, pr: 7 }, { ...rows, units: [{ instance, unit: mapped }] }),
    ).toEqual(expected);
    const ended: CoordinatorUnit = {
      ...mapped,
      currentEffect: { ...mapped.currentEffect, phase: "settled" },
      ending: {
        kind: "refused",
        report: "ended",
        at: 2,
        outcome: { schemaVersion: 1, kind: "refused", reviewRounds: 0 },
      },
    };
    expect(
      findPullOwnersInRows({ repo: instance.repo, ref: unit.branch }, { ...rows, units: [{ instance, unit: ended }] }),
    ).toEqual({ ok: true, owners: [] });
    const actionId = `r_${"d".repeat(64)}`;
    const recovering: CoordinatorUnit = {
      ...current,
      history: { version: 1, receiptId: "rc_claim" },
      recovery: {
        kind: "coding",
        round: 0,
        actionId,
        workflowId: `recovery-${actionId}`,
        expectedHeadSha: head,
        remainingMs: 1000,
        claimedAt: 2,
        deadlineAt: 1002,
        step: `${unit.unit}/recovery/${actionId}/0/coding`,
        codingRunId: runId,
        codingKey: record.idempotencyKey,
        previousEnding: { kind: "failed", report: "PR creation refused", at: 1 },
        accounting: {
          spendUsd: 0,
          children: [{ runId, key: record.idempotencyKey, usd: 0 }],
          grant: { renewals: 0 },
          renewalsSpent: 0,
        },
      },
    };
    expect(
      findPullOwnersInRows(
        { repo: instance.repo, ref: unit.branch },
        { ...rows, units: [{ instance, unit: recovering }] },
      ),
    ).toEqual({ ok: true, owners: [{ kind: "unit", instanceId: instance.id, unit: unit.unit, actionId }] });
    // Lookup does not rewrite private publication or release evidence.
    expect(run.publication).toEqual(publication);
    expect(record.publicationSettlement.release).toEqual({ kind: "pending" });
    expect(findPullOwnersInRows({ repo: "other/repo", pr: 7 }, rows)).toEqual({ ok: true, owners: [] });
    for (const altered of [
      { record: { ...record, userId: "cli:stranger" } },
      { record: { ...record, coordinatorAttempt: 1 } },
      { record: { ...record, agent: "review" } },
      { record: { ...record, provisional: true } },
      { pushReceipts: [{ ref: "fix/other", sha: head, by: "push" }] },
      { pushReceipts: [{ ref: unit.branch, sha: "c".repeat(40), by: "push" }] },
      {
        door: {
          id: "unknown",
          repo: instance.repo,
          update: { ref: `refs/heads/${unit.branch}`, old: "a".repeat(40), next: head },
        },
      },
      { publication: { ...publication, targets: [{ pr: 9, headSha: head }] } },
    ]) {
      expect(
        findPullOwnersInRows({ repo: instance.repo, ref: unit.branch }, { ...rows, runs: [{ ...run, ...altered }] }),
      ).toEqual({ ok: false, reason: "incomplete" });
    }
    expect(findPullOwnersInRows({ repo: instance.repo, ref: unit.branch }, { ...rows, units: [] })).toEqual({
      ok: false,
      reason: "incomplete",
    });
  });
  it("retains the canonical target for a pending original report without making its envelope a new owner", () => {
    const effect = {
      id: `coordinator-reconcile:${"a".repeat(64)}`,
      kind: "coordinator_reconcile",
      instanceId: instance.id,
      unit: unit.unit,
      workflowId: instance.id,
      admissionHash: "b".repeat(64),
    };
    const rows = { complete: true, units: [{ instance, unit }], runs: [], effects: [effect] };
    expect(findPullOwnersInRows({ repo: instance.repo, pr: 7 }, rows)).toEqual({
      ok: true,
      owners: [{ kind: "unit", instanceId: instance.id, unit: unit.unit }],
    });
    expect(findPullOwnersInRows({ repo: "other/repo", pr: 7 }, rows)).toEqual({ ok: true, owners: [] });
    expect(findPullOwnersInRows({ repo: instance.repo, pr: 7 }, { ...rows, units: [] })).toEqual({
      ok: false,
      reason: "incomplete",
    });
  });
  it("keeps the original start fence through delayed whole-row and wake writes", async () => {
    const store = new InMemoryCoordinatorInstanceStore(new InMemoryRunLedger());
    await store.put(instance);
    const queued = { ...unit, pr: undefined };
    const started = { ...queued, startedAt: 1 };
    expect(await store.putUnits([started])).toEqual({ ok: true });
    await store.appendEvent(started, { sender: instance.userId, text: "keep me", mode: "wake", at: 2 });
    await expect(store.putUnits([queued])).rejects.toThrow("coordinator unit");
    await expect(store.answerWake(queued, "wait/1", { kind: "answered", reply: "go" }, [1], "wake")).rejects.toThrow(
      "coordinator unit",
    );
    expect(await store.compareAndReplaceUnit(started, queued)).toEqual({ ok: false, reason: "stale" });
    expect(await store.listUnits(instance.id)).toEqual([started]);
    expect(await store.listEvents(started, true)).toEqual([expect.objectContaining({ text: "keep me" })]);
    const rival = { ...queued, unit: "RIVAL" };
    expect(await store.putUnits([rival])).toEqual({ ok: true });
    expect(await store.putUnits([{ ...rival, startedAt: 3 }])).toEqual({ ok: false, reason: "owned" });
    expect(await store.listUnits(instance.id)).toEqual([started, rival]);
  });
  it("serializes the whole batch before committing any ordinary draft", async () => {
    const store = new InMemoryCoordinatorInstanceStore(new InMemoryRunLedger());
    await store.put(instance);
    const first = { ...unit, pr: undefined };
    const corrupt = { ...first, unit: "CORRUPT", branch: "fix/corrupt" } as CoordinatorUnit & { circular?: unknown };
    corrupt.circular = corrupt;
    await expect(store.putUnits([first, corrupt])).rejects.toThrow();
    expect(await store.listUnits(instance.id)).toEqual([]);
  });
  it("refuses a conflicting first Main task claim without recording any link or instance", async () => {
    const store = new InMemoryCoordinatorInstanceStore(new InMemoryRunLedger());
    await store.put(instance);
    await store.putUnits([unit]);
    const main = {
      ...instance,
      id: "main_task_claim",
      userId: "slack:UOWNER",
      channelId: "slack:C1",
      threadKey: "slack:C1:1.0",
      branch: "fix/main",
      plan: { id: "main" },
    };
    const key = { mainThreadKey: main.threadKey, actId: "act" };
    const authority = { requesterId: main.userId, sourceMessageId: "1", revision: 1, repo: main.repo };
    await store.recordRequesterTurn({ threadKey: main.threadKey, requesterId: main.userId, messageId: "1" });
    const task: CoordinatorUnit = {
      ...unit,
      instanceId: main.id,
      unit: ["U", "1"].join(""),
      branch: main.branch,
      workBrief: {
        requesterId: main.userId,
        ...key,
        repo: main.repo,
        base: main.base!,
        question: "What failed?",
        findings: [],
        requestedChange: "Fix it",
      },
    };
    expect(await store.claimMainTask(key, main, task, authority)).toEqual({ ok: false, reason: "owned" });
    expect(await store.getMainTask(key)).toBeNull();
    expect(await store.get(main.id)).toBeNull();
    expect(await store.listUnits(main.id)).toEqual([]);
    const corrupt = { ...task, pr: undefined } as CoordinatorUnit & { circular?: unknown };
    corrupt.circular = corrupt;
    await expect(store.claimMainTask(key, main, corrupt, authority)).rejects.toThrow();
    expect(await store.getMainTask(key)).toBeNull();
    expect(await store.get(main.id)).toBeNull();
    expect(await store.listUnits(main.id)).toEqual([]);
  });
  it("fences ordinary batch and wake binding writes before any mutation", async () => {
    const store = new InMemoryCoordinatorInstanceStore(new InMemoryRunLedger());
    await store.put(instance);
    const draft = { ...unit, unit: "DRAFT", branch: "fix/draft", pr: undefined };
    const untouched = { ...draft, unit: "UNTOUCHED", branch: "fix/untouched" };
    await store.putUnits([unit, draft]);
    await store.appendEvent(draft, { sender: instance.userId, text: "keep me", mode: "wake", at: 2 });
    expect(await store.putUnits([untouched, { ...draft, pr: unit.pr }])).toEqual({ ok: false, reason: "owned" });
    expect(await store.listUnits(instance.id)).toEqual([unit, draft]);
    expect(
      await store.answerWake({ ...draft, pr: unit.pr }, "wait/1", { kind: "answered", reply: "go" }, [1], "wake"),
    ).toEqual({ ok: false, reason: "owned" });
    expect(await store.listUnits(instance.id)).toEqual([unit, draft]);
    expect(await store.listEvents(draft, true)).toEqual([expect.objectContaining({ text: "keep me" })]);
    const pr8 = { number: 8, url: "https://github.com/acme/api/pull/8" };
    expect(
      await store.putUnits([
        { ...draft, unit: "FIRST", branch: "fix/first", pr: pr8 },
        { ...draft, unit: "SECOND", branch: "fix/second", pr: pr8 },
      ]),
    ).toEqual({ ok: false, reason: "owned" });
    expect(await store.listUnits(instance.id)).toEqual([unit, draft]);
    const unavailable = new InMemoryCoordinatorInstanceStore();
    await unavailable.put(instance);
    expect(await unavailable.putUnits([unit])).toEqual({ ok: false, reason: "unavailable" });
    expect(await unavailable.listUnits(instance.id)).toEqual([]);
  });
  it("does not let a completed adoption admit unrelated targets under stop", async () => {
    const store = new InMemoryCoordinatorInstanceStore(new InMemoryRunLedger());
    await store.put(instance);
    const bound: CoordinatorUnit = {
      ...unit,
      adoption: {
        version: 1,
        actionId: "adopt",
        runId: "writer",
        headSha: "a".repeat(40),
        requester: instance.userId,
        threadKey: instance.threadKey,
        messageId: "cli:message",
        claimedAt: 1,
        state: "bound",
        pr: unit.pr,
      },
    };
    (store as unknown as { units: Map<string, string> }).units.set(
      `${instance.id}\0${unit.unit}`,
      JSON.stringify(bound),
    );
    await store.markStopped(instance.id, 2);
    expect(await store.compareAndReplaceUnit(bound, { ...bound, resume: { pr: 8 } })).toEqual({
      ok: false,
      reason: "stale",
    });
    expect(await store.listUnits(instance.id)).toEqual([bound]);
  });
  it("reserves a new PR binding atomically against every canonical owner", async () => {
    const ledger = new InMemoryRunLedger();
    const store = new InMemoryCoordinatorInstanceStore(ledger);
    await store.put(instance);
    const draft = { ...unit, pr: undefined };
    const other = { ...unit, unit: "OTHER", branch: "fix/other" };
    await store.putUnits([draft, other]);
    expect(await store.compareAndReplaceUnit(draft, unit)).toEqual({ ok: false, reason: "owned" });
    expect(await store.listUnits(instance.id)).toEqual([draft, other]);
    await store.putUnits([{ ...other, ending: { kind: "interrupted", report: "unknown", at: 2 } }]);
    expect(await store.compareAndReplaceUnit(draft, unit)).toEqual({ ok: false, reason: "owned" });
    (store as unknown as { units: Map<string, string> }).units.delete(`${instance.id}\0OTHER`);
    expect(await store.compareAndReplaceUnit(draft, unit)).toEqual({ ok: true });
    const raceA = { ...unit, unit: "RACE_A", branch: "fix/race-a", pr: undefined };
    const raceB = { ...unit, unit: "RACE_B", branch: "fix/race-b", pr: undefined };
    await store.putUnits([raceA, raceB]);
    const pr8 = { number: 8, url: "https://github.com/acme/api/pull/8" };
    const attempts = await Promise.all([
      store.compareAndReplaceUnit(raceA, { ...raceA, pr: pr8 }),
      store.compareAndReplaceUnit(raceB, { ...raceB, pr: pr8 }),
    ]);
    expect(attempts).toEqual([{ ok: true }, { ok: false, reason: "owned" }]);
    const unpaired = new InMemoryCoordinatorInstanceStore();
    await unpaired.put(instance);
    await unpaired.putUnits([draft]);
    expect(await unpaired.compareAndReplaceUnit(draft, unit)).toEqual({ ok: false, reason: "unavailable" });
    expect(await unpaired.putUnits([unit])).toEqual({ ok: false, reason: "unavailable" });
    (unpaired as unknown as { units: Map<string, string> }).units.set(
      `${instance.id}\0${unit.unit}`,
      JSON.stringify(unit),
    );
    expect(
      await unpaired.compareAndReplaceUnit(unit, {
        ...unit,
        pr: { ...unit.pr!, url: "https://github.com/acme/api/pull/7?display=1" },
      }),
    ).toEqual({ ok: true });
    const terminal: CoordinatorUnit = {
      ...draft,
      unit: "SETTLED",
      branch: "fix/settled",
      ending: {
        kind: "refused",
        report: "ended",
        at: 2,
        outcome: { schemaVersion: 1, kind: "refused", reviewRounds: 0 },
      },
    };
    await store.putUnits([terminal]);
    expect(
      await store.compareAndReplaceUnit(terminal, {
        ...terminal,
        pr: { number: 9, url: "https://github.com/acme/api/pull/9" },
      }),
    ).toEqual({ ok: false, reason: "stale" });
    const publication = {
      repo: instance.repo,
      pr: 7,
      headRef: unit.branch,
      publicationRef: unit.branch,
      baseRef: "main",
      expectedHeadSha: "a".repeat(40),
      owner: { instanceId: instance.id, unit: unit.unit },
    };
    for (const binding of [
      { ...publication, repo: "other/repo" },
      { ...publication, owner: { instanceId: "foreign", unit: unit.unit } },
    ]) {
      expect(await store.compareAndReplaceUnit(unit, { ...unit, publication: binding })).toEqual({
        ok: false,
        reason: "incomplete",
      });
    }
    expect(
      await store.compareAndReplaceUnit(unit, { ...unit, publication: { ...publication, headRef: "fix/alias" } }),
    ).toEqual({ ok: true });
    const alias = { ...draft, unit: "ALIAS", branch: "fix/alias" };
    await store.putUnits([alias]);
    expect(
      await store.compareAndReplaceUnit(alias, {
        ...alias,
        pr: { number: 10, url: "https://github.com/acme/api/pull/10" },
      }),
    ).toEqual({ ok: false, reason: "owned" });
  });
  it("refuses absence without the paired run owner", async () => {
    const store = new InMemoryCoordinatorInstanceStore();
    expect(await store.findPullOwners({ repo: "acme/api", pr: 7 })).toEqual({ ok: false, reason: "unavailable" });
    expect(await new NullCoordinatorInstanceStore().findPullOwners({ repo: "acme/api", pr: 7 })).toEqual({
      ok: false,
      reason: "unavailable",
    });
  });
  it("reads unhosted units and legacy endings independently of live hosted listings", async () => {
    const store = new InMemoryCoordinatorInstanceStore(new InMemoryRunLedger());
    await store.put(instance);
    await store.putUnits([unit]);
    expect(await store.findPullOwners({ repo: "ACME/API", pr: 7 })).toEqual({
      ok: true,
      owners: [{ kind: "unit", instanceId: instance.id, unit: "UOWNER" }],
    });
    await store.putUnits([{ ...unit, ending: { kind: "interrupted", report: "unknown effect", at: 2 } }]);
    expect(await store.findPullOwners({ repo: "acme/api", ref: "fix/task" })).toEqual({
      ok: true,
      owners: [{ kind: "unit", instanceId: instance.id, unit: "UOWNER" }],
    });
    expect(await store.findPullOwners({ repo: "other/repo", pr: 7 })).toEqual({ ok: true, owners: [] });
  });
  it("protects terminal direct intent without manufacturing unit lineage", async () => {
    const ledger = new InMemoryRunLedger();
    const store = new InMemoryCoordinatorInstanceStore(ledger);
    ledger.finished.set("direct", {
      id: "direct",
      channelId: "cli:local",
      userId: "cli:owner",
      threadKey: "cli:direct",
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
        pending: { id: "call", pr: 7, headSha: "a".repeat(40) },
      },
    });
    expect(await store.findPullOwners({ repo: "acme/api", pr: 7 })).toEqual({
      ok: true,
      owners: [{ kind: "run", runId: "direct" }],
    });
    ledger.finished.get("direct")!.branchPublication = { version: 1, repo: "acme/api", branches: [], complete: false };
    expect(await store.findPullOwners({ repo: "acme/api", pr: 8 })).toEqual({ ok: false, reason: "incomplete" });
  });
  it("retains malformed terminal producer evidence in the existing ledger owner", async () => {
    const ledger = new InMemoryRunLedger(() => 1);
    const store = new InMemoryCoordinatorInstanceStore(ledger);
    expect(
      await ledger.claim({
        runId: "corrupt",
        threadKey: "cli:corrupt",
        gen: "g1",
        leaseMs: 1000,
        startedAt: 1,
        meta: { channelId: "cli:local", userId: "cli:owner", threadKey: "cli:corrupt", repo: "acme/api" },
        card: null,
        system: "",
        tools: [],
        state: { branchPublication: null },
      }),
    ).toMatchObject({ ok: true });
    expect(
      await ledger.finish("corrupt", "g1", {
        id: "corrupt",
        channelId: "cli:local",
        userId: "cli:owner",
        threadKey: "cli:corrupt",
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
      }),
    ).toMatchObject({ ok: true });
    expect(ledger.finished.get("corrupt")?.branchPublication).toBeUndefined();
    expect(await store.findPullOwners({ repo: "acme/api", pr: 7 })).toEqual({ ok: false, reason: "incomplete" });
  });
  it("refuses a foreign instance carrying a publication for the queried repository", async () => {
    const store = new InMemoryCoordinatorInstanceStore(new InMemoryRunLedger());
    await store.put({ ...instance, repo: "other/repo" });
    const corrupt: CoordinatorUnit = {
      ...unit,
      publication: {
        repo: "acme/api",
        pr: 7,
        headRef: "fix/task",
        publicationRef: "fix/task",
        baseRef: "main",
        expectedHeadSha: "a".repeat(40),
        owner: { instanceId: instance.id, unit: unit.unit },
      },
    };
    expect(await store.putUnits([corrupt])).toEqual({ ok: false, reason: "incomplete" });
    (store as unknown as { units: Map<string, string> }).units.set(
      `${instance.id}\0${unit.unit}`,
      JSON.stringify(corrupt),
    );
    expect(await store.findPullOwners({ repo: "acme/api", pr: 7 })).toEqual({ ok: false, reason: "incomplete" });
  });
  it("holds live accepted metadata targets then releases only after confirmed terminal settlement", async () => {
    const ledger = new InMemoryRunLedger(() => 1);
    const store = new InMemoryCoordinatorInstanceStore(ledger);
    const publication = {
      version: 1 as const,
      repo: "acme/api",
      branches: [],
      complete: true,
      targets: [{ pr: 7, headSha: "a".repeat(40) }],
    };
    expect(
      await ledger.claim({
        runId: "metadata",
        threadKey: "cli:metadata",
        gen: "g1",
        leaseMs: 1000,
        startedAt: 1,
        meta: { channelId: "cli:local", userId: "cli:owner", threadKey: "cli:metadata", repo: "acme/api" },
        card: null,
        system: "",
        tools: [],
        state: { branchPublication: publication },
      }),
    ).toMatchObject({ ok: true });
    expect(await store.findPullOwners({ repo: "acme/api", pr: 7 })).toEqual({
      ok: true,
      owners: [{ kind: "run", runId: "metadata" }],
    });
    expect(
      await ledger.finish("metadata", "g1", {
        id: "metadata",
        channelId: "cli:local",
        userId: "cli:owner",
        threadKey: "cli:metadata",
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
      }),
    ).toMatchObject({ ok: true });
    expect(await store.findPullOwners({ repo: "acme/api", pr: 7 })).toEqual({ ok: true, owners: [] });
  });
  it("matches full Door branch refs and refuses unknown producer repositories or incomplete scans", () => {
    const door = {
      id: "call",
      repo: "acme/api",
      update: { ref: "refs/heads/fix/task", old: "a".repeat(40), next: "b".repeat(40) },
    };
    const rows = { complete: true, units: [], runs: [{ runId: "direct", live: false, door }], effects: [] };
    expect(findPullOwnersInRows({ repo: "acme/api", ref: "fix/task" }, rows)).toEqual({
      ok: true,
      owners: [{ kind: "run", runId: "direct" }],
    });
    expect(findPullOwnersInRows({ repo: "acme/api", ref: "refs/heads/fix/task" }, rows)).toEqual({
      ok: true,
      owners: [{ kind: "run", runId: "direct" }],
    });
    expect(findPullOwnersInRows({ repo: "acme/api", pr: 7 }, { ...rows, complete: false })).toEqual({
      ok: false,
      reason: "incomplete",
    });
    expect(
      findPullOwnersInRows(
        { repo: "acme/api", pr: 7 },
        { ...rows, runs: [{ runId: "direct", live: false, door: { ...door, repo: "" } }] },
      ),
    ).toEqual({ ok: false, reason: "incomplete" });
    expect(
      findPullOwnersInRows(
        { repo: "acme/api", pr: 7 },
        { ...rows, runs: [], effects: [{ id: "retitle", kind: "retitle", repo: "unknown", number: 7 }] },
      ),
    ).toEqual({ ok: false, reason: "incomplete" });
    expect(
      findPullOwnersInRows(
        { repo: "acme/api", pr: 7 },
        {
          ...rows,
          runs: [{ runId: "direct", live: false, publication: { version: 1, branches: [], complete: false } }],
        },
      ),
    ).toEqual({ ok: false, reason: "incomplete" });
  });
  it("refuses malformed live metadata before interpreting empty state as absence", async () => {
    const ledger = new InMemoryRunLedger(() => 1);
    const store = new InMemoryCoordinatorInstanceStore(ledger);
    await ledger.claim({
      runId: "live",
      threadKey: "cli:live",
      gen: "g1",
      leaseMs: 1000,
      startedAt: 1,
      meta: { channelId: "cli:local", userId: "cli:owner", threadKey: "cli:live" },
      card: null,
      system: "",
      tools: [],
      state: {},
    });
    expect(await store.findPullOwners({ repo: "acme/api", pr: 7 })).toEqual({ ok: true, owners: [] });
    for (const meta of [[], 7, {}]) {
      ledger.live.get("live")!.meta = meta as never;
      expect(await store.findPullOwners({ repo: "acme/api", pr: 7 })).toEqual({ ok: false, reason: "incomplete" });
    }
  });
  it("retains pending workspace publication after historical history removal and rejects malformed unit PR numbers", () => {
    const rows = {
      complete: true,
      units: [],
      runs: [],
      effects: [],
      settlements: [
        {
          version: 1,
          revision: 1,
          owner: { runId: "resident", ownerGen: "g1", ownerFence: 7 },
          binding: null,
          record: {
            id: "resident",
            threadKey: "cli:resident",
            status: "completed",
            userId: "cli:owner",
            repo: "acme/api",
          },
          publication: {
            version: 1,
            repo: "acme/api",
            complete: false,
            branches: [],
            pending: { id: "call", pr: 7, headSha: "a".repeat(40) },
          },
        },
      ],
    };
    expect(findPullOwnersInRows({ repo: "acme/api", pr: 7 }, rows)).toEqual({
      ok: true,
      owners: [{ kind: "run", runId: "resident" }],
    });
    rows.settlements[0]!.publication = {
      ...rows.settlements[0]!.publication,
      targets: [{ pr: 6, headSha: "a".repeat(40) }],
    } as (typeof rows.settlements)[0]["publication"];
    expect(findPullOwnersInRows({ repo: "acme/api", pr: 6 }, rows)).toEqual({
      ok: true,
      owners: [{ kind: "run", runId: "resident" }],
    });
    for (const number of [0, -1, 7.5, Number.MAX_SAFE_INTEGER + 1]) {
      expect(
        findPullOwnersInRows(
          { repo: "acme/api", pr: 7 },
          {
            ...rows,
            settlements: [],
            units: [{ instance, unit: { ...unit, pr: { number, url: "https://github.com/acme/api/pull/7" } } }],
          },
        ),
      ).toEqual({ ok: false, reason: "incomplete" });
      expect(
        findPullOwnersInRows(
          { repo: "acme/api", pr: 7 },
          { ...rows, settlements: [], units: [{ instance, unit: { ...unit, resume: { pr: number } } }] },
        ),
      ).toEqual({ ok: false, reason: "incomplete" });
    }
  });
  it("refuses unreadable canonical unit facts and invalid targets", async () => {
    const store = new InMemoryCoordinatorInstanceStore(new InMemoryRunLedger());
    await store.put(instance);
    (store as unknown as { units: Map<string, string> }).units.set(`${instance.id}\0UOWNER`, "{");
    expect(await store.findPullOwners({ repo: "acme/api", pr: 7 })).toEqual({ ok: false, reason: "incomplete" });
    expect(await store.findPullOwners({ repo: "acme/api" })).toEqual({ ok: false, reason: "invalid" });
  });
});

describe("pull ownership refusal diagnostics", () => {
  it("identifies the failing row shape without exposing its contents or changing refusal", () => {
    const diagnostics: PullOwnershipDiagnostics = {};
    const rows = {
      complete: true,
      units: [{ instance, unit: { privateText: "secret-fixture" } }],
      runs: [],
      effects: [],
    };
    expect(findPullOwnersInRows({ repo: instance.repo, pr: 7 }, rows, diagnostics)).toEqual({
      ok: false,
      reason: "incomplete",
    });
    expect(diagnostics.failure).toEqual({ check: "unit_shape", source: "units", rowIndex: 0 });
    expect(JSON.stringify(diagnostics)).not.toContain("secret-fixture");
  });
  it("distinguishes a malformed publication from an incomplete inventory", () => {
    const diagnostics: PullOwnershipDiagnostics = {};
    expect(
      findPullOwnersInRows(
        { repo: instance.repo, pr: 7 },
        {
          complete: true,
          units: [],
          effects: [],
          runs: [{ runId: "producer", live: false, publication: { privateText: "secret-fixture" } }],
        },
        diagnostics,
      ),
    ).toEqual({ ok: false, reason: "incomplete" });
    expect(diagnostics.failure).toEqual({ check: "run_publication", source: "runs", rowIndex: 0 });
    const inventory: PullOwnershipDiagnostics = {};
    expect(
      findPullOwnersInRows(
        { repo: instance.repo, pr: 7 },
        { complete: false, units: [], runs: [], effects: [] },
        inventory,
      ),
    ).toEqual({ ok: false, reason: "incomplete" });
    expect(inventory.failure).toEqual({ check: "inventory_incomplete" });
  });
  it("leaves successful ownership reads and their diagnostic sink unchanged", () => {
    const diagnostics: PullOwnershipDiagnostics = {};
    expect(
      findPullOwnersInRows(
        { repo: instance.repo, pr: 7 },
        { complete: true, units: [{ instance, unit }], runs: [], effects: [] },
        diagnostics,
      ),
    ).toEqual({ ok: true, owners: [{ kind: "unit", instanceId: instance.id, unit: unit.unit }] });
    expect(diagnostics).toEqual({});
  });
});
