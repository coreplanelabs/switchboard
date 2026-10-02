import { describe, expect, it, vi } from "vitest";
import { contractFor } from "../coordinator/briefs.js";
import type { CoordinatorInstance, CoordinatorUnit } from "../coordinator/contract.js";
import type { LiveRunRow } from "../runLedger/types.js";
import type { LedgerRun } from "../runLedger/writeThrough.js";
import { renderContract } from "../ship/contract.js";
import { privateWorkerThreadKey } from "../privateWorkerLog.js";
import { acknowledgeUnitSeed, readUnitSeedProof, type UnitSeedProofDeps } from "./unitSeedProof.js";

async function fixture() {
  const instance = {
    id: "plan_seed",
    kind: "ship",
    userId: "slack:UA",
    channelId: "slack:DA",
    threadKey: "slack:DA:1",
    repo: "acme/api",
    base: "main",
    branch: "plan/seed/task",
    plan: { id: "seed" },
    createdAt: 1,
  } as CoordinatorInstance;
  const threadKey = privateWorkerThreadKey({ instanceId: instance.id, unit: "task" });
  const unit: CoordinatorUnit = {
    instanceId: instance.id,
    unit: "task",
    slug: "task",
    branch: instance.branch,
    dependsOn: [],
    rounds: [],
    threadKey,
    workBrief: {
      requesterId: instance.userId,
      mainThreadKey: instance.threadKey,
      actId: "ask",
      repo: instance.repo,
      base: "main",
      question: "Why?",
      findings: [],
      requestedChange: "Fix the query",
    },
    context: {
      version: 1,
      handoff: {
        version: 1,
        source: {
          runId: "parent",
          requester: instance.userId,
          channelId: instance.channelId,
          threadKey: instance.threadKey,
        },
        session: { key: "parent", from: 0, to: 0 },
        assets: [],
      },
    },
  };
  const binding = {
    instanceId: instance.id,
    unit: unit.unit,
    instanceAttempt: 0,
    idempotencyKey: `${instance.id}:task/0/coding`,
  };
  const contract = await contractFor(instance, unit, {
    readRepoFile: async () => undefined,
    readRunFacts: async () => undefined,
  });
  const block = renderContract(contract, {}).text;
  const messages = [
    {
      role: "user" as const,
      content: [
        { type: "text" as const, text: "parent evidence" },
        { type: "text" as const, text: block },
      ],
    },
  ];
  const handoff = {
    ...structuredClone(unit.context!.handoff),
    consumer: {
      runId: "child",
      requester: instance.userId,
      channelId: instance.channelId,
      threadKey,
      attempt: binding.idempotencyKey,
    },
    snapshotRunId: "child",
  };
  const row = {
    runId: "child",
    ownerGen: "gen",
    threadKey,
    phase: "live",
    system: "system",
    meta: {
      userId: instance.userId,
      channelId: instance.channelId,
      threadKey,
      agent: "coding",
      parentInstanceId: instance.id,
      coordinatorUnit: unit.unit,
      coordinatorAttempt: 0,
      idempotencyKey: binding.idempotencyKey,
      childHandoff: handoff,
      session: { key: "child-session", seedFrom: 0, request: 0, range: { from: 0 } },
    },
    state: { contextCheckpoint: { key: "child-session", through: 0 } },
  } as unknown as LiveRunRow;
  const readSession = vi.fn(async () => ({
    complete: true as const,
    turns: 1,
    messages,
    compactions: [],
    actors: [instance.userId],
  }));
  const deps = {
    runLedger: { gen: "gen", readLiveRuns: async () => [row], readSession },
    runStore: { get: async () => null, list: async () => [] },
    instances: { get: async () => instance, listUnits: async () => [unit] },
  } as unknown as UnitSeedProofDeps;
  const setStateAndFlush = vi.fn(async (patch: Record<string, unknown>) => {
    Object.assign(row.state, structuredClone(patch));
    return true;
  });
  const run = {
    runId: row.runId,
    tracked: () => true,
    session: row.meta.session,
    setStateAndFlush,
  } as unknown as LedgerRun;
  const input = {
    run,
    binding,
    handoff,
    contract,
    contractBlock: block,
    messages,
    actors: [instance.userId],
    system: row.system,
    checkpoint: { key: "child-session", through: 0 },
    acknowledgedAt: 2,
  };
  return { deps, instance, unit, row, input, readSession, setStateAndFlush };
}

describe("canonical unit seed acknowledgment", () => {
  it.each([null, false, {}, "invalid"])(
    "refuses a present invalid work brief without treating it as absent (%s)",
    async (brief) => {
      const f = await fixture();
      (f.unit as unknown as Record<string, unknown>).workBrief = brief;
      expect(await acknowledgeUnitSeed(f.deps, f.input)).toEqual({ kind: "unavailable" });
      expect(f.setStateAndFlush).not.toHaveBeenCalled();
    },
  );

  it("identifies a review seed from canonical metadata without claiming coding delivery", async () => {
    const f = await fixture();
    const key = `${f.instance.id}:task/0/review`;
    f.row.meta.agent = "review";
    f.row.meta.idempotencyKey = key;
    f.input.binding.idempotencyKey = key;
    f.input.handoff.consumer.attempt = key;
    f.row.system = f.input.system = `system\n${f.input.contractBlock}`;
    expect(await acknowledgeUnitSeed(f.deps, f.input)).toMatchObject({ kind: "acknowledged" });
    expect(await readUnitSeedProof(f.deps, { instance: f.instance, unit: f.unit })).toMatchObject({
      role: "review",
      child: { runId: "child" },
    });
  });
  it("acknowledges only the exact durably saved seed and verifies it after owner restart", async () => {
    const f = await fixture();
    expect(await acknowledgeUnitSeed(f.deps, f.input)).toMatchObject({
      kind: "acknowledged",
      receipt: { child: { runId: "child" }, ownerGen: "gen" },
    });
    expect(f.setStateAndFlush).toHaveBeenCalledTimes(1);
    f.row.ownerGen = "next-generation";
    const proof = await readUnitSeedProof(f.deps, { instance: f.instance, unit: f.unit });
    expect(proof?.receipt.ownerGen).toBe("gen");
    expect(proof?.child.runId).toBe("child");
    expect(proof).not.toHaveProperty("providerStarted");
    f.readSession.mockResolvedValue({
      complete: true,
      turns: 1,
      messages: [{ role: "user", content: [{ type: "text", text: "changed seed" }] }],
      compactions: [],
      actors: [f.instance.userId],
    });
    expect(await readUnitSeedProof(f.deps, { instance: f.instance, unit: f.unit })).toBeUndefined();
  });

  it.each([
    "wrong-child",
    "wrong-attempt",
    "wrong-capsule",
    "wrong-contract",
    "wrong-system",
    "changed-seed",
    "missing-checkpoint",
    "missing-ack",
  ])("refuses %s without claiming an acknowledged seed", async (failure) => {
    const f = await fixture();
    if (failure === "wrong-child")
      f.row.meta.childHandoff = { ...f.input.handoff, consumer: { ...f.input.handoff.consumer, runId: "other" } };
    if (failure === "wrong-attempt") f.instance.attempt = 1;
    if (failure === "wrong-capsule") f.unit.context!.handoff.source.runId = "another-parent";
    if (failure === "wrong-contract")
      f.input.contract = { ...f.input.contract, unit: { ...f.input.contract.unit, section: "another task" } };
    if (failure === "wrong-system") f.row.system = "changed system";
    if (failure === "changed-seed")
      f.readSession.mockResolvedValue({ complete: true, turns: 1, messages: [], compactions: [], actors: [] });
    if (failure === "missing-checkpoint") delete f.row.state.contextCheckpoint;
    if (failure === "missing-ack") f.setStateAndFlush.mockResolvedValue(false);
    expect(await acknowledgeUnitSeed(f.deps, f.input)).toEqual({ kind: "unavailable" });
    expect(await readUnitSeedProof(f.deps, { instance: f.instance, unit: f.unit })).toBeUndefined();
  });
});
