import { describe, expect, it, vi } from "vitest";
import { InMemoryRunLedger } from "../runLedger/inMemory.js";
import { InMemoryCoordinatorInstanceStore } from "./instanceStore.js";
import { seedCoordinatorUnit } from "../testing/coordinatorInstance.js";
import type { CoordinatorInstance, CoordinatorUnit } from "./contract.js";
import { performCheckRecovery } from "./checkRecoveryEffect.js";
import type { GithubWriteResult, PullRequestFacts } from "../../execution/githubPulls.js";
import type { UnitEffectCall } from "./unitEffect.js";

const instance: CoordinatorInstance = {
  id: "ship_checks",
  kind: "ship",
  userId: "cli:owner",
  channelId: "cli:default",
  threadKey: "cli:default:checks",
  repo: "acme/api",
  branch: "fix/checks",
  base: "main",
  createdAt: 1,
  merge: "person",
};
const headSha = "a".repeat(40);
const unit: CoordinatorUnit = {
  instanceId: instance.id,
  unit: "ONE",
  slug: "checks",
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
    expectedHeadSha: headSha,
    owner: { instanceId: instance.id, unit: "ONE" },
  },
};
async function setup(over: Partial<CoordinatorInstance> = {}) {
  const owner = { ...instance, ...over };
  const store = new InMemoryCoordinatorInstanceStore(new InMemoryRunLedger());
  await store.put(owner);
  seedCoordinatorUnit(store, unit);
  const deps = {
    instances: store,
    readPull: vi.fn(async (): Promise<PullRequestFacts> => ({
      state: "open",
      sameRepoHead: true,
      headRef: unit.branch,
      baseRef: "main",
      headSha,
      headBranchExists: true,
      verifiedHead: { repo: instance.repo, ref: unit.branch, sha: headSha },
    })),
    retryTargets: vi.fn(async () => [{ operation: "actions_rerun" as const, resourceId: 8 }]),
    write: vi.fn(async (_call: UnitEffectCall): Promise<GithubWriteResult> => ({ state: "accepted" })),
  };
  const input = {
    instance: owner,
    unit,
    execution: { workflowId: instance.id },
    effectId: "ONE/checks/0",
    ordinal: 1,
    pr: 7,
    headSha,
    retry: ["tests"],
  };
  return { store, deps, input };
}
describe("durable check recovery", () => {
  it("keeps malformed exact receipts unavailable and reports only positive target drift as conflict", async () => {
    const h = await setup();
    h.deps.readPull.mockResolvedValue({
      ...(await h.deps.readPull()),
      verifiedHead: { repo: instance.repo, ref: unit.branch, sha: "short" },
    });
    expect(await performCheckRecovery(h.input, h.deps)).toEqual({ ok: false, reason: "unavailable" });
    h.deps.readPull.mockResolvedValue({
      ...(await h.deps.readPull()),
      verifiedHead: { repo: instance.repo, ref: unit.branch, sha: "b".repeat(40) },
    });
    expect(await performCheckRecovery(h.input, h.deps)).toEqual({ ok: false, reason: "conflict" });
    expect(h.deps.write).not.toHaveBeenCalled();
  });
  it("defaults the base and requires an attributable exact head before dispatch", async () => {
    const defaulted = await setup({ base: undefined });
    expect(await performCheckRecovery(defaulted.input, defaulted.deps)).toMatchObject({ ok: true, dispatched: true });
    for (const verifiedHead of [
      undefined,
      { repo: "foreign/api", ref: unit.branch, sha: headSha },
      { repo: instance.repo, ref: "foreign", sha: headSha },
      { repo: instance.repo, ref: unit.branch, sha: "short" },
    ]) {
      const h = await setup();
      h.deps.readPull.mockResolvedValue({ ...(await h.deps.readPull()), verifiedHead });
      expect((await performCheckRecovery(h.input, h.deps)).ok).toBe(false);
      expect(h.deps.write).not.toHaveBeenCalled();
    }
  });
  it("settles never-begun exact ended execution while preserving a stale owner's cells", async () => {
    const h = await setup();
    expect(await performCheckRecovery(h.input, { ...h.deps, canWrite: () => false })).toMatchObject({
      ok: false,
      reason: "unavailable",
    });
    const admitted = (await h.store.listUnits(instance.id))[0]!;
    const ended = { ...admitted, ending: { kind: "aborted", report: "Stopped", at: 2 } };
    expect(await h.store.compareAndReplaceUnit(admitted, ended)).toEqual({ ok: true });
    expect(await performCheckRecovery({ ...h.input, unit: ended }, h.deps)).toEqual({
      ok: true,
      dispatched: false,
      effectOrdinal: 1,
    });
    expect((await h.store.listUnits(instance.id))[0]?.currentEffect?.phase).toBe("settled");
    expect(h.deps.write).not.toHaveBeenCalled();
    const stale = await setup();
    await performCheckRecovery(stale.input, { ...stale.deps, canWrite: () => false });
    const saved = (await stale.store.listUnits(instance.id))[0]!;
    expect(
      await performCheckRecovery({ ...stale.input, unit: saved, execution: { workflowId: "foreign" } }, stale.deps),
    ).toEqual({ ok: false, reason: "execution" });
    expect((await stale.store.listUnits(instance.id))[0]).toEqual(saved);
  });
  it("reports partial accepted retries when stop refuses the remaining calls", async () => {
    const h = await setup();
    h.deps.retryTargets.mockResolvedValue([
      { operation: "actions_rerun", resourceId: 8 },
      { operation: "actions_rerun", resourceId: 9 },
    ]);
    h.deps.write.mockImplementation(async () => {
      await h.store.markStopped(instance.id, 2);
      return { state: "accepted" };
    });
    expect(await performCheckRecovery(h.input, h.deps)).toEqual({ ok: true, dispatched: true, effectOrdinal: 1 });
    expect(h.deps.write).toHaveBeenCalledTimes(1);
    expect((await h.store.listUnits(instance.id))[0]?.currentEffect?.phase).toBe("settled");
  });
  it("freezes native IDs and pending before each write, then replays only the recorded answer", async () => {
    const h = await setup();
    h.deps.write.mockImplementation(async () => {
      expect((await h.store.listUnits(instance.id))[0]?.currentEffect?.calls[0]?.state).toBe("pending");
      return { state: "accepted" };
    });
    expect(await performCheckRecovery(h.input, h.deps)).toEqual({ ok: true, dispatched: true, effectOrdinal: 1 });
    const row = (await h.store.listUnits(instance.id))[0]!;
    expect(row.currentEffect?.phase).toBe("settled");
    expect(await performCheckRecovery({ ...h.input, unit: row }, h.deps)).toEqual({
      ok: true,
      dispatched: true,
      effectOrdinal: 1,
    });
    expect(h.deps.write).toHaveBeenCalledTimes(1);
    expect(h.deps.retryTargets).toHaveBeenCalledTimes(1);
  });
  it("retains a lost reply without treating unchanged native checks as proof or replaying", async () => {
    const h = await setup();
    h.deps.write.mockRejectedValue(new Error("lost reply"));
    expect(await performCheckRecovery(h.input, h.deps)).toEqual({ ok: false, reason: "uncertain" });
    const row = (await h.store.listUnits(instance.id))[0]!;
    expect(await performCheckRecovery({ ...h.input, unit: row }, h.deps)).toEqual({ ok: false, reason: "uncertain" });
    expect(row.currentEffect?.phase).toBe("active");
    expect(h.deps.write).toHaveBeenCalledTimes(1);
  });
  it("restores a known accepted close after stop under the original effect and does not close twice", async () => {
    const h = await setup();
    h.deps.write.mockImplementation(async () => {
      if (h.deps.write.mock.calls.length === 1) {
        await h.store.markStopped(instance.id, 2);
        h.deps.readPull.mockResolvedValue({
          state: "closed",
          sameRepoHead: true,
          headRef: unit.branch,
          baseRef: "main",
          headSha,
          headBranchExists: true,
          verifiedHead: { repo: instance.repo, ref: unit.branch, sha: headSha },
        });
      }
      return { state: "accepted" };
    });
    expect(await performCheckRecovery({ ...h.input, retry: undefined, refire: true }, h.deps)).toEqual({
      ok: true,
      dispatched: true,
      effectOrdinal: 1,
    });
    expect(h.deps.write.mock.calls.map(([call]) => call.operation)).toEqual(["pull_close", "pull_reopen"]);
    expect((await h.store.listUnits(instance.id))[0]?.currentEffect?.phase).toBe("settled");
  });
  it("never cancels the reopen obligation after its close was accepted", async () => {
    const h = await setup();
    h.deps.write.mockImplementation(async () => {
      h.deps.readPull.mockResolvedValue({ ...(await h.deps.readPull()), state: "closed" });
      return { state: "accepted" };
    });
    const instances = {
      get: (id: string) => h.store.get(id),
      listUnits: (id: string) => h.store.listUnits(id),
      transitionUnitEffect: async (change: Parameters<typeof h.store.transitionUnitEffect>[0]) =>
        change.kind === "begin" && change.call === 1
          ? { ok: false as const, reason: "stopped" as const }
          : h.store.transitionUnitEffect(change),
    };
    expect(
      await performCheckRecovery({ ...h.input, retry: undefined, refire: true }, { ...h.deps, instances }),
    ).toEqual({ ok: false, reason: "uncertain" });
    const effect = (await h.store.listUnits(instance.id))[0]!.currentEffect!;
    expect(effect.phase).toBe("active");
    expect(effect.calls.map((call) => call.state)).toEqual(["accepted", "unstarted"]);
    expect(h.deps.write).toHaveBeenCalledTimes(1);
  });
  it("retains unknown close and refuses successor IDs, moved targets and never admitted stopped work", async () => {
    const h = await setup();
    h.deps.write.mockRejectedValue(new Error("lost close"));
    const input = { ...h.input, retry: undefined, refire: true };
    expect(await performCheckRecovery(input, h.deps)).toEqual({ ok: false, reason: "uncertain" });
    const row = (await h.store.listUnits(instance.id))[0]!;
    expect(await performCheckRecovery({ ...input, unit: row, effectId: "ONE/checks/1", ordinal: 2 }, h.deps)).toEqual({
      ok: false,
      reason: "busy",
    });
    expect(h.deps.write).toHaveBeenCalledTimes(1);
    const stopped = await setup();
    await stopped.store.markStopped(instance.id, 2);
    expect(await performCheckRecovery(stopped.input, stopped.deps)).toEqual({ ok: false, reason: "stopped" });
    expect(stopped.deps.write).not.toHaveBeenCalled();
    const moved = await setup();
    moved.deps.readPull.mockResolvedValue({
      ...(await moved.deps.readPull()),
      headSha: "b".repeat(40),
      verifiedHead: { repo: instance.repo, ref: unit.branch, sha: "b".repeat(40) },
    });
    expect(await performCheckRecovery(moved.input, moved.deps)).toEqual({ ok: false, reason: "conflict" });
    expect(moved.deps.write).not.toHaveBeenCalled();
  });
});
