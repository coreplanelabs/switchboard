import { describe, expect, it, vi } from "vitest";
import { createMaintenanceSweepService } from "./maintenanceSweep.js";
import { InMemoryCoordinatorInstanceStore } from "./instanceStore.js";
import { prepareMaintenanceAdmission } from "./maintenanceAdmission.js";
import { seedCoordinatorInstance, seedCoordinatorUnit } from "../testing/coordinatorInstance.js";
import { InMemoryRunLedger } from "../runLedger/inMemory.js";
import type { CoordinatorInstance, CoordinatorUnit } from "./contract.js";
import type { SweepDispatchRequest } from "../pullSweepWiring.js";
import type { UnitEffectCompletionOutcome } from "./unitEffect.js";
import { createPullSweepThroughput, type PullSweepDeps, type SweepPullRequest } from "../pullSweep.js";
const oldHead = "a".repeat(40),
  newHead = "b".repeat(40);
const pr: SweepPullRequest = {
  repo: "acme/api",
  number: 7,
  branch: "fix/owned",
  base: "main",
  headSha: oldHead,
  mergeableState: "dirty",
  approved: false,
};
function setup() {
  const ledger = new InMemoryRunLedger();
  const instances = new InMemoryCoordinatorInstanceStore(ledger);
  let nativeHead = oldHead;
  let allowed = true;
  const push = vi.fn(async (): Promise<UnitEffectCompletionOutcome> => {
    nativeHead = newHead;
    return { state: "accepted" as const, commitSha: newHead };
  });
  const perform = vi.fn(async () => ({ state: "accepted" as const }));
  const deps = {
    ledger,
    instances,
    now: () => 3,
    canWrite: async () => allowed,
    readHead: async () => ({ repo: pr.repo, ref: pr.branch, base: pr.base, sha: nativeHead }),
    dispatch: vi.fn(
      async (
        _owner: { instance: CoordinatorInstance; unit: CoordinatorUnit },
        _request: SweepDispatchRequest,
        _agent: "coding" | "review",
      ) => ({ state: "uncertain" as const }) as { state: "uncertain" } | { state: "accepted"; runId: string },
    ),
    build: (): PullSweepDeps => ({
      listOwnedPullRequests: async () => [pr],
      git: {
        rebase: async () => ({ kind: "clean" as const, newHead }),
        patchUnchanged: async () => true,
        canPush: async () => true,
        forcePushWithLease: push,
      },
      effects: {
        prepareNativeCalls: async () => [],
        canPerformNativeCall: () => true,
        performNativeCall: perform,
        modelRoundSpent: async () => false,
        startModelRound: async () => ({ started: false as const, reason: "unused" }),
      },
    }),
  };
  const origin = {
    userId: "cli:owner",
    channelId: "http:pulls",
    threadKey: "http:pulls:actual",
    intent: {
      kind: "command" as const,
      requestId: "cli:request:7",
      actorId: "cli:owner",
      userId: "cli:owner",
      channelId: "http:pulls",
      threadKey: "http:pulls:actual",
    },
  };
  return {
    deps,
    origin,
    instances,
    push,
    perform,
    setAllowed: (v: boolean) => {
      allowed = v;
    },
    setHead: (v: string) => {
      nativeHead = v;
    },
  };
}
describe("durable maintenance sweep integration", () => {
  it("separate maintenance services share throughput and preserve each durable PR owner", async () => {
    const h = setup();
    const throughput = createPullSweepThroughput();
    const base = h.deps.build();
    const heads = new Map([
      [7, oldHead],
      [8, oldHead],
    ]);
    const started: number[] = [];
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    let entered!: () => void;
    const firstEntered = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let admitted!: () => void;
    const secondAdmitted = new Promise<void>((resolve) => {
      admitted = resolve;
    });
    const admit = h.instances.admitMaintenance.bind(h.instances);
    vi.spyOn(h.instances, "admitMaintenance").mockImplementation(async (input) => {
      const result = await admit(input);
      if (input.target.pr === 8 && result.ok) admitted();
      return result;
    });
    const service = (number: number) =>
      createMaintenanceSweepService(
        { ...h.origin, intent: { ...h.origin.intent, requestId: `cli:request:${number}` } },
        {
          ...h.deps,
          readHead: async (target) => ({
            repo: target.repo,
            ref: target.branch,
            base: target.base,
            sha: heads.get(target.number)!,
          }),
          build: () => ({
            ...base,
            throughput,
            listOwnedPullRequests: async () => [{ ...pr, number, branch: `fix/owned-${number}` }],
            git: {
              ...base.git,
              rebase: async (target) => {
                started.push(target.number);
                if (target.number === 7) {
                  entered();
                  await blocked;
                }
                return { kind: "clean", newHead };
              },
              forcePushWithLease: async (target) => {
                heads.set(target.number, newHead);
                return { state: "accepted", commitSha: newHead };
              },
            },
          }),
        },
      );
    const first = service(7).sweep({ repo: pr.repo, number: 7 });
    await firstEntered;
    const second = service(8).sweep({ repo: pr.repo, number: 8 });
    await secondAdmitted;
    expect(await h.instances.findPullOwners({ repo: pr.repo, pr: 7 })).toMatchObject({
      ok: true,
      owners: [expect.anything()],
    });
    expect(await h.instances.findPullOwners({ repo: pr.repo, pr: 8 })).toMatchObject({
      ok: true,
      owners: [expect.anything()],
    });
    expect(started).toEqual([7]);
    release();
    const reports = await Promise.all([first, second]);
    expect(reports.map((result) => result.results[0]?.outcome)).toEqual(["carried", "carried"]);
    expect(started).toEqual([7, 8]);
  });

  it("shared throughput never releases a PR whose first native write remains unknown", async () => {
    const h = setup();
    const base = h.deps.build();
    const throughput = createPullSweepThroughput();
    h.deps.build = () => ({ ...base, throughput });
    h.push.mockImplementation(async () => ({ state: "uncertain" }));
    const first = await createMaintenanceSweepService(h.origin, h.deps).sweep({ repo: pr.repo });
    const second = await createMaintenanceSweepService(
      { ...h.origin, intent: { ...h.origin.intent, requestId: "cli:rival" } },
      h.deps,
    ).sweep({ repo: pr.repo });
    expect(first.results[0]?.outcome).toBe("error");
    expect(second.results[0]?.outcome).toBe("error");
    expect(h.push).toHaveBeenCalledTimes(1);
    expect(await h.instances.findPullOwners({ repo: pr.repo, pr: 7 })).toMatchObject({
      ok: true,
      owners: [expect.anything()],
    });
  });

  it("settles already published accepted history even when the native head moves before settlement", async () => {
    const h = setup();
    const advance = h.instances.transitionUnitEffect.bind(h.instances);
    vi.spyOn(h.instances, "transitionUnitEffect").mockImplementation(async (change) => {
      const result = await advance(change);
      if (change.kind === "publish" && result.ok) h.setHead("c".repeat(40));
      return result;
    });
    await createMaintenanceSweepService(h.origin, h.deps).sweep({ repo: pr.repo });
    const prepared = await prepareMaintenanceAdmission({
      version: 1,
      intent: h.origin.intent,
      target: { repo: pr.repo, pr: 7, ref: pr.branch, base: pr.base, headSha: oldHead },
      createdAt: 3,
      bounds: { leaseMinutes: 15, spendCapUsd: 5 },
    });
    const row = (await h.instances.listUnits(prepared.actionId))[0]!;
    expect(row.currentEffect?.phase).toBe("settled");
    expect(row.publication?.expectedHeadSha).toBe(newHead);
    expect(row.currentEffect?.calls[0]).toMatchObject({ state: "accepted", commitSha: newHead });
    expect(await h.instances.findPullOwners({ repo: pr.repo, pr: 7 })).toMatchObject({ ok: true, owners: [] });
    expect(h.push).toHaveBeenCalledTimes(1);
  });
  it("settles known accepted history without inventing a current binding when the head moves before publish", async () => {
    const h = setup();
    h.push.mockImplementation(async () => {
      h.setHead("c".repeat(40));
      return { state: "accepted", commitSha: newHead };
    });
    await createMaintenanceSweepService(h.origin, h.deps).sweep({ repo: pr.repo });
    const prepared = await prepareMaintenanceAdmission({
      version: 1,
      intent: h.origin.intent,
      target: { repo: pr.repo, pr: 7, ref: pr.branch, base: pr.base, headSha: oldHead },
      createdAt: 3,
      bounds: { leaseMinutes: 15, spendCapUsd: 5 },
    });
    const row = (await h.instances.listUnits(prepared.actionId))[0]!;
    expect(row.currentEffect?.phase).toBe("settled");
    expect(row.publication?.expectedHeadSha).toBe(oldHead);
    expect(row.currentEffect?.calls[0]).toMatchObject({ state: "accepted", commitSha: newHead });
    expect(await h.instances.findPullOwners({ repo: pr.repo, pr: 7 })).toMatchObject({ ok: true, owners: [] });
    expect(h.push).toHaveBeenCalledTimes(1);
  });

  it("a definite native refusal releases ownership without erasing its receipt or replaying the call", async () => {
    const h = setup();
    h.push.mockResolvedValue({ state: "refused", cause: "external_refused" });
    expect((await createMaintenanceSweepService(h.origin, h.deps).sweep({ repo: pr.repo })).results[0]?.outcome).toBe(
      "error",
    );
    const owners = await h.instances.findPullOwners({ repo: pr.repo, pr: pr.number });
    expect(owners.ok && owners.owners).toEqual([]);
    const prepared = await prepareMaintenanceAdmission({
      version: 1,
      intent: h.origin.intent,
      target: { repo: pr.repo, pr: 7, ref: pr.branch, base: pr.base, headSha: oldHead },
      createdAt: 3,
      bounds: { leaseMinutes: 15, spendCapUsd: 5 },
    });
    const cell = (await h.instances.listUnits(prepared.actionId))[0]?.currentEffect;
    expect(cell?.phase).toBe("settled");
    expect(cell?.calls[0]).toEqual({ operation: "rebase_push", state: "refused", cause: "external_refused" });
    await createMaintenanceSweepService(h.origin, h.deps).sweep({ repo: pr.repo });
    expect(h.push).toHaveBeenCalledTimes(1);
  });
  it.each(["coding", "review"] as const)(
    "freezes the original %s conversation instead of the wiring's synthetic identity",
    async (agent) => {
      const h = setup();
      const instance: CoordinatorInstance = {
        id: "original-ship",
        kind: "ship",
        userId: h.origin.userId,
        channelId: h.origin.channelId,
        threadKey: h.origin.threadKey,
        repo: pr.repo,
        branch: pr.branch,
        base: pr.base,
        createdAt: 1,
      };
      const unit: CoordinatorUnit = {
        instanceId: instance.id,
        unit: "ONE",
        slug: "owned",
        branch: pr.branch,
        dependsOn: [],
        rounds: [],
        threadKey: "http:coding:original",
        reviewThread: { threadKey: "http:review:original" },
        pr: { number: pr.number, url: "https://github.com/acme/api/pull/7" },
        publication: {
          repo: pr.repo,
          pr: pr.number,
          headRef: pr.branch,
          publicationRef: pr.branch,
          baseRef: pr.base,
          expectedHeadSha: oldHead,
          owner: { instanceId: instance.id, unit: "ONE" },
        },
        ending: {
          kind: "aborted",
          at: 2,
          report: "original saved report",
          outcome: { schemaVersion: 1, kind: "aborted", reviewRounds: 0 },
        },
      };
      seedCoordinatorInstance(h.instances, instance);
      seedCoordinatorUnit(h.instances, unit);
      const base = h.deps.build();
      h.deps.build = () => ({
        ...base,
        git: {
          ...base.git,
          rebase: async () =>
            agent === "coding"
              ? { kind: "conflict" as const, file: "conflict.ts" }
              : { kind: "clean" as const, newHead },
          patchUnchanged: async () => false,
        },
        effects: {
          ...base.effects,
          prepareNativeCalls: async () => [
            {
              operation: "spawn" as const,
              state: "unstarted" as const,
              request: {
                channelId: "http:synthetic",
                userId: "http:synthetic",
                threadKey: "http:synthetic:thread",
                text: "Review exact original target",
              },
            },
          ],
        },
      });
      await createMaintenanceSweepService(h.origin, h.deps).sweep({ repo: pr.repo });
      expect(h.deps.dispatch).toHaveBeenCalledTimes(1);
      const [owner, request, actualAgent] = h.deps.dispatch.mock.calls[0]!;
      expect(actualAgent).toBe(agent);
      expect(request).toMatchObject({
        channelId: owner.instance.channelId,
        userId: owner.instance.userId,
        threadKey: agent === "coding" ? owner.unit.threadKey : owner.unit.reviewThread!.threadKey,
      });
      expect(owner.unit.currentEffect!.target).toEqual({
        repo: pr.repo,
        pr: 7,
        ref: pr.branch,
        base: pr.base,
        headSha: oldHead,
      });
      expect(owner.unit.publication!.expectedHeadSha).toBe(agent === "coding" ? oldHead : newHead);
    },
  );

  it("a canonical stop after pending spawn admission prevents the service from dispatching a snapshot owner", async () => {
    const h = setup();
    const base = h.deps.build();
    h.deps.build = () => ({
      ...base,
      git: { ...base.git, rebase: async () => ({ kind: "conflict" as const, file: "conflict.ts" }) },
    });
    const transition = h.instances.transitionUnitEffect.bind(h.instances);
    vi.spyOn(h.instances, "transitionUnitEffect").mockImplementation(async (change) => {
      const result = await transition(change);
      if (
        change.kind === "begin" &&
        result.ok &&
        result.unit.currentEffect?.calls[change.call]?.operation === "spawn"
      ) {
        await h.instances.markStopped(result.unit.instanceId, 4);
      }
      return result;
    });
    await createMaintenanceSweepService(h.origin, h.deps).sweep({ repo: pr.repo });
    expect(h.deps.dispatch).not.toHaveBeenCalled();
  });

  it("charges only a durably admitted coding child and retains its live ownership across restart", async () => {
    const h = setup();
    const base = h.deps.build();
    h.deps.build = () => ({
      ...base,
      git: { ...base.git, rebase: async () => ({ kind: "conflict" as const, file: "conflict.ts" }) },
    });
    h.deps.dispatch.mockImplementation(async ({ instance, unit }) => {
      const cell = unit.currentEffect!;
      await h.deps.ledger.claim({
        runId: "actual-model-child",
        threadKey: instance.threadKey,
        gen: "g1",
        leaseMs: 1000,
        startedAt: 4,
        meta: {
          agent: "coding",
          channelId: instance.channelId,
          userId: instance.userId,
          threadKey: instance.threadKey,
          repo: instance.repo,
          ref: unit.branch,
          parentInstanceId: instance.id,
          coordinatorUnit: unit.unit,
          coordinatorAttempt: 0,
          idempotencyKey: `${instance.id}:${cell.id}`,
          maintenanceActionId: cell.execution.maintenance!.id,
          operationTarget: { repo: instance.repo, ref: unit.branch },
        },
        card: null,
        system: "",
        tools: [],
        state: {},
      });
      await h.deps.ledger.append("actual-model-child", "g1", [
        {
          type: "coordinator_tag",
          seq: 1,
          parentInstanceId: instance.id,
          unit: unit.unit,
          branch: unit.branch,
          base: "main",
          publication: unit.publication,
          maintenanceActionId: cell.execution.maintenance!.id,
        },
      ]);
      return { state: "accepted", runId: "actual-model-child" };
    });
    expect((await createMaintenanceSweepService(h.origin, h.deps).sweep({ repo: pr.repo })).results[0]?.outcome).toBe(
      "fix-round",
    );
    const owners = await h.instances.findPullOwners({ repo: pr.repo, pr: pr.number });
    expect(owners.ok && owners.owners.some((owner) => owner.kind === "unit")).toBe(true);
    const prepared = await prepareMaintenanceAdmission({
      version: 1,
      intent: h.origin.intent,
      target: { repo: pr.repo, pr: 7, ref: pr.branch, base: pr.base, headSha: oldHead },
      createdAt: 3,
      bounds: { leaseMinutes: 15, spendCapUsd: 5 },
    });
    expect((await h.instances.listUnits(prepared.actionId))[0]?.rounds[0]?.maintenance).toEqual({
      actionId: prepared.actionId,
      runId: "actual-model-child",
      budgetUsd: 5,
    });
    expect((await createMaintenanceSweepService(h.origin, h.deps).sweep({ repo: pr.repo })).results[0]?.outcome).toBe(
      "fix-round",
    );
    expect(h.deps.dispatch).toHaveBeenCalledTimes(1);
  });
  it("an unanswered model admission retains the pending cell without charging or replaying", async () => {
    const h = setup();
    const base = h.deps.build();
    h.deps.build = () => ({
      ...base,
      git: { ...base.git, rebase: async () => ({ kind: "conflict" as const, file: "conflict.ts" }) },
    });
    expect((await createMaintenanceSweepService(h.origin, h.deps).sweep({ repo: pr.repo })).results[0]?.outcome).toBe(
      "conflict",
    );
    const prepared = await prepareMaintenanceAdmission({
      version: 1,
      intent: h.origin.intent,
      target: { repo: pr.repo, pr: 7, ref: pr.branch, base: pr.base, headSha: oldHead },
      createdAt: 3,
      bounds: { leaseMinutes: 15, spendCapUsd: 5 },
    });
    const row = (await h.instances.listUnits(prepared.actionId))[0]!;
    expect(row.rounds).toEqual([]);
    expect(row.currentEffect?.phase).toBe("active");
    await createMaintenanceSweepService(h.origin, h.deps).sweep({ repo: pr.repo });
    expect(h.deps.dispatch).toHaveBeenCalledTimes(1);
  });
  it("authority withdrawn after preparation never begins native dispatch", async () => {
    const h = setup();
    const base = h.deps.build();
    h.deps.build = () => ({
      ...base,
      effects: {
        ...base.effects,
        prepareNativeCalls: async () => {
          h.setAllowed(false);
          return [];
        },
      },
    });
    expect((await createMaintenanceSweepService(h.origin, h.deps).sweep({ repo: pr.repo })).results[0]?.outcome).toBe(
      "error",
    );
    expect(h.push).not.toHaveBeenCalled();
    const owners = await h.instances.findPullOwners({ repo: pr.repo, pr: pr.number });
    expect(owners.ok && owners.owners).toEqual([]);
  });
  it("publishes only the same accepted native push and replays without another write", async () => {
    const h = setup();
    const service = createMaintenanceSweepService(h.origin, h.deps);
    expect((await service.sweep({ repo: pr.repo, number: 7 })).results[0]?.outcome).toBe("carried");
    const prepared = await prepareMaintenanceAdmission({
      version: 1,
      intent: h.origin.intent,
      target: { repo: pr.repo, pr: 7, ref: pr.branch, base: pr.base, headSha: oldHead },
      createdAt: 3,
      bounds: { leaseMinutes: 15, spendCapUsd: 5 },
    });
    const owner = (await h.instances.get(prepared.actionId))!;
    expect((await h.instances.listUnits(owner.id))[0]?.publication?.expectedHeadSha).toBe(newHead);
    expect(
      (await createMaintenanceSweepService(h.origin, h.deps).sweep({ repo: pr.repo, number: 7 })).results[0]?.outcome,
    ).toBe("carried");
    expect(h.push).toHaveBeenCalledTimes(1);
  });
  it("withdrawn authority refuses before native mutation and releases only the unstarted reservation", async () => {
    const h = setup();
    h.setAllowed(false);
    expect((await createMaintenanceSweepService(h.origin, h.deps).sweep({ repo: pr.repo })).results[0]?.outcome).toBe(
      "error",
    );
    expect(h.push).not.toHaveBeenCalled();
  });
  it("a changed native head cannot credit a saved push to the publication binding", async () => {
    const h = setup();
    h.push.mockImplementationOnce(async () => {
      h.setHead("c".repeat(40));
      return { state: "accepted", commitSha: newHead };
    });
    expect((await createMaintenanceSweepService(h.origin, h.deps).sweep({ repo: pr.repo })).results[0]?.outcome).toBe(
      "error",
    );
    const prepared = await prepareMaintenanceAdmission({
      version: 1,
      intent: h.origin.intent,
      target: { repo: pr.repo, pr: 7, ref: pr.branch, base: pr.base, headSha: oldHead },
      createdAt: 3,
      bounds: { leaseMinutes: 15, spendCapUsd: 5 },
    });
    const owner = (await h.instances.get(prepared.actionId))!;
    expect((await h.instances.listUnits(owner.id))[0]?.publication?.expectedHeadSha).toBe(oldHead);
    expect(h.push).toHaveBeenCalledTimes(1);
    expect((await h.instances.listUnits(owner.id))[0]?.currentEffect?.phase).toBe("settled");
  });
  it("a rival canonical reservation prevents all native calls", async () => {
    const h = setup();
    await h.instances.admitMaintenance({
      version: 1,
      intent: { ...h.origin.intent, requestId: "cli:rival" },
      target: { repo: pr.repo, pr: 7, ref: pr.branch, base: "main", headSha: oldHead },
      createdAt: 2,
      bounds: { leaseMinutes: 15, spendCapUsd: 5 },
    });
    expect((await createMaintenanceSweepService(h.origin, h.deps).sweep({ repo: pr.repo })).results[0]?.outcome).toBe(
      "error",
    );
    expect(h.push).not.toHaveBeenCalled();
  });
});
