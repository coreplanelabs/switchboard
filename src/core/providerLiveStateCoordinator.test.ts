import { describe, expect, it } from "vitest";
import { InMemoryRunLedger } from "./runLedger/inMemory.js";
import { NullLedgerRun, NullLedgerWriteThrough } from "./runLedger/writeThrough.js";
import { RunRegistry } from "./runRegistry.js";
import { createProviderLiveStateCoordinator } from "./providerLiveStateCoordinator.js";

const claim = {
  runId: "provider-run",
  threadKey: "slack:C1:provider",
  gen: "g1",
  leaseMs: 30_000,
  startedAt: 100,
  meta: {
    agent: "general",
    channelId: "slack:C1",
    userId: "slack:UALICE",
    threadKey: "slack:C1:provider",
  },
  card: { channel: "C1", ts: "1.0" },
  system: "system",
  tools: [],
};

describe("provider live-state coordinator", () => {
  it("finishes a provider park before a later recovery, so the durable and live projections end working", async () => {
    const ledger = new InMemoryRunLedger(() => 100);
    await ledger.claim(claim);
    const registry = new RunRegistry({ genId: () => claim.runId, genToken: () => "token", now: () => 100 });
    const run = registry.create(undefined, undefined, { id: claim.runId });
    const admitted = await ledger.assignLiveState(run.id, "g1", {
      expectedSeq: 0,
      eventSeq: 1,
      at: 100,
      state: "admitted",
      bound: 5_000,
    });
    if (!admitted.ok) throw new Error(admitted.reason);
    expect(registry.commitLiveState(run.id, admitted)).toBe(true);
    const working = await ledger.assignLiveState(run.id, "g1", {
      expectedSeq: admitted.liveStateSeq,
      eventSeq: 2,
      at: 110,
      state: "working",
      bound: 5_000,
      detail: "model turn",
    });
    if (!working.ok) throw new Error(working.reason);
    expect(registry.commitLiveState(run.id, working)).toBe(true);
    registry.publish(run.id, { type: "lease", startedAt: 100, endsAt: 5_000, loopEndsAt: 5_000, at: 100 });

    const tracked = new NullLedgerRun(run.id, { put: async () => {}, abandoned: () => {} });
    tracked.tracked = () => true;
    tracked.assignLiveState = (assignment) => ledger.assignLiveState(run.id, "g1", assignment);
    const writeThrough = new NullLedgerWriteThrough("g1", { put: async () => {}, abandoned: () => {} });
    writeThrough.liveRuns = () => [tracked];
    let parkLanded!: () => void;
    const durablePark = new Promise<void>((resolve) => (parkLanded = resolve));
    let finishPark!: () => void;
    const parkMayFinish = new Promise<void>((resolve) => (finishPark = resolve));
    writeThrough.planePark = async (runId, provider) => {
      await ledger.planePark(runId, provider);
      parkLanded();
      await parkMayFinish;
    };
    writeThrough.planeLevel = (post) => ledger.planeLevel(post);
    const coordinator = createProviderLiveStateCoordinator({
      runLedger: writeThrough,
      ledger,
      registry,
      clock: () => 200,
      warn: (message) => {
        throw new Error(message);
      },
    });

    const parked = coordinator.park(run.id, "anthropic");
    await durablePark;
    const recovered = coordinator.level("anthropic", "up");
    finishPark();
    await Promise.all([parked, recovered]);

    expect((await ledger.listLive())[0]).toMatchObject({
      liveState: { state: "working", bound: 5_000, detail: "model turn" },
      state: { liveProvider: undefined },
    });
    expect(registry.getById(run.id)?.liveState).toMatchObject({ state: "working", bound: 5_000 });
    expect(ledger.planeParks).toEqual([{ runId: run.id, provider: "anthropic" }]);
    expect(ledger.planeLevels).toEqual([{ provider: "anthropic", name: "provider", side: "up" }]);
  });
});
