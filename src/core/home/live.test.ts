import { describe, expect, it } from "vitest";
import { homeLiveUnitRuns } from "./live.js";
import { nextUnitProgress, type UnitWait } from "../coordinator/unitProgress.js";
import { createHomeService } from "./service.js";
import { createHomeConditionReader } from "./conditions.js";
import { InMemoryRunLedger } from "../runLedger/inMemory.js";
import { InMemoryCoordinatorInstanceStore } from "../coordinator/instanceStore.js";
import { RunRegistry } from "../runRegistry.js";
import { WorkerRunLedger } from "../runLedgerWorker.js";
import type { Predicate } from "../authz/types.js";

async function fixture(count = 1) {
  let at = 1000;
  const now = () => at;
  const ledger = new InMemoryRunLedger(now);
  const registry = new RunRegistry({ now });
  const instances = new InMemoryCoordinatorInstanceStore();
  const instance = {
    id: "original-work",
    kind: "ship" as const,
    userId: "slack:owner",
    channelId: "slack:C1",
    threadKey: "slack:C1:1",
    repo: "sample/api",
    branch: "work",
    createdAt: 1,
  };
  expect(await instances.put(instance)).toMatchObject({ ok: true });
  for (let index = 0; index < count; index++) {
    const unit = `U${index + 10}`,
      runId = `original-child-${index}`;
    expect(
      await instances.putUnits([
        { instanceId: instance.id, unit, slug: "work", branch: `work/${unit}`, dependsOn: [], rounds: [] },
      ]),
    ).toMatchObject({ ok: true });
    expect(
      await ledger.claim({
        runId,
        gen: "foreign-generation",
        threadKey: `slack:C1:${index + 2}`,
        startedAt: 1,
        leaseMs: 30000,
        meta: {
          channelId: instance.channelId,
          userId: instance.userId,
          threadKey: `slack:C1:${index + 2}`,
          channelVisibility: "public",
          parentInstanceId: instance.id,
          coordinatorUnit: unit,
          repo: instance.repo,
        },
        system: "",
        tools: [],
        card: null,
      }),
    ).toMatchObject({ ok: true });
    expect(
      await ledger.assignLiveState(runId, "foreign-generation", {
        expectedSeq: 0,
        at,
        state: "admitted",
        bound: 31000,
      }),
    ).toMatchObject({ ok: true });
    const row = (await ledger.listLive()).find((row) => row.runId === runId)!;
    expect(
      await ledger.assignLiveState(runId, "foreign-generation", {
        expectedSeq: row.liveStateSeq!,
        at,
        state: "working",
        bound: 31000,
      }),
    ).toMatchObject({ ok: true });
  }
  const home = createHomeService({
    organizationId: "sample",
    instances,
    conditions: createHomeConditionReader(instances),
    liveUnitRuns: (predicate) => homeLiveUnitRuns({ registry, ledger, now }, predicate),
  });
  return {
    ledger,
    registry,
    instances,
    instance,
    now,
    home,
    advance: (value: number) => {
      at = value;
    },
    reader: { actorId: instance.userId, visibleTo: { kind: "all" as const } },
  };
}

async function recordWait(w: Awaited<ReturnType<typeof fixture>>, waiting: UnitWait) {
  const original = (await w.instances.listUnits(w.instance.id))[0]!;
  const next = nextUnitProgress(
    w.instance,
    original,
    w.instance.id,
    { expectedRevision: 0, step: "work/wait", waiting },
    w.now(),
  );
  if (!next.ok) throw new Error(`Progress refused: ${next.reason}`);
  expect(await w.instances.compareAndReplaceUnit(original, { ...original, recordedProgress: next.progress })).toEqual({
    ok: true,
  });
}

describe("registered Home live work", () => {
  it("shows the original durable live child as Moving without a local run or new owner", async () => {
    const w = await fixture();
    const read = await w.home.snapshot(w.reader);
    expect(await homeLiveUnitRuns({ registry: w.registry, ledger: w.ledger, now: w.now }, w.reader.visibleTo)).toEqual(
      new Map([["original-work:U10", new Set(["original-child-0"])]]),
    );
    expect(JSON.stringify(read)).not.toContain("original-child-0");
    expect(read.status).toBe("complete");
    expect(read.moving.map((row) => row.unit.unit)).toEqual(["original-work:U10"]);
    expect(read.waiting).toEqual([]);
    expect(w.registry.listActive()).toEqual([]);
    expect((await w.ledger.listLive()).map((row) => [row.runId, row.ownerGen, row.threadKey])).toEqual([
      ["original-child-0", "foreign-generation", "slack:C1:2"],
    ]);
    expect(await w.home.pipeline(w.reader, "original-work")).toMatchObject({
      status: "complete",
      movingUnitKeys: ["original-work:U10"],
      pipeline: { moving: 1 },
    });
  });
  it.each([
    ["local", "snapshot"],
    ["durable", "snapshot"],
    ["local", "pipeline"],
    ["durable", "pipeline"],
  ] as const)(
    "keeps the exact %s working child Moving in %s while its original workflow records a child wait",
    async (surface, readPath) => {
      const w = await fixture();
      await recordWait(w, { kind: "child", runId: "original-child-0" });
      if (surface === "local") {
        const remote = (await w.ledger.listLive())[0]!;
        w.registry.create("Original child", remote.meta, {
          id: remote.runId,
          liveState: { liveState: remote.liveState, liveStateSeq: remote.liveStateSeq },
        });
      }
      if (readPath === "snapshot") {
        const read = await w.home.snapshot(w.reader);
        expect(read.status).toBe("complete");
        expect(read.moving).toMatchObject([
          {
            unit: { unit: "original-work:U10" },
            conditions: [{ owner: { kind: "automation", class: "Original worker" } }],
          },
        ]);
        expect(read.waiting).toEqual([]);
      } else {
        expect(await w.home.pipeline(w.reader, w.instance.id)).toMatchObject({
          status: "complete",
          movingUnitKeys: ["original-work:U10"],
          pipeline: { moving: 1, waiting: 0 },
        });
      }
    },
  );
  it.each([
    { kind: "checks", headSha: "a".repeat(40) },
    { kind: "retry" },
    { kind: "child", runId: "another-child" },
  ] satisfies UnitWait[])("does not substitute unit activity for the recorded wait %j", async (waiting) => {
    const w = await fixture();
    await recordWait(w, waiting);
    expect(await w.home.snapshot(w.reader)).toMatchObject({
      status: "complete",
      moving: [],
      waiting: [{ unit: { unit: "original-work:U10" } }],
    });
    expect(await w.home.pipeline(w.reader, w.instance.id)).toMatchObject({
      movingUnitKeys: [],
      pipeline: { moving: 0, waiting: 1 },
    });
  });
  it.each(["unavailable", "duplicate", "wrong revision", "unknown owner"] as const)(
    "does not exempt a recorded child wait with %s conditions",
    async (failure) => {
      const w = await fixture();
      await recordWait(w, { kind: "child", runId: "original-child-0" });
      const reader = createHomeConditionReader(w.instances);
      const home = createHomeService({
        organizationId: "sample",
        instances: w.instances,
        liveUnitRuns: (predicate) =>
          homeLiveUnitRuns({ registry: w.registry, ledger: w.ledger, now: w.now }, predicate),
        conditions: {
          list: async (key, unit, privateRead) => {
            if (failure === "unavailable") throw new Error("Private condition details");
            const conditions = await reader.list(key, unit, privateRead);
            if (failure === "duplicate") return [...conditions, ...conditions];
            if (failure === "wrong revision")
              return conditions.map((condition) => ({ ...condition, revision: condition.revision + 1 }));
            return conditions.map((condition) => ({ ...condition, owner: { kind: "unknown" as const } }));
          },
        },
      });
      expect(await home.snapshot(w.reader)).toMatchObject({
        status: failure === "unavailable" || failure === "duplicate" ? "partial" : "complete",
        moving: [],
        waiting: [{ unit: { unit: "original-work:U10" } }],
      });
      expect(await home.pipeline(w.reader, w.instance.id)).toMatchObject({
        movingUnitKeys: [],
        pipeline: { moving: 0, waiting: 1 },
      });
    },
  );
  it("requires private metadata proof before exempting the original child wait", async () => {
    const w = await fixture();
    const original = (await w.instances.listUnits(w.instance.id))[0]!;
    expect(
      await w.instances.compareAndReplaceUnit(original, {
        ...original,
        workBrief: {
          requesterId: w.instance.userId,
          mainThreadKey: w.instance.threadKey,
          actId: "original-act",
          repo: w.instance.repo,
          base: "main",
          question: "Private request",
          findings: [],
          requestedChange: "Recorded change",
        },
      }),
    ).toEqual({ ok: true });
    await recordWait(w, { kind: "child", runId: "original-child-0" });
    const denied = { ...w.reader, readPrivateUnit: async () => false };
    expect(await w.home.snapshot(denied)).toMatchObject({
      moving: [],
      waiting: [{ unit: { unit: "original-work:U10" } }],
    });
    expect(await w.home.pipeline(denied, w.instance.id)).toMatchObject({
      movingUnitKeys: [],
      pipeline: { moving: 0, waiting: 1 },
    });
    const allowed = { ...w.reader, readPrivateUnit: async () => true };
    expect(await w.home.snapshot(allowed)).toMatchObject({
      moving: [{ unit: { unit: "original-work:U10" } }],
      waiting: [],
    });
    expect(await w.home.pipeline(allowed, w.instance.id)).toMatchObject({
      movingUnitKeys: ["original-work:U10"],
      pipeline: { moving: 1, waiting: 0 },
    });
  });
  it("reads all live owners past the run-list display cap", async () => {
    const w = await fixture(201);
    const read = await w.home.snapshot(w.reader);
    expect(read.status).toBe("complete");
    expect(read.moving).toHaveLength(201);
    expect(read.moving.at(-1)?.unit.unit).toBe("original-work:U210");
    expect(read.pipelines).toMatchObject([{ moving: 201, unresolved: 201 }]);
  });
  it.each(["expired", "handoff", "stopping", "ended", "provider wait"] as const)(
    "does not label a %s durable owner as Moving",
    async (mode) => {
      const w = await fixture();
      await recordWait(w, { kind: "child", runId: "original-child-0" });
      if (mode === "expired") w.advance(31001);
      else if (mode === "handoff")
        await w.ledger.handoff("foreign-generation", ["original-child-0"], { pausedForRetry: true });
      else if (mode === "stopping") await w.ledger.requestStop("original-child-0", "hard");
      else {
        const row = (await w.ledger.listLive())[0]!;
        expect(
          await w.ledger.assignLiveState(row.runId, row.ownerGen, {
            expectedSeq: row.liveStateSeq!,
            at: 1000,
            state: mode === "ended" ? "ended" : "waiting_provider",
            ...(mode === "ended" ? { cause: "completed" as const } : { bound: 31000 }),
          }),
        ).toMatchObject({ ok: true });
      }
      const read = await w.home.snapshot(w.reader);
      expect(read.moving).toEqual([]);
      expect(read.waiting.map((row) => row.unit.unit)).toEqual(["original-work:U10"]);
    },
  );
  it("keeps a known local finish authoritative over its older durable copy", async () => {
    const w = await fixture();
    await recordWait(w, { kind: "child", runId: "original-child-0" });
    const remote = (await w.ledger.listLive())[0]!;
    const run = w.registry.create("Original child", remote.meta, { id: remote.runId });
    w.registry.finish(run.id, "completed");
    expect((await w.home.snapshot(w.reader)).moving).toEqual([]);
    expect((await w.ledger.listLive())[0]?.ownerGen).toBe("foreign-generation");
  });
  it("checks the lease at read completion instead of before the durable await", async () => {
    const w = await fixture();
    const home = createHomeService({
      organizationId: "sample",
      instances: w.instances,
      liveUnitRuns: (predicate) =>
        homeLiveUnitRuns(
          {
            registry: w.registry,
            now: w.now,
            ledger: {
              listLive: async () => {
                const rows = await w.ledger.listLive();
                w.advance(31001);
                return rows;
              },
            },
          },
          predicate,
        ),
    });
    expect((await home.snapshot(w.reader)).moving).toEqual([]);
  });
  it("keeps a local finish during the durable read from becoming Moving again", async () => {
    const w = await fixture();
    const remote = (await w.ledger.listLive())[0]!;
    const run = w.registry.create("Original child", remote.meta, {
      id: remote.runId,
      liveState: { liveState: remote.liveState, liveStateSeq: remote.liveStateSeq },
    });
    expect(w.registry.listActive()[0]?.liveState?.state).toBe("working");
    const source = {
      registry: w.registry,
      now: w.now,
      ledger: {
        listLive: async () => {
          w.registry.finish(run.id, "completed");
          return await w.ledger.listLive();
        },
      },
    };
    expect([...(await homeLiveUnitRuns(source, { kind: "all" }))]).toEqual([]);
  });
  it.each([
    "missing state",
    "unknown state",
    "invalid bound",
    "invalid stop",
    "invalid retry",
    "duplicate row",
  ] as const)("keeps %s durable facts partial instead of silently reporting no movement", async (failure) => {
    const w = await fixture();
    const rows = structuredClone(await w.ledger.listLive());
    if (failure === "missing state") delete rows[0]!.liveState;
    else if (failure === "unknown state") Object.assign(rows[0]!.liveState!, { state: "invented" });
    else if (failure === "invalid bound") Object.assign(rows[0]!.liveState!, { bound: null });
    else if (failure === "invalid stop") Object.assign(rows[0]!, { stop: "invented" });
    else if (failure === "invalid retry") Object.assign(rows[0]!.state, { pausedForRetry: "invented" });
    else rows.push(rows[0]!);
    const home = createHomeService({
      organizationId: "sample",
      instances: w.instances,
      liveUnitRuns: (predicate) =>
        homeLiveUnitRuns({ registry: w.registry, now: w.now, ledger: { listLive: async () => rows } }, predicate),
    });
    expect(await home.snapshot(w.reader)).toMatchObject({
      status: "partial",
      moving: [],
      waiting: [{ unit: { unit: "original-work:U10" } }],
    });
  });
  it.each(["private", "unknown"] as const)(
    "keeps %s source activity out of public visibility and counters",
    async (visibility) => {
      const w = await fixture();
      const rows = structuredClone(await w.ledger.listLive());
      rows[0]!.meta.channelVisibility = visibility;
      const predicate: Predicate = { kind: "visibility-in", visibilities: new Set(["public"]) };
      expect([
        ...(await homeLiveUnitRuns(
          { registry: w.registry, now: w.now, ledger: { listLive: async () => rows } },
          predicate,
        )),
      ]).toEqual([]);
      expect(await w.home.snapshot({ ...w.reader, visibleTo: predicate })).toMatchObject({
        moving: [],
        waiting: [],
        pipelines: [],
      });
    },
  );
  it("keeps canonical questions and held units ahead of an older live child", async () => {
    const w = await fixture();
    const original = (await w.instances.listUnits(w.instance.id))[0]!;
    await w.instances.putUnits([
      {
        ...original,
        idle: {
          why: "held",
          from: "coding",
          at: 1,
          spendUsd: 0,
          renewalsLeft: 0,
          wakes: 0,
          humanGate: {
            pr: { number: 12, url: "https://github.com/sample/api/pull/12" },
            round: 1,
            verdict: "approve",
            findings: [],
            askedAt: 1,
            assignedTo: "slack:other",
          },
        },
      },
    ]);
    const read = await w.home.snapshot(w.reader);
    expect(read.moving).toEqual([]);
    expect(read.waiting.map((row) => row.unit.unit)).toEqual(["original-work:U10"]);
    expect(await w.home.pipeline(w.reader, w.instance.id)).toMatchObject({
      movingUnitKeys: [],
      pipeline: { moving: 0, waiting: 1 },
    });
    const held = (await w.instances.listUnits(w.instance.id))[0]!;
    expect(
      await w.instances.compareAndReplaceUnit(held, {
        ...held,
        idle: { ...held.idle!, humanGate: { ...held.idle!.humanGate!, assignedTo: w.reader.actorId } },
      }),
    ).toEqual({ ok: true });
    expect(await w.home.snapshot(w.reader)).toMatchObject({
      moving: [],
      waiting: [],
      needsYou: [{ unit: { unit: "original-work:U10" } }],
    });
    expect(await w.home.pipeline(w.reader, w.instance.id)).toMatchObject({
      movingUnitKeys: [],
      pipeline: { moving: 0, waiting: 0, needsYou: 1 },
    });
  });
  it.each([
    { kind: "none" },
    { kind: "user-is", userId: "slack:other" },
    { kind: "organizations-in", organizationIds: new Set(["foreign"]) },
  ] as Predicate[])("discloses no work through denied visibility %j", async (visibleTo) => {
    const w = await fixture();
    const read = await w.home.snapshot({ ...w.reader, visibleTo });
    expect(read.moving).toEqual([]);
    expect(read.waiting).toEqual([]);
    expect(read.pipelines).toEqual([]);
  });
  it("reports a failed durable read as partial while retaining the authorized canonical unit", async () => {
    const w = await fixture();
    const home = createHomeService({
      organizationId: "sample",
      instances: w.instances,
      liveUnitRuns: (predicate) =>
        homeLiveUnitRuns(
          {
            registry: w.registry,
            now: w.now,
            ledger: {
              listLive: async () => {
                throw new Error("private failure detail");
              },
            },
          },
          predicate,
        ),
    });
    const read = await home.snapshot(w.reader);
    expect(read.status).toBe("partial");
    expect(read.moving).toEqual([]);
    expect(read.waiting.map((row) => row.unit.unit)).toEqual(["original-work:U10"]);
    expect(JSON.stringify(read)).not.toContain("private failure detail");
  });
  it("refuses an incomplete Worker live response instead of reporting a complete movement census", async () => {
    const w = await fixture();
    const ledger = new WorkerRunLedger({
      baseUrl: "https://memory.test",
      token: "fixture-token",
      storeKey: "runs:default",
      fetch: async () => Response.json({ runs: await w.ledger.listLive(), nextBefore: 5 }),
    });
    const home = createHomeService({
      organizationId: "sample",
      instances: w.instances,
      liveUnitRuns: (predicate) => homeLiveUnitRuns({ registry: w.registry, ledger, now: w.now }, predicate),
    });
    expect(await home.snapshot(w.reader)).toMatchObject({
      status: "partial",
      moving: [],
      waiting: [{ unit: { unit: "original-work:U10" } }],
    });
  });
});
