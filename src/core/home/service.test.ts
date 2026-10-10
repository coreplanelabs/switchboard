import { describe, expect, it } from "vitest";
import type { CoordinatorInstance, CoordinatorUnit } from "../coordinator/contract.js";
import { InMemoryCoordinatorInstanceStore } from "../coordinator/instanceStore.js";
import { createHomeService, type HomeCondition, type HomeInventory } from "./service.js";

const instance: CoordinatorInstance = {
  id: "old-work",
  kind: "ship",
  userId: "slack:requester",
  channelId: "slack:private",
  threadKey: "slack:private:1.0",
  repo: "example/app",
  branch: "work",
  createdAt: 1,
};
const unit = (id: string, extra: Partial<CoordinatorUnit> = {}): CoordinatorUnit => ({
  instanceId: instance.id,
  unit: id,
  slug: id.toLowerCase(),
  branch: `work/${id}`,
  dependsOn: [],
  rounds: [],
  ...extra,
});
const viewer = { actorId: "access:reader", visibleTo: { kind: "all" as const } };
// Fixed test-only material makes restart and wrong-reader cursor proofs repeatable.
const HISTORY_KEY = new Uint8Array(32).fill(7);
function inventory(rows: CoordinatorUnit[], instances = [instance]): HomeInventory {
  return { listInstances: async () => ({ items: instances, resumeCursor: "first" }), listUnits: async () => rows };
}

describe("Home durable fleet", () => {
  it("keeps old unanswered work visible without any recent or live run", async () => {
    const home = createHomeService({
      organizationId: "organization:example",
      instances: inventory([unit("work-01", { ending: { kind: "held", at: 2, report: "" } })]),
    });
    const view = await home.snapshot(viewer);
    expect(view).toMatchObject({ status: "complete", waiting: [{ unit: { unit: "old-work:work-01" } }] });
    expect(view.pipelines).toMatchObject([{ instance: { id: "old-work" }, unresolved: 1 }]);
  });

  it("collects more than one thousand unresolved units across inventory pages", async () => {
    const first = Array.from({ length: 1000 }, (_, i) => unit(`work-${i}`));
    const secondInstance = { ...instance, id: "new-work" };
    const home = createHomeService({
      organizationId: "organization:example",
      instances: {
        listInstances: async ({ cursor }) =>
          cursor ? { items: [secondInstance] } : { items: [instance], cursor: "next" },
        listUnits: async (id) => (id === instance.id ? first : [unit("work-1000", { instanceId: secondInstance.id })]),
      },
    });
    const view = await home.snapshot(viewer);
    expect(view.status).toBe("complete");
    expect(view.waiting.length).toBe(1001);
    expect(view.waiting.at(-1)).toMatchObject({ unit: { unit: "new-work:work-1000" } });
  });

  it("shows incomplete inventory as partial while keeping the rows already read", async () => {
    const home = createHomeService({
      organizationId: "organization:example",
      instances: {
        listInstances: async ({ cursor }) => {
          if (cursor) throw new Error("private upstream detail");
          return { items: [instance], cursor: "next" };
        },
        listUnits: async () => [unit("work-01")],
      },
    });
    const view = await home.snapshot(viewer);
    expect(view).toMatchObject({ status: "partial", waiting: [{ unit: { unit: "old-work:work-01" } }] });
    expect(JSON.stringify(view)).not.toContain("private upstream detail");
  });

  it("never returns denied instance names or private worker conversation fields", async () => {
    const privateUnit = unit("work-01", {
      title: "secret task",
      threadKey: "private-worker:secret",
      sourceUrl: "https://example.test/private",
      ending: { kind: "held", at: 2, report: "secret report" },
      workBrief: {} as CoordinatorUnit["workBrief"],
    });
    const home = createHomeService({
      organizationId: "organization:example",
      instances: inventory(
        [privateUnit],
        [{ ...instance, label: "secret source request", sourceUrl: "https://example.test/secret" }],
      ),
    });
    const visible = await home.snapshot(viewer);
    expect(visible.waiting).toMatchObject([{ unit: { unit: "old-work:work-01", branch: "work/work-01" } }]);
    expect(JSON.stringify(visible)).not.toContain("secret");
    const hidden = await home.snapshot({ actorId: "access:other", visibleTo: { kind: "user-is", userId: "other" } });
    expect(hidden).toMatchObject({ status: "complete", pipelines: [], waiting: [] });
    expect(JSON.stringify(hidden)).not.toContain("old-work");
  });

  it("puts only an explicitly assigned question in personal attention", async () => {
    const home = createHomeService({
      organizationId: "organization:example",
      instances: inventory([unit("work-01"), unit("work-02"), unit("work-03"), unit("work-04")]),
      conditions: {
        list: async (unitKey) => [
          {
            id: `question:${unitKey}`,
            unitKey,
            revision: 1,
            state: "open",
            owner: unitKey.endsWith("work-01")
              ? { kind: "person", id: "access:reader" }
              : unitKey.endsWith("work-02")
                ? { kind: "person", id: "access:someone-else" }
                : unitKey.endsWith("work-03")
                  ? { kind: "automation", class: "review" }
                  : { kind: "external", label: "GitHub checks" },
            summary: "A decision is pending",
            nextAction: "Answer the question",
          },
        ],
      },
    });
    const result = await home.snapshot(viewer);
    expect(result.needsYou.map((row) => row.unit.unit)).toEqual(["old-work:work-01"]);
    expect(result.waiting.map((row) => row.unit.unit)).toEqual([
      "old-work:work-02",
      "old-work:work-03",
      "old-work:work-04",
    ]);
    expect(result.needsYou[0]!.nextAction).toEqual({ kind: "recorded", text: "Answer the question" });
    const originalRequester = await home.snapshot({ ...viewer, actorId: instance.userId });
    expect(originalRequester.needsYou).toEqual([]);
    expect(originalRequester.waiting.length).toBe(4);
  });

  it("uses live evidence for moving work and leaves unknown next actions unknown", async () => {
    const home = createHomeService({
      organizationId: "organization:example",
      instances: inventory([unit("work-01"), unit("work-02", { ending: { kind: "no_verdict", report: "", at: 2 } })]),
      liveUnitKeys: async () => new Set(["old-work:work-01"]),
    });
    expect(await home.snapshot(viewer)).toMatchObject({
      status: "complete",
      needsYou: [],
      moving: [{ unit: { unit: "old-work:work-01" }, nextAction: { kind: "unknown" } }],
      waiting: [{ unit: { unit: "old-work:work-02" } }],
      pipelines: [{ unresolved: 2, moving: 1, waiting: 1 }],
    });
  });

  it("pages completed history separately and keeps held and stopped work unresolved", async () => {
    const home = createHomeService({
      organizationId: "organization:example",
      historyCursorKey: HISTORY_KEY,
      instances: inventory([
        unit("work-01", { ending: { kind: "merged", report: "", at: 4 } }),
        unit("work-02", { ending: { kind: "already_landed", report: "", at: 3 } }),
        unit("work-03", { ending: { kind: "held", report: "", at: 2 } }),
        unit("work-04", { ending: { kind: "stopped", report: "", at: 1 } }),
      ]),
    });
    const homeRows = await home.snapshot(viewer);
    expect(homeRows.waiting.map((row) => row.unit.unit)).toEqual(["old-work:work-03", "old-work:work-04"]);
    const first = await home.history(viewer, { limit: 1 });
    expect(first).toMatchObject({
      status: "complete",
      units: [{ unit: { unit: "old-work:work-01" } }],
      cursor: expect.any(String),
    });
    const next = await home.history(viewer, { limit: 1, cursor: first.cursor });
    expect(next.units.map((row) => row.unit.unit)).toEqual(["old-work:work-02"]);
    expect(next.cursor).toBeUndefined();
    expect(await home.history({ ...viewer, visibleTo: { kind: "none" } })).toEqual({
      organizationId: "organization:example",
      status: "complete",
      units: [],
    });
  });

  it("bounds a cyclic inventory cursor and exposes failure before the first row", async () => {
    const looping = createHomeService({
      organizationId: "organization:example",
      instances: {
        listInstances: async () => ({ items: [instance], cursor: "same" }),
        listUnits: async () => [unit("work-01")],
      },
    });
    expect(await looping.snapshot(viewer)).toMatchObject({
      status: "partial",
      waiting: [{ unit: { unit: "old-work:work-01" } }],
    });
    const unavailable = createHomeService({
      organizationId: "organization:example",
      instances: {
        listInstances: async () => {
          throw new Error("database failed");
        },
        listUnits: async () => [],
      },
    });
    expect(await unavailable.snapshot(viewer)).toEqual({
      organizationId: "organization:example",
      status: "unavailable",
      access: "authorized",
      needsYou: [],
      moving: [],
      waiting: [],
      pipelines: [],
    });
  });

  it("rejects foreign and ambiguous condition facts without inventing personal urgency", async () => {
    const question = {
      id: "question",
      unitKey: "old-work:work-01",
      revision: 1,
      state: "open" as const,
      owner: { kind: "person" as const, id: "access:reader" },
      summary: "Please decide",
      nextAction: "Answer the question",
    };
    const home = createHomeService({
      organizationId: "organization:example",
      instances: inventory([unit("work-01"), unit("work-02")]),
      conditions: {
        list: async (key) =>
          key.endsWith("work-01") ? [question, { ...question, revision: 2, state: "resolved" }] : [question],
      },
    });
    expect(await home.snapshot(viewer)).toMatchObject({
      status: "partial",
      needsYou: [],
      waiting: [
        { unit: { unit: "old-work:work-01" }, conditions: [], nextAction: { kind: "unknown" } },
        { unit: { unit: "old-work:work-02" }, conditions: [], nextAction: { kind: "unknown" } },
      ],
    });
  });

  it("shows the assigned question's next action ahead of another wait on the same unit", async () => {
    const home = createHomeService({
      organizationId: "organization:example",
      instances: inventory([unit("work-01")]),
      conditions: {
        list: async (unitKey) => [
          {
            id: "checks",
            unitKey,
            revision: 1,
            state: "open",
            owner: { kind: "external", label: "GitHub" },
            summary: "Checks are running",
            nextAction: "Wait for checks",
          },
          {
            id: "question",
            unitKey,
            revision: 1,
            state: "open",
            owner: { kind: "person", id: "access:reader" },
            summary: "Approval needed",
            nextAction: "Answer the question",
          },
        ],
      },
    });
    expect(await home.snapshot(viewer)).toMatchObject({
      needsYou: [{ unit: { unit: "old-work:work-01" }, nextAction: { kind: "recorded", text: "Answer the question" } }],
    });
  });

  it("labels a restricted fleet view without claiming the whole organization is caught up", async () => {
    const home = createHomeService({ organizationId: "organization:example", instances: inventory([unit("work-01")]) });
    const restricted = await home.snapshot({ ...viewer, visibleTo: { kind: "user-is", userId: instance.userId } });
    expect(restricted).toMatchObject({
      access: "filtered",
      status: "complete",
      waiting: [{ unit: { unit: "old-work:work-01" } }],
    });
    expect((await home.snapshot(viewer)).access).toBe("authorized");
  });

  it("continues completed history beyond its unit scan bound", async () => {
    const home = createHomeService({
      organizationId: "organization:example",
      historyCursorKey: HISTORY_KEY,
      maxUnits: 2,
      instances: inventory(
        ["work-01", "work-02", "work-03"].map((id) => unit(id, { ending: { kind: "merged", at: 1, report: "" } })),
      ),
    });
    const first = await home.history(viewer);
    expect(first).toMatchObject({
      status: "partial",
      units: [{ unit: { unit: "old-work:work-01" } }, { unit: { unit: "old-work:work-02" } }],
      cursor: expect.any(String),
    });
    const next = await home.history(viewer, { cursor: first.cursor });
    expect(next).toMatchObject({ status: "complete", units: [{ unit: { unit: "old-work:work-03" } }] });
    expect(next.cursor).toBeUndefined();
  });

  it("continues completed history beyond its inventory page bound", async () => {
    const second = { ...instance, id: "subsequent-work" };
    const home = createHomeService({
      organizationId: "organization:example",
      historyCursorKey: HISTORY_KEY,
      maxPages: 1,
      instances: {
        listInstances: async ({ cursor }) =>
          cursor === "second"
            ? { items: [second], resumeCursor: "second" }
            : { items: [instance], cursor: "second", resumeCursor: "first" },
        listUnits: async (id) => [unit("work-01", { instanceId: id, ending: { kind: "merged", at: 1, report: "" } })],
      },
    });
    const first = await home.history(viewer);
    expect(first).toMatchObject({
      status: "partial",
      units: [{ unit: { unit: "old-work:work-01" } }],
      cursor: expect.any(String),
    });
    const next = await home.history(viewer, { cursor: first.cursor });
    expect(next).toMatchObject({ status: "complete", units: [{ unit: { unit: "subsequent-work:work-01" } }] });
    expect(next.cursor).toBeUndefined();
  });

  it("advances through unresolved rows that exhaust the scan before completed history", async () => {
    const home = createHomeService({
      organizationId: "organization:example",
      historyCursorKey: HISTORY_KEY,
      maxUnits: 2,
      instances: inventory([
        unit("work-01"),
        unit("work-02"),
        unit("work-03", { ending: { kind: "merged", at: 1, report: "" } }),
      ]),
    });
    const first = await home.history(viewer);
    expect(first).toMatchObject({ status: "partial", units: [], cursor: expect.any(String) });
    const next = await home.history(viewer, { cursor: first.cursor });
    expect(next).toMatchObject({ status: "complete", units: [{ unit: { unit: "old-work:work-03" } }] });
    expect(next.cursor).toBeUndefined();
  });

  it("preserves global unit-key order even when pipelines were inserted in reverse order", async () => {
    const store = new InMemoryCoordinatorInstanceStore();
    for (const id of ["z-work", "a", "a-2"]) {
      await store.put({ ...instance, id });
      await store.putUnits([
        unit("work-02", { instanceId: id, ending: { kind: "merged", at: 1, report: "" } }),
        unit("work-01", { instanceId: id, ending: { kind: "merged", at: 1, report: "" } }),
      ]);
    }
    const home = createHomeService({
      organizationId: "organization:example",
      historyCursorKey: HISTORY_KEY,
      instances: store,
    });
    const first = await home.history(viewer, { limit: 3 });
    expect(first.units.map((row) => row.unit.unit)).toEqual(["a-2:work-01", "a-2:work-02", "a:work-01"]);
    const next = await home.history(viewer, { limit: 3, cursor: first.cursor });
    expect(next.units.map((row) => row.unit.unit)).toEqual(["a:work-02", "z-work:work-01", "z-work:work-02"]);
    expect(next.cursor).toBeUndefined();
  });

  it("keeps an encrypted history census stable across service replacement and later insertions", async () => {
    const store = new InMemoryCoordinatorInstanceStore();
    await store.put(instance);
    await store.putUnits(
      ["work-01", "work-02", "work-03"].map((id) => unit(id, { ending: { kind: "merged", at: 1, report: "" } })),
    );
    const deps = {
      organizationId: "organization:example",
      historyCursorKey: HISTORY_KEY,
      maxUnits: 2,
      instances: store,
    };
    const first = await createHomeService(deps).history(viewer);
    expect(first).toMatchObject({
      status: "partial",
      units: [{ unit: { unit: "old-work:work-01" } }, { unit: { unit: "old-work:work-02" } }],
      cursor: expect.any(String),
    });
    await store.put({ ...instance, id: "later-insertion" });
    await store.putUnits([
      unit("work-01", { instanceId: "later-insertion", ending: { kind: "merged", at: 1, report: "" } }),
    ]);
    const resumed = await createHomeService(deps).history(viewer, { cursor: first.cursor });
    expect(resumed).toMatchObject({ status: "complete", units: [{ unit: { unit: "old-work:work-03" } }] });
    expect(resumed.cursor).toBeUndefined();
    const fresh = await createHomeService({ ...deps, maxUnits: 100 }).history(viewer);
    expect(fresh.units.map((row) => row.unit.unit)).toEqual([
      "later-insertion:work-01",
      "old-work:work-01",
      "old-work:work-02",
      "old-work:work-03",
    ]);
  });

  it("binds encrypted history cursors to the reader and organization while reauthorizing every page", async () => {
    const deps = {
      organizationId: "organization:example",
      historyCursorKey: HISTORY_KEY,
      maxUnits: 1,
      instances: inventory([
        unit("work-01", { ending: { kind: "merged", at: 1, report: "" } }),
        unit("work-02", { ending: { kind: "merged", at: 1, report: "" } }),
      ]),
    };
    const first = await createHomeService(deps).history(viewer);
    expect(first).toMatchObject({
      status: "partial",
      units: [{ unit: { unit: "old-work:work-01" } }],
      cursor: expect.any(String),
    });
    const resumed = await createHomeService(deps).history(viewer, { cursor: first.cursor });
    expect(resumed.units.map((row) => row.unit.unit)).toEqual(["old-work:work-02"]);
    await expect(
      createHomeService(deps).history({ ...viewer, actorId: "access:other" }, { cursor: first.cursor }),
    ).rejects.toThrow("Home history cursor is invalid for this reader");
    await expect(
      createHomeService({ ...deps, organizationId: "organization:other" }).history(viewer, { cursor: first.cursor }),
    ).rejects.toThrow("Home history cursor is invalid for this reader");
    const token = first.cursor!;
    const tampered = token.slice(0, -2) + (token.at(-2) === "A" ? "B" : "A") + token.at(-1);
    await expect(createHomeService(deps).history(viewer, { cursor: tampered })).rejects.toThrow(
      "Home history cursor is invalid for this reader",
    );
    expect(
      await createHomeService(deps).history(
        { ...viewer, visibleTo: { kind: "user-is", userId: "another" } },
        { cursor: first.cursor },
      ),
    ).toEqual({ organizationId: "organization:example", status: "complete", units: [] });
    expect(token).not.toContain("old-work");
    expect(token).not.toContain("first");
  });

  it("returns truthful partial history without a continuation when its installation key is absent", async () => {
    const rows = [
      unit("work-01", { ending: { kind: "merged", at: 1, report: "" } }),
      unit("work-02", { ending: { kind: "merged", at: 1, report: "" } }),
    ];
    const incomplete = await createHomeService({
      organizationId: "organization:example",
      instances: inventory(rows),
      maxUnits: 1,
    }).history(viewer);
    expect(incomplete).toMatchObject({ status: "partial", units: [{ unit: { unit: "old-work:work-01" } }] });
    expect(incomplete.cursor).toBeUndefined();
    const complete = await createHomeService({
      organizationId: "organization:example",
      instances: inventory(rows),
    }).history(viewer);
    expect(complete.units.map((row) => row.unit.unit)).toEqual(["old-work:work-01", "old-work:work-02"]);
    expect(complete.status).toBe("complete");
  });

  it.each(["failed", "malformed", "foreign", "duplicate"])(
    "retains apparently completed work as unresolved when its condition read is %s",
    async (failure) => {
      const home = createHomeService({
        organizationId: "organization:example",
        instances: inventory(
          [
            unit("work-01", { ending: { kind: "merged", at: 1, report: "" } }),
            unit("work-02", { ending: { kind: "already_landed", at: 1, report: "" } }),
            unit("work-03", { ending: { kind: "stopped", at: 1, report: "" } }),
          ],
          [{ ...instance, stop: { at: 1 } }],
        ),
        conditions: {
          list: async (unitKey) => {
            if (failure === "failed") throw new Error("condition store unavailable");
            const condition: HomeCondition = {
              id: "question",
              unitKey,
              revision: 1,
              state: "open",
              owner: { kind: "person", id: viewer.actorId },
              summary: "Answer needed",
              nextAction: "Answer the question",
            };
            return failure === "malformed"
              ? [null as unknown as HomeCondition]
              : failure === "foreign"
                ? [{ ...condition, unitKey: "another:work" }]
                : [condition, { ...condition, revision: 2, state: "resolved" }];
          },
        },
      });
      const view = await home.snapshot(viewer);
      expect(view).toMatchObject({
        status: "partial",
        needsYou: [],
        moving: [],
        waiting: [
          { unit: { unit: "old-work:work-01" }, conditions: [], nextAction: { kind: "unknown" } },
          { unit: { unit: "old-work:work-02" }, conditions: [], nextAction: { kind: "unknown" } },
          { unit: { unit: "old-work:work-03" }, conditions: [], nextAction: { kind: "unknown" } },
        ],
      });
      expect(await home.history(viewer)).toMatchObject({ status: "partial", units: [] });
    },
  );
});
