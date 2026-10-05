import { describe, expect, it, vi } from "vitest";
import { createSweepEffectJournal } from "./sweepEffectJournal.js";
import { InMemoryCoordinatorInstanceStore } from "./instanceStore.js";
import { InMemoryRunLedger } from "../runLedger/inMemory.js";
import { seedCoordinatorUnit } from "../testing/coordinatorInstance.js";
import { privateWorkerThreadKey } from "../privateWorkerLog.js";
import { UNKNOWN_CONTEXT_DEPENDENCIES } from "../references/contextDependencies.js";
import { contextThreadSessionKey } from "../runLedger/sessionLog.js";
import type { CoordinatorInstance, CoordinatorUnit } from "./contract.js";
import type { SweepNativePlan } from "../pullSweep.js";
import type { UnitEffectTransition } from "./unitEffect.js";
import { releaseMaintenanceReservation } from "./maintenanceAdmission.js";
const oldHead = "a".repeat(40),
  newHead = "b".repeat(40);
const instance: CoordinatorInstance = {
  id: "sweep_journal",
  kind: "ship",
  userId: "cli:owner",
  channelId: "cli:default",
  threadKey: "cli:default:task",
  repo: "acme/api",
  branch: "fix/sweep",
  base: "main",
  createdAt: 1,
  merge: "person",
};
const unit: CoordinatorUnit = {
  instanceId: instance.id,
  unit: "ONE",
  slug: "sweep",
  branch: instance.branch,
  dependsOn: [],
  rounds: [],
  pr: { number: 7, url: "https://github.com/acme/api/pull/7" },
  publication: {
    repo: instance.repo,
    pr: 7,
    headRef: instance.branch,
    baseRef: "main",
    publicationRef: instance.branch,
    expectedHeadSha: oldHead,
    owner: { instanceId: instance.id, unit: "ONE" },
  },
};
const plan = (): SweepNativePlan => ({
  pr: {
    repo: instance.repo,
    number: 7,
    branch: unit.branch,
    base: "main",
    headSha: oldHead,
    mergeableState: "dirty",
    approved: true,
  },
  newHead,
  decision: "carry",
  preparedSource: { baseHead: "c".repeat(40), committer: { name: "sweep", email: "sweep@example.test" } },
  calls: [
    { operation: "rebase_push", state: "unstarted" },
    { operation: "approval_reset", state: "unstarted", body: "Private frozen approval" },
  ],
});
async function setup() {
  const ledger = new InMemoryRunLedger();
  const instances = new InMemoryCoordinatorInstanceStore(ledger);
  await instances.put(instance);
  seedCoordinatorUnit(instances, unit);
  const input = { instance, unit, execution: { workflowId: instance.id }, effectId: "ONE/0/rebase", ordinal: 1 };
  const deps = { ledger, instances };
  return { ledger, instances, input, deps, journal: createSweepEffectJournal(input, deps) };
}
describe("durable sweep journal", () => {
  async function retargeted(logical = false) {
    const ledger = new InMemoryRunLedger();
    const instances = new InMemoryCoordinatorInstanceStore(ledger);
    const original: CoordinatorUnit = {
      ...unit,
      threadKey: privateWorkerThreadKey({ instanceId: instance.id, unit: unit.unit }),
      workBrief: {
        requesterId: instance.userId,
        mainThreadKey: instance.threadKey,
        actId: "original-act",
        repo: instance.repo,
        base: "main",
        question: "Original private question",
        requestedChange: "Original private change",
        findings: [],
      },
      ending: {
        kind: "aborted",
        report: "Original private report",
        at: 2,
        outcome: { schemaVersion: 1, kind: "aborted", reviewRounds: 0 },
      },
    };
    if (!logical) {
      await instances.put(instance);
      seedCoordinatorUnit(instances, original);
    }
    const admission = {
      version: 1 as const,
      intent: {
        kind: "command" as const,
        requestId: "cli:original-base",
        actorId: instance.userId,
        userId: instance.userId,
        channelId: instance.channelId,
        threadKey: instance.threadKey,
      },
      target: { repo: instance.repo, pr: 7, ref: unit.branch, base: "main", headSha: oldHead },
      createdAt: 3,
      bounds: { leaseMinutes: 15, spendCapUsd: 5 },
    };
    const first = await instances.admitMaintenance(admission);
    if (!first.ok) throw new Error("original maintenance admission refused");
    expect(await releaseMaintenanceReservation(first, instances)).toBe(true);
    const admitted = await instances.admitMaintenance({
      ...admission,
      intent: { ...admission.intent, requestId: "cli:retargeted-base" },
      target: { ...admission.target, base: "release" },
      createdAt: 4,
    });
    if (!admitted.ok) throw new Error("retargeted maintenance admission refused");
    expect(admitted.instance).toEqual(first.instance);
    expect(admitted.instance.base).toBe("main");
    return {
      ledger,
      instances,
      admitted,
      original,
      journal: createSweepEffectJournal(admitted, { ledger, instances }),
    };
  }
  it.each(["carry", "delta-review", "fix-round"] as const)(
    "executes retargeted %s maintenance against its frozen base while preserving original custody",
    async (decision) => {
      const h = await retargeted(decision === "delta-review");
      const threadKey = h.admitted.unit.threadKey ?? h.admitted.instance.threadKey;
      const request = {
        channelId: h.admitted.instance.channelId,
        userId: h.admitted.instance.userId,
        threadKey,
        text: "Frozen original child request",
      };
      const p: SweepNativePlan = {
        ...plan(),
        pr: { ...plan().pr, base: "release" },
        decision,
        ...(decision === "fix-round" ? { newHead: oldHead, preparedSource: undefined } : {}),
        calls:
          decision === "fix-round"
            ? [{ operation: "spawn", agent: "coding", state: "unstarted", request }]
            : decision === "delta-review"
              ? [
                  { operation: "rebase_push", state: "unstarted" },
                  { operation: "spawn", state: "unstarted", request },
                ]
              : plan().calls,
      };
      expect(await h.journal.admit(p)).toBe(true);
      expect((await h.journal.read(p.pr))?.pr.base).toBe("release");
      expect(await h.journal.begin(p, 0)).toBe(true);
      if (decision !== "fix-round") {
        expect(await h.journal.complete(p, 0, { state: "accepted", commitSha: newHead })).toBe(true);
        const row = (await h.instances.listUnits(h.admitted.instance.id))[0]!;
        const published = await h.instances.transitionUnitEffect({
          kind: "publish",
          expected: row,
          execution: h.admitted.execution,
          effectId: h.admitted.effectId,
        });
        expect(published.ok).toBe(true);
        if (!published.ok) throw new Error("original push publication refused");
        expect(published.unit.publication).toMatchObject({ baseRef: "release", expectedHeadSha: newHead });
        expect(await h.journal.begin(p, 1)).toBe(true);
      }
      if (decision === "carry") {
        expect(await h.journal.complete(p, 1, { state: "accepted" })).toBe(true);
      } else {
        const row = (await h.instances.listUnits(h.admitted.instance.id))[0]!;
        const runId = `retargeted-${decision}`;
        expect(
          await h.ledger.claim({
            runId,
            threadKey,
            gen: "g1",
            leaseMs: 1000,
            startedAt: 5,
            card: null,
            system: "",
            tools: [],
            state: {},
            meta: {
              agent: decision === "fix-round" ? "coding" : "review",
              channelId: h.admitted.instance.channelId,
              userId: h.admitted.instance.userId,
              threadKey,
              repo: instance.repo,
              ref: unit.branch,
              parentInstanceId: h.admitted.instance.id,
              coordinatorUnit: unit.unit,
              coordinatorAttempt: 0,
              idempotencyKey: `${h.admitted.instance.id}:${h.admitted.effectId}`,
              maintenanceActionId: h.admitted.execution.maintenance!.id,
              operationTarget: { repo: instance.repo, ref: unit.branch },
              ...(decision === "delta-review" ? { pr: 7, headSha: newHead } : {}),
            },
          }),
        ).toMatchObject({ ok: true });
        await h.ledger.append(runId, "g1", [
          {
            type: "coordinator_tag",
            seq: 1,
            parentInstanceId: h.admitted.instance.id,
            unit: unit.unit,
            branch: unit.branch,
            base: "release",
            publication: row.publication,
            maintenanceActionId: h.admitted.execution.maintenance!.id,
          },
        ]);
        expect(await h.journal.complete(p, decision === "fix-round" ? 0 : 1, { state: "accepted", runId })).toBe(true);
      }
      expect(await h.journal.settle(p)).toBe(true);
      const final = (await h.instances.listUnits(h.admitted.instance.id))[0]!;
      expect(final.currentEffect?.target.base).toBe("release");
      expect(await h.instances.get(h.admitted.instance.id)).toEqual(h.admitted.instance);
      if (decision !== "delta-review") {
        expect(final.workBrief).toEqual(h.original.workBrief);
        expect(final.ending).toEqual(h.original.ending);
        expect(final.threadKey).toBe(h.original.threadKey);
      }
    },
  );
  it("holds a frozen maintenance plan when its base drifts again and keeps ordinary Workflow base checks", async () => {
    const h = await retargeted();
    const p = { ...plan(), pr: { ...plan().pr, base: "release" } };
    expect(await h.journal.admit(p)).toBe(true);
    await expect(h.journal.read({ ...p.pr, base: "other" })).rejects.toThrow();
    const original = (await h.instances.listUnits(h.admitted.instance.id))[0]!;
    seedCoordinatorUnit(h.instances, { ...original, publication: { ...original.publication!, baseRef: "other" } });
    expect(await h.journal.begin(p, 0)).toBe(false);
    expect((await h.instances.listUnits(h.admitted.instance.id))[0]!.currentEffect?.calls[0]?.state).toBe("unstarted");
    const ordinary = await setup();
    expect(await ordinary.journal.admit(p)).toBe(false);
    expect((await ordinary.instances.listUnits(instance.id))[0]).toEqual(unit);
  });
  it("keeps the original frozen plan under byte pressure while an uncertain call remains owned", async () => {
    const h = await setup();
    const p = plan();
    const key = contextThreadSessionKey(privateWorkerThreadKey({ instanceId: instance.id, unit: unit.unit }));
    await h.ledger.claimSession(key, "session-writer", "g1", 128);
    expect(await h.journal.admit(p)).toBe(true);
    expect(await h.journal.begin(p, 0)).toBe(true);
    expect(await h.journal.complete(p, 0, { state: "uncertain" })).toBe(true);
    const pressure = {
      role: "user",
      part: { type: "tool_result", toolUseId: "pressure", content: "x".repeat(8000) },
      context: UNKNOWN_CONTEXT_DEPENDENCIES,
    };
    expect(
      await h.ledger.appendSession(
        key,
        "tool-pressure",
        [{ part: 0, json: JSON.stringify(pressure) }],
        UNKNOWN_CONTEXT_DEPENDENCIES,
      ),
    ).toEqual({ ok: true, appended: true });
    expect(await h.ledger.readSessionEntry(key, "tool-pressure")).toBeUndefined();
    const row = (await h.instances.listUnits(instance.id))[0]!;
    const restarted = createSweepEffectJournal({ ...h.input, unit: row }, h.deps);
    expect(await restarted.read(p.pr)).toEqual({ ...p, calls: [{ ...p.calls[0]!, state: "uncertain" }, p.calls[1]!] });
    expect(await restarted.begin(p, 0)).toBe(false);
    expect((await h.instances.listUnits(instance.id))[0]).toEqual(row);
  });
  it("charges one bounded coding child atomically from its actual maintenance admission and retains it across restart", async () => {
    const h = await setup();
    const original = {
      ...unit,
      ending: {
        kind: "aborted" as const,
        report: "Original ending",
        at: 2,
        outcome: { schemaVersion: 1 as const, kind: "aborted" as const, reviewRounds: 0 },
      },
    };
    seedCoordinatorUnit(h.instances, original);
    const admitted = await h.instances.admitMaintenance({
      version: 1,
      intent: {
        kind: "command",
        requestId: "cli:model:7",
        actorId: instance.userId,
        userId: instance.userId,
        channelId: instance.channelId,
        threadKey: instance.threadKey,
      },
      target: { repo: instance.repo, pr: 7, ref: unit.branch, base: "main", headSha: oldHead },
      createdAt: 3,
      bounds: { leaseMinutes: 15, spendCapUsd: 5 },
    });
    expect(admitted.ok).toBe(true);
    if (!admitted.ok) return;
    const p: SweepNativePlan = {
      pr: plan().pr,
      newHead: oldHead,
      decision: "fix-round",
      calls: [
        {
          operation: "spawn",
          agent: "coding",
          state: "unstarted",
          request: {
            channelId: instance.channelId,
            userId: instance.userId,
            threadKey: instance.threadKey,
            text: "Frozen actual coding request",
          },
        },
      ],
    };
    const journal = createSweepEffectJournal(admitted, h.deps);
    expect(await journal.admit(p)).toBe(true);
    expect(await journal.begin(p, 0)).toBe(true);
    expect(await journal.complete(p, 0, { state: "accepted", runId: "model-child" })).toBe(false);
    expect((await h.instances.listUnits(instance.id))[0]!.rounds).toEqual([]);
    await h.ledger.claim({
      runId: "model-child",
      threadKey: instance.threadKey,
      gen: "g1",
      leaseMs: 1000,
      startedAt: 4,
      meta: {
        maintenanceActionId: admitted.execution.maintenance!.id,
        agent: "coding",
        channelId: instance.channelId,
        userId: instance.userId,
        threadKey: instance.threadKey,
        repo: instance.repo,
        ref: unit.branch,
        parentInstanceId: instance.id,
        coordinatorUnit: unit.unit,
        coordinatorAttempt: 0,
        idempotencyKey: `${instance.id}:${admitted.effectId}`,
        operationTarget: { repo: instance.repo, ref: unit.branch },
      },
      card: null,
      system: "",
      tools: [],
      state: {},
    });
    await h.ledger.append("model-child", "g1", [
      {
        type: "coordinator_tag",
        maintenanceActionId: admitted.execution.maintenance!.id,
        seq: 1,
        parentInstanceId: instance.id,
        unit: unit.unit,
        branch: unit.branch,
        base: "main",
        publication: unit.publication,
      },
    ]);
    expect(await journal.complete(p, 0, { state: "accepted", runId: "model-child" })).toBe(true);
    expect(await journal.settle(p)).toBe(true);
    const current = (await h.instances.listUnits(instance.id))[0]!;
    expect(current.rounds).toEqual([
      {
        index: 1,
        agent: "coding",
        outcome: "started",
        at: 3,
        maintenance: { actionId: admitted.execution.maintenance!.id, runId: "model-child", budgetUsd: 5 },
      },
    ]);
    expect(current.ending).toEqual(original.ending);
    expect(await h.instances.findPullOwners({ repo: instance.repo, pr: 7 })).toEqual({
      ok: true,
      owners: [{ kind: "unit", instanceId: instance.id, unit: unit.unit }],
    });
    expect(await h.instances.compareAndReplaceUnit(current, { ...current, rounds: [] })).toEqual({
      ok: false,
      reason: "stale",
    });
    expect(await createSweepEffectJournal({ ...admitted, unit: current }, h.deps).settle(p)).toBe(true);
  });
  it("prepares the existing maintenance reservation only after its private plan is retained", async () => {
    const h = await setup();
    const original = {
      ...unit,
      ending: {
        kind: "aborted" as const,
        report: "Original ending",
        at: 2,
        outcome: { schemaVersion: 1 as const, kind: "aborted" as const, reviewRounds: 0 },
      },
    };
    seedCoordinatorUnit(h.instances, original);
    const admitted = await h.instances.admitMaintenance({
      version: 1,
      intent: {
        kind: "command",
        requestId: "cli:source:7",
        actorId: instance.userId,
        userId: instance.userId,
        channelId: instance.channelId,
        threadKey: instance.threadKey,
      },
      target: { repo: instance.repo, pr: 7, ref: unit.branch, base: "main", headSha: oldHead },
      createdAt: 3,
      bounds: { leaseMinutes: 15, spendCapUsd: 5 },
    });
    expect(admitted.ok).toBe(true);
    if (!admitted.ok) return;
    const journal = createSweepEffectJournal(admitted, h.deps);
    expect(await journal.read(plan().pr)).toBeUndefined();
    expect(await journal.begin(plan(), 0)).toBe(false);
    expect(await journal.admit(plan())).toBe(true);
    expect(await journal.begin(plan(), 0)).toBe(true);
    expect(await journal.complete(plan(), 0, { state: "accepted", commitSha: newHead })).toBe(true);
    const current = (await h.instances.listUnits(instance.id))[0]!;
    expect(current.ending).toEqual(original.ending);
    const published = await h.instances.transitionUnitEffect({
      kind: "publish",
      expected: current,
      execution: admitted.execution,
      effectId: admitted.effectId,
    });
    expect(published.ok).toBe(true);
    if (!published.ok) return;
    const advanced = published.unit;
    expect(advanced.publication?.expectedHeadSha).toBe(newHead);
    expect(advanced.lastPush).toBe(newHead);
    const restarted = createSweepEffectJournal({ ...admitted, unit: advanced }, h.deps);
    expect((await restarted.read(plan().pr))?.calls.map((c) => c.state)).toEqual(["accepted", "unstarted"]);
    expect(await restarted.begin(plan(), 0)).toBe(false);
    expect(await restarted.begin(plan(), 1)).toBe(true);
    expect(await restarted.complete(plan(), 1, { state: "accepted" })).toBe(true);
    expect(await restarted.settle(plan())).toBe(true);
  });
  it("replays only the original settled push after the publication binding advances", async () => {
    const h = await setup();
    const p = plan();
    await h.journal.admit(p);
    for (const [index, call] of p.calls.entries()) {
      expect(await h.journal.begin(p, index)).toBe(true);
      expect(
        await h.journal.complete(
          p,
          index,
          call.operation === "rebase_push" ? { state: "accepted", commitSha: newHead } : { state: "accepted" },
        ),
      ).toBe(true);
    }
    expect(await h.journal.settle(p)).toBe(true);
    const current = (await h.instances.listUnits(instance.id))[0]!;
    const advanced = { ...current, publication: { ...current.publication!, expectedHeadSha: newHead } };
    seedCoordinatorUnit(h.instances, advanced);
    const restarted = createSweepEffectJournal({ ...h.input, unit: advanced }, h.deps);
    expect((await restarted.read({ ...p.pr, headSha: newHead }))?.calls.map((c) => c.state)).toEqual([
      "accepted",
      "accepted",
    ]);
    expect(await restarted.begin(p, 0)).toBe(false);
    expect(await restarted.settle(p)).toBe(true);
    const drift = { ...advanced, publication: { ...advanced.publication, expectedHeadSha: "d".repeat(40) } };
    seedCoordinatorUnit(h.instances, drift);
    await expect(
      createSweepEffectJournal({ ...h.input, unit: drift }, h.deps).read({ ...p.pr, headSha: "d".repeat(40) }),
    ).rejects.toThrow();
  });
  it("persists an original known completion after stop but does not begin remaining calls", async () => {
    const h = await setup();
    const p = plan();
    expect(await h.journal.admit(p)).toBe(true);
    expect(await h.journal.begin(p, 0)).toBe(true);
    await h.instances.markStopped(instance.id, 2);
    expect(await h.journal.complete(p, 0, { state: "accepted", commitSha: newHead })).toBe(true);
    expect(await h.journal.begin(p, 1)).toBe(false);
    expect(await h.journal.settle(p)).toBe(false);
    expect((await h.instances.listUnits(instance.id))[0]!.currentEffect!.calls.map((call) => call.state)).toEqual([
      "accepted",
      "unstarted",
    ]);
  });
  it("rejects malformed private rows with a generic failure that never repeats private bytes", async () => {
    const h = await setup();
    await h.journal.admit(plan());
    const malformed = createSweepEffectJournal(h.input, {
      ...h.deps,
      ledger: {
        appendSession: (...args) => h.ledger.appendSession(...args),
        readSessionEntry: async () => [{ idx: 0, part: 0, json: "Private frozen secret invalid JSON" }],
      },
    });
    await expect(malformed.read(plan().pr)).rejects.toThrow("original sweep ownership or frozen payload unavailable");
    try {
      await malformed.read(plan().pr);
    } catch (error) {
      expect(String(error)).not.toContain("secret");
    }
    const wrongOrdinal = createSweepEffectJournal({ ...h.input, ordinal: 2 }, h.deps);
    await expect(wrongOrdinal.read(plan().pr)).rejects.toThrow();
    expect(await wrongOrdinal.begin(plan(), 0)).toBe(false);
  });
  it("cannot turn a concurrent or lost begin response into a second native caller", async () => {
    const h = await setup();
    const p = plan();
    await h.journal.admit(p);
    const instances = {
      get: (id: string) => h.instances.get(id),
      listUnits: (id: string) => h.instances.listUnits(id),
      transitionUnitEffect: async (change: UnitEffectTransition) => {
        const result = await h.instances.transitionUnitEffect(change);
        return change.kind === "begin" ? { ok: false as const, reason: "unavailable" as const } : result;
      },
    };
    const lost = createSweepEffectJournal(h.input, { ledger: h.ledger, instances });
    expect(await lost.begin(p, 0)).toBe(false);
    expect(await h.journal.begin(p, 0)).toBe(false);
    expect((await h.instances.listUnits(instance.id))[0]!.currentEffect!.calls[0]!.state).toBe("pending");
    expect(await lost.complete(p, 0, { state: "accepted", commitSha: newHead })).toBe(false);
  });
  it("reuses a pre-effect snapshot only while the exact original whole unit row remains current", async () => {
    const h = await setup();
    const p = plan();
    const refuse = {
      ...h.deps,
      instances: {
        get: (id: string) => h.instances.get(id),
        listUnits: (id: string) => h.instances.listUnits(id),
        transitionUnitEffect: async () => ({ ok: false as const, reason: "unavailable" as const }),
      },
    };
    expect(await createSweepEffectJournal(h.input, refuse).admit(p)).toBe(false);
    const restarted = createSweepEffectJournal(h.input, h.deps);
    expect(await restarted.read(p.pr)).toEqual(p);
    expect(await restarted.begin(p, 0)).toBe(true);
    const moved = await setup();
    expect(
      await createSweepEffectJournal(moved.input, {
        ...refuse,
        ledger: moved.ledger,
        instances: {
          get: (id) => moved.instances.get(id),
          listUnits: (id) => moved.instances.listUnits(id),
          transitionUnitEffect: async () => ({ ok: false as const, reason: "unavailable" as const }),
        },
      }).admit(p),
    ).toBe(false);
    await moved.instances.compareAndReplaceUnit(unit, { ...unit, title: "changed after snapshot" });
    const changed = createSweepEffectJournal(moved.input, moved.deps);
    await expect(changed.read(p.pr)).rejects.toThrow();
    expect(await changed.begin(p, 0)).toBe(false);
    expect((await moved.instances.listUnits(instance.id))[0]!.currentEffect).toBeUndefined();
  });
  it("persists only the private frozen payload before admission and derives replay states from the cell", async () => {
    const h = await setup();
    const appended = vi.spyOn(h.ledger, "appendSession");
    const p = plan();
    expect(await h.journal.read(p.pr)).toBeUndefined();
    expect(await h.journal.admit(p)).toBe(true);
    expect(appended.mock.calls[0]?.[0]).toBe(
      contextThreadSessionKey(privateWorkerThreadKey({ instanceId: instance.id, unit: unit.unit })),
    );
    const row = JSON.parse(appended.mock.calls[0]![2][0]!.json);
    expect(row).toMatchObject({
      role: "assistant",
      silent: true,
      folded: true,
      part: { type: "text", text: "" },
      context: { version: 1, status: "unknown" },
    });
    expect(JSON.stringify((await h.instances.listUnits(instance.id))[0])).not.toContain("Private frozen approval");
    expect((await h.ledger.readSession(contextThreadSessionKey(instance.threadKey), 0)).turns).toBe(0);
    expect(await h.journal.begin(p, 0)).toBe(true);
    expect((await h.instances.listUnits(instance.id))[0]!.currentEffect!.calls[0]!.state).toBe("pending");
    expect(await h.journal.complete(p, 0, { state: "accepted", commitSha: newHead })).toBe(true);
    const restarted = createSweepEffectJournal(h.input, h.deps);
    const saved = await restarted.read({ ...p.pr, headSha: newHead, mergeableState: "clean" });
    expect(saved?.calls.map((call) => call.state)).toEqual(["accepted", "unstarted"]);
    expect(saved?.calls[1]).toMatchObject({ body: "Private frozen approval" });
    expect(await restarted.begin(saved!, 0)).toBe(false);
    expect(await restarted.begin(saved!, 1)).toBe(true);
    expect(await restarted.complete(saved!, 1, { state: "accepted" })).toBe(true);
    expect(await restarted.settle(saved!)).toBe(true);
    expect(await createSweepEffectJournal(h.input, h.deps).settle(saved!)).toBe(true);
  });
  it("holds failed private append and immutable payload conflict before any cell or mutation", async () => {
    const h = await setup();
    const bad = createSweepEffectJournal(h.input, {
      ...h.deps,
      ledger: {
        readSessionEntry: (...args) => h.ledger.readSessionEntry(...args),
        appendSession: async () => ({ ok: false, appended: false }),
      },
    });
    expect(await bad.admit(plan())).toBe(false);
    expect((await h.instances.listUnits(instance.id))[0]).toEqual(unit);
    expect(await h.journal.admit(plan())).toBe(true);
    const changed = plan();
    changed.calls[1] = { operation: "approval_reset", state: "accepted", body: "Different private bytes" };
    expect(await h.journal.admit(changed)).toBe(false);
    expect(await h.journal.begin(changed, 0)).toBe(false);
    expect((await h.instances.listUnits(instance.id))[0]!.currentEffect!.calls.map((call) => call.state)).toEqual([
      "unstarted",
      "unstarted",
    ]);
  });
  it("recovers a lost completion ACK only from the exact row or one durable-only retry", async () => {
    for (const committed of [true, false]) {
      const h = await setup();
      let completions = 0;
      const transition = vi.fn(async (change: UnitEffectTransition) => {
        if (change.kind === "complete" && ++completions === 1) {
          if (committed) await h.instances.transitionUnitEffect(change);
          return { ok: false as const, reason: "unavailable" as const };
        }
        return h.instances.transitionUnitEffect(change);
      });
      const journal = createSweepEffectJournal(h.input, {
        ledger: h.ledger,
        instances: {
          get: (id) => h.instances.get(id),
          listUnits: (id) => h.instances.listUnits(id),
          transitionUnitEffect: transition,
        },
      });
      const p = plan();
      expect(await journal.admit(p)).toBe(true);
      expect(await journal.begin(p, 0)).toBe(true);
      const native = vi.fn(async () => ({ state: "accepted" as const, commitSha: newHead }));
      expect(await journal.complete(p, 0, await native())).toBe(true);
      expect(completions).toBe(committed ? 1 : 2);
      expect(native).toHaveBeenCalledTimes(1);
    }
  });
  it("retains pending or missing payload on restart and refuses a changed owner or stopped admission", async () => {
    const h = await setup();
    const p = plan();
    await h.journal.admit(p);
    await h.journal.begin(p, 0);
    const restarted = createSweepEffectJournal(h.input, h.deps);
    expect((await restarted.read(p.pr))?.calls[0]?.state).toBe("pending");
    expect(await restarted.begin(p, 0)).toBe(false);
    expect(await restarted.complete(p, 0, { state: "accepted", commitSha: newHead })).toBe(false);
    const missing = createSweepEffectJournal(h.input, {
      ...h.deps,
      ledger: { appendSession: (...args) => h.ledger.appendSession(...args), readSessionEntry: async () => undefined },
    });
    await expect(missing.read(p.pr)).rejects.toThrow();
    const changed = createSweepEffectJournal(h.input, {
      ...h.deps,
      instances: {
        listUnits: (id) => h.instances.listUnits(id),
        transitionUnitEffect: (change) => h.instances.transitionUnitEffect(change),
        get: async () => ({ ...instance, userId: "cli:foreign" }),
      },
    });
    await expect(changed.read(p.pr)).rejects.toThrow();
    expect(await changed.begin(p, 0)).toBe(false);
    const stopped = await setup();
    await stopped.instances.markStopped(instance.id, 2);
    expect(await stopped.journal.admit(plan())).toBe(false);
    expect((await stopped.instances.listUnits(instance.id))[0]).toEqual(unit);
  });
});
