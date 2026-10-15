import { describe, expect, it } from "vitest";
import { AGENTS } from "../../agents/registry.js";
import { analyzeRunFriction } from "../runFriction.js";
import { runReviewPostStep } from "../reviewRound.js";
import { InMemoryRunLedger } from "../runLedger/inMemory.js";
import type { RunRecord } from "../runRecord.js";
import type { ReviewPublicationReceipt } from "../reviewPublication.js";
import { InMemoryCoordinatorInstanceStore } from "./instanceStore.js";
import type { CoordinatorInstance, CoordinatorUnit } from "./contract.js";
import { seedCoordinatorUnit } from "../testing/coordinatorInstance.js";

const original = "a".repeat(40),
  posted = "b".repeat(40);
const runId = "managed_review";
const instance: CoordinatorInstance = {
  id: "managed_work",
  kind: "ship",
  userId: "cli:owner",
  channelId: "cli:local",
  threadKey: "cli:local:work",
  repo: "acme/api",
  branch: "fix/work",
  base: "main",
  createdAt: 1,
};
const row: CoordinatorUnit = {
  instanceId: instance.id,
  unit: "ONE",
  slug: "work",
  branch: instance.branch,
  dependsOn: [],
  rounds: [],
  threadKey: instance.threadKey,
  pr: { number: 7, url: "https://github.com/acme/api/pull/7" },
  publication: {
    repo: instance.repo,
    pr: 7,
    headRef: instance.branch,
    baseRef: "main",
    publicationRef: instance.branch,
    expectedHeadSha: original,
    owner: { instanceId: instance.id, unit: "ONE" },
  },
  currentEffect: {
    version: 1,
    id: "ONE/1/review",
    ordinal: 1,
    execution: { workflowId: instance.id },
    phase: "active",
    target: { repo: instance.repo, ref: instance.branch, base: "main", pr: 7, headSha: original },
    calls: [{ operation: "spawn", state: "accepted", runId }],
  },
};
const meta = {
  agent: "review",
  channelId: instance.channelId,
  userId: instance.userId,
  threadKey: instance.threadKey,
  repo: instance.repo,
  parentInstanceId: instance.id,
  coordinatorUnit: row.unit,
  idempotencyKey: `${instance.id}:ONE/1/review`,
  pr: 7,
};
const receipt: ReviewPublicationReceipt = {
  version: 1,
  runId,
  target: { repo: instance.repo, number: 7, commitId: posted },
  bodyHash: "c".repeat(64),
  state: "uncertain",
};
const ending: NonNullable<CoordinatorUnit["ending"]> = {
  kind: "aborted",
  report: "Publication remains unconfirmed",
  at: 2,
  outcome: { schemaVersion: 1, kind: "aborted", reviewRounds: 1 },
};
function terminal(): RunRecord {
  return {
    ...meta,
    id: runId,
    pr: undefined,
    targetPr: 7,
    headSha: original,
    channelVisibility: "unknown",
    startedAt: 1,
    finishedAt: 2,
    status: "completed",
    eventCount: 0,
    storedEventCount: 0,
    truncated: false,
    events: [],
    diagnosis: analyzeRunFriction([]),
  };
}
async function fixture(state: ReviewPublicationReceipt["state"] | null = "uncertain") {
  const ledger = new InMemoryRunLedger(() => 1);
  const store = new InMemoryCoordinatorInstanceStore(ledger);
  expect(await store.put(instance)).toEqual({ ok: true });
  // The admitted original spawn is retained input, not a new effect grant.
  seedCoordinatorUnit(store, row);
  expect(
    await ledger.claim({
      runId,
      threadKey: instance.threadKey,
      gen: "g1",
      leaseMs: 30_000,
      startedAt: 1,
      meta,
      card: null,
      system: "",
      tools: [],
      state: state === null ? {} : { reviewPublication: { ...receipt, state } },
    }),
  ).toMatchObject({ ok: true });
  return { ledger, store };
}

describe("managed review publication ownership", () => {
  it("retains a legacy unit's review obligation without granting publication authority", async () => {
    const { ledger, store } = await fixture();
    const legacy = { ...row, publication: undefined, currentEffect: undefined, ending };
    seedCoordinatorUnit(store, legacy);
    expect(await ledger.finish(runId, "g1", terminal())).toEqual({ ok: true, stored: true });
    expect(await store.findPullOwners({ repo: instance.repo, pr: 7 })).toEqual({
      ok: true,
      owners: [{ kind: "run", runId }],
    });
    expect(await store.findPullOwners({ repo: instance.repo, ref: instance.branch })).toEqual({
      ok: true,
      owners: [{ kind: "run", runId }],
    });
    expect(await store.listUnits(instance.id)).toEqual([legacy]);
    expect((await store.listUnits(instance.id))[0]?.publication).toBeUndefined();
  });

  it.each(["actor", "unit", "publication repo"] as const)(
    "refuses a retained review attributed to a different original %s",
    async (kind) => {
      const { ledger, store } = await fixture();
      const legacy = {
        ...row,
        publication: kind === "publication repo" ? { ...row.publication!, repo: "other/api" } : undefined,
        currentEffect: undefined,
        ending,
      };
      seedCoordinatorUnit(store, legacy);
      const foreign = {
        ...meta,
        ...(kind === "actor"
          ? { userId: "cli:other" }
          : kind === "unit"
            ? { coordinatorUnit: "OTHER", idempotencyKey: `${instance.id}:OTHER/1/review` }
            : {}),
      };
      ledger.live.get(runId)!.meta = foreign;
      expect(await ledger.finish(runId, "g1", { ...terminal(), ...foreign, pr: undefined })).toEqual({
        ok: true,
        stored: true,
      });
      expect(await store.findPullOwners({ repo: instance.repo, pr: 7 })).toEqual({ ok: false, reason: "incomplete" });
      expect(await store.listUnits(instance.id)).toEqual([legacy]);
    },
  );

  it("does not turn an independent manual review or display-only failure into a shared PR claim", async () => {
    for (const kind of ["manual", "display"] as const) {
      const { ledger, store } = await fixture(kind === "display" ? null : "uncertain");
      const live = ledger.live.get(runId)!;
      if (kind === "manual") {
        // An independently admitted review has no managed unit lineage.
        live.meta = {
          ...live.meta,
          parentInstanceId: undefined,
          coordinatorUnit: undefined,
          idempotencyKey: undefined,
        };
      }
      const ended = { ...row, currentEffect: undefined, ending };
      seedCoordinatorUnit(store, ended);
      const record = terminal();
      if (kind === "manual") {
        record.parentInstanceId = undefined;
        record.coordinatorUnit = undefined;
        record.idempotencyKey = undefined;
      } else record.reviewPost = { posted: false, uncertain: true, reason: "Unverified display" };
      expect(await ledger.finish(runId, "g1", record)).toEqual({ ok: true, stored: true });
      expect(await store.findPullOwners({ repo: instance.repo, pr: 7 })).toEqual({ ok: true, owners: [] });
      expect(
        await store.putUnits([
          {
            ...ended,
            unit: "NEW",
            ending: undefined,
            publication: { ...ended.publication!, owner: { instanceId: instance.id, unit: "NEW" } },
          },
        ]),
      ).toEqual({ ok: true });
    }
  });

  it("invalidates cached absence when the retained canonical review source changes", async () => {
    const { ledger, store } = await fixture("refused");
    seedCoordinatorUnit(store, { ...row, currentEffect: undefined, ending });
    expect(await ledger.finish(runId, "g1", terminal())).toEqual({ ok: true, stored: true });
    expect(await store.findPullOwners({ repo: instance.repo, pr: 7 })).toEqual({ ok: true, owners: [] });
    // Adversarial retained source replacement tests the derived candidate cache;
    // this is not permission to change a sealed publication journal.
    ledger.finished.get(runId)!.reviewPublication = receipt;
    expect(await store.findPullOwners({ repo: instance.repo, ref: instance.branch })).toEqual({
      ok: true,
      owners: [{ kind: "run", runId }],
    });
    expect(await store.findPullOwners({ repo: instance.repo, pr: 8 })).toEqual({ ok: true, owners: [] });
  });

  it("keeps malformed managed receipts unreadable before target filtering", async () => {
    const { ledger, store } = await fixture();
    const malformed = { ...receipt, bodyHash: "invalid" };
    expect(await ledger.setState(runId, "g1", { reviewPublication: malformed })).toEqual({ ok: true });
    seedCoordinatorUnit(store, { ...row, currentEffect: undefined, ending });
    expect(await ledger.finish(runId, "g1", terminal())).toEqual({ ok: true, stored: true });
    expect(ledger.finishedWorkEvidence.get(runId)?.reviewPublication).toEqual(malformed);
    expect(await store.findPullOwners({ repo: "other/api", pr: 7 })).toEqual({ ok: false, reason: "incomplete" });
  });

  it.each(["pending", "uncertain"] as const)(
    "retains %s publication without blocking the original effect's observation",
    async (state) => {
      const { ledger, store } = await fixture(state);
      expect(await store.findPullOwners({ repo: instance.repo, pr: 7 })).toEqual({
        ok: true,
        owners: [
          { kind: "unit", instanceId: instance.id, unit: "ONE" },
          { kind: "run", runId },
        ],
      });
      const settled = await store.transitionUnitEffect({
        kind: "settle",
        expected: row,
        execution: row.currentEffect!.execution,
        effectId: row.currentEffect!.id,
      });
      expect(settled).toMatchObject({
        ok: true,
        unit: { currentEffect: { phase: "settled", calls: [{ state: "accepted", runId }] } },
      });
      if (!settled.ok) throw new Error("original effect did not settle");
      expect(
        await store.transitionUnitEffect({
          kind: "admit",
          expected: settled.unit,
          execution: { workflowId: instance.id },
          effect: {
            ...row.currentEffect!,
            id: "ONE/2/review",
            ordinal: 2,
            calls: [{ operation: "spawn", state: "unstarted" }],
          },
        }),
      ).toEqual({ ok: false, reason: "owned" });
      const ended = { ...settled.unit, ending };
      expect(await store.putUnits([ended])).toEqual({ ok: true });
      expect(await ledger.finish(runId, "g1", terminal())).toEqual({ ok: true, stored: true });
      // A new store object models restart; it reads the same retained units and run journal.
      const restarted = new InMemoryCoordinatorInstanceStore(ledger);
      expect(await restarted.put(instance)).toEqual({ ok: true });
      seedCoordinatorUnit(restarted, ended);
      expect(await restarted.findPullOwners({ repo: instance.repo, pr: 7 })).toEqual({
        ok: true,
        owners: [{ kind: "run", runId }],
      });
      expect(
        await restarted.putUnits([
          {
            ...ended,
            unit: "SIBLING",
            currentEffect: undefined,
            ending: undefined,
            publication: { ...ended.publication!, owner: { instanceId: instance.id, unit: "SIBLING" } },
          },
        ]),
      ).toEqual({ ok: false, reason: "owned" });
      expect(
        await restarted.admitMaintenance({
          version: 1,
          intent: {
            kind: "command",
            requestId: "cli:repeat",
            actorId: "cli:owner",
            userId: "cli:owner",
            channelId: "cli:local",
            threadKey: "cli:local:another",
          },
          target: { repo: instance.repo, pr: 7, ref: instance.branch, base: "main", headSha: posted },
          createdAt: 3,
          bounds: { leaseMinutes: 15 },
        }),
      ).toEqual({ ok: false, reason: "owned" });
      expect(await restarted.listUnits(instance.id)).toEqual([ended]);
    },
  );

  it.each(["accepted", "refused"] as const)(
    "uses the actual carried-head producer and releases its known %s receipt",
    async (state) => {
      const { ledger, store } = await fixture(null);
      const targets: unknown[] = [];
      const result = await runReviewPostStep({
        agent: AGENTS.review,
        requestText: "Review acme/api#7",
        repoCtx: { repo: instance.repo, pr: 7 },
        heads: { reviewHead: original, observedHead: original },
        verdict: { verdict: "approve", summary: "Clean", findings: [], head: original },
        digest: {
          complete: true,
          base: "main",
          range: { base: "e".repeat(40), canonicalBase: "e".repeat(40), head: original, baseRef: "main" },
          totals: { files: 1, additions: 1, deletions: 0 },
        },
        answer: "Clean",
        carried: { reviewed: original, current: posted, commits: 1 },
        hardStopped: false,
        fetchPrHead: async () => posted,
        reply: async () => {},
        logKey: "fixture",
        post: async (target) => {
          targets.push(target);
          return { state };
        },
        publicationJournal: {
          runId,
          read: async () => ledger.live.get(runId)!.state.reviewPublication ?? null,
          canPublish: async () => true,
          commit: async (reviewPublication) =>
            (await ledger.setState(runId, "g1", { reviewPublication })).ok ? "committed" : "refused",
        },
      });
      expect(targets).toEqual([{ repo: instance.repo, number: 7, commitId: posted }]);
      expect(result).toMatchObject({ posted: state === "accepted" });
      const settled = await store.transitionUnitEffect({
        kind: "settle",
        expected: row,
        execution: row.currentEffect!.execution,
        effectId: row.currentEffect!.id,
      });
      if (!settled.ok) throw new Error("original effect did not settle");
      expect(await store.putUnits([{ ...settled.unit, ending }])).toEqual({ ok: true });
      expect(await ledger.finish(runId, "g1", terminal())).toEqual({ ok: true, stored: true });
      expect(ledger.finished.get(runId)?.reviewPublication).toMatchObject({ state, target: { commitId: posted } });
      expect(await store.findPullOwners({ repo: instance.repo, pr: 7 })).toEqual({ ok: true, owners: [] });
      expect(
        await store.admitMaintenance({
          version: 1,
          intent: {
            kind: "command",
            requestId: "cli:new",
            actorId: "cli:owner",
            userId: "cli:owner",
            channelId: "cli:local",
            threadKey: "cli:local:another",
          },
          target: { repo: instance.repo, pr: 7, ref: instance.branch, base: "main", headSha: posted },
          createdAt: 3,
          bounds: { leaseMinutes: 15 },
        }),
      ).toMatchObject({ ok: true, instance: { id: instance.id }, unit: { unit: "ONE" }, replayed: false });
    },
  );
});
