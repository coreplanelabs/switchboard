import { describe, expect, it } from "vitest";
import { InMemoryCoordinatorInstanceStore } from "../coordinator/instanceStore.js";
import type { CoordinatorInstance, CoordinatorUnit } from "../coordinator/contract.js";
import { createHomeService } from "./service.js";
import { createHomeConditionReader } from "./conditions.js";
const instance: CoordinatorInstance = {
  id: "question-work",
  kind: "ship",
  userId: "slack:requester",
  channelId: "slack:private",
  threadKey: "slack:private:1.0",
  repo: "example/app",
  branch: "work",
  createdAt: 1,
};
const gate = {
  pr: { number: 12, url: "https://github.com/example/app/pull/12" },
  round: 1,
  verdict: "request_changes" as const,
  askedAt: 2,
  findings: [
    { id: "F1", severity: "minor" as const, file: "app.ts", title: "Choose the behavior", humanGated: true as const },
  ],
};
const row = (unit: string, assignedTo?: string): CoordinatorUnit => ({
  instanceId: instance.id,
  unit,
  slug: unit.toLowerCase(),
  branch: `work/${unit}`,
  dependsOn: [],
  rounds: [],
  idle: {
    why: "held",
    at: 2,
    renewalsLeft: 0,
    spendUsd: 0,
    wakes: 0,
    from: "coding",
    humanGate: { ...gate, ...(assignedTo ? { assignedTo } : {}) },
  },
});
describe("Home recorded condition projection", () => {
  it("shows a recorded runtime failure with its work and keeps the next act unknown when no inspection thread exists", async () => {
    const instances = new InMemoryCoordinatorInstanceStore();
    await instances.put(instance);
    await instances.putUnits([
      {
        ...row("failure"),
        idle: undefined,
        ending: { kind: "failed", cause: "step_threw", step: "failure/start", report: "untrusted retry prose", at: 5 },
      },
    ]);
    const home = createHomeService({
      organizationId: "example",
      instances,
      conditions: createHomeConditionReader(instances),
    });
    const snapshot = await home.snapshot({ actorId: instance.userId, visibleTo: { kind: "all" } });
    expect(snapshot.needsYou).toEqual([]);
    expect(snapshot.waiting[0]?.conditions[0]?.summary).toBe(
      "The original work stopped because a recorded operation failed.",
    );
    expect(snapshot.waiting[0]?.conditions[0]?.owner).toEqual({ kind: "unknown" });
    expect(snapshot.waiting[0]?.nextAction).toEqual({ kind: "unknown" });
    await instances.putUnits([
      {
        ...row("inspect"),
        idle: undefined,
        threadKey: "slack:private:inspection",
        ending: {
          kind: "interrupted",
          report: "Do not infer this recovery instruction",
          at: 6,
          outcome: { schemaVersion: 1, kind: "interrupted", reviewRounds: 1 },
        },
      },
    ]);
    const recorded = (await home.snapshot({ actorId: instance.userId, visibleTo: { kind: "all" } })).waiting.find(
      (item) => item.unit.id === "inspect",
    );
    expect(recorded?.unit.threads.coding).toBe("slack:private:inspection");
    expect(recorded?.nextAction).toEqual({
      kind: "recorded",
      text: "Inspect the recorded failure in its existing work thread.",
    });
  });

  it("reads a thousand canonical questions once per pipeline and observes a changed assignment on the next snapshot", async () => {
    class CountingInstances extends InMemoryCoordinatorInstanceStore {
      reads = 0;
      override async listUnits(id: string) {
        this.reads++;
        return super.listUnits(id);
      }
    }
    const instances = new CountingInstances();
    await instances.put(instance);
    await instances.putUnits(Array.from({ length: 1000 }, (_, i) => row(`U${i + 10}`, "access:reader")));
    const home = createHomeService({
      organizationId: "example",
      instances,
      conditions: createHomeConditionReader(instances),
    });
    const viewer = { actorId: "access:reader", visibleTo: { kind: "all" as const } };
    const first = await home.snapshot(viewer);
    expect(first.status).toBe("complete");
    expect(first.needsYou).toHaveLength(1000);
    expect(instances.reads).toBe(1);
    await instances.putUnits([row("U10", "access:another")]);
    const next = await home.snapshot(viewer);
    expect(next.needsYou).toHaveLength(999);
    expect(next.waiting.map((item) => item.unit.unit)).toEqual(["question-work:U10"]);
    expect(next.waiting[0]?.conditions[0]?.owner).toEqual({ kind: "person", id: "access:another" });
    expect(instances.reads).toBe(2);
  });
  it("keeps a consumed answer out of attention while a new recorded question remains actionable", async () => {
    const instances = new InMemoryCoordinatorInstanceStore();
    const questionRow = row("U10", "access:reader");
    await instances.put(instance);
    await instances.putUnits([questionRow]);
    const home = createHomeService({
      organizationId: "example",
      instances,
      conditions: createHomeConditionReader(instances),
    });
    const viewer = { actorId: "access:reader", visibleTo: { kind: "all" as const } };
    expect((await home.snapshot(viewer)).needsYou.map((item) => item.unit.unit)).toEqual(["question-work:U10"]);
    const key = { instanceId: instance.id, unit: "U10" };
    expect(
      await instances.appendEvent(
        key,
        {
          id: "browser:recorded-answer",
          sender: "access:reader",
          text: "Use the documented behavior",
          mode: "wake",
          at: 3,
        },
        true,
        undefined,
        undefined,
        { expectedQuestion: questionRow.idle!.humanGate! },
      ),
    ).toEqual({ ok: true, seq: 1 });
    expect(await instances.markConsumed(key, [1], "original-owner-run")).toEqual({ ok: true });
    const answered = await home.snapshot(viewer);
    expect(answered.needsYou).toEqual([]);
    expect(answered.waiting.map((item) => item.unit.unit)).toEqual(["question-work:U10"]);
    await instances.putUnits([
      {
        ...questionRow,
        idle: {
          ...questionRow.idle!,
          humanGate: { ...questionRow.idle!.humanGate!, askedAt: 4 },
        },
      },
    ]);
    expect((await home.snapshot(viewer)).needsYou.map((item) => item.unit.unit)).toEqual(["question-work:U10"]);
  });
  it("puts only the recorded assignee in You and keeps a legacy question unknown", async () => {
    const instances = new InMemoryCoordinatorInstanceStore();
    await instances.put(instance);
    await instances.putUnits([row("U10", "access:reader"), row("U11")]);
    const home = createHomeService({
      organizationId: "example",
      instances,
      conditions: createHomeConditionReader(instances),
    });
    const snapshot = await home.snapshot({ actorId: "access:reader", visibleTo: { kind: "all" } });
    expect(snapshot.needsYou.map((x) => x.unit.unit)).toEqual(["question-work:U10"]);
    expect(snapshot.waiting.map((x) => x.unit.unit)).toEqual(["question-work:U11"]);
    expect(snapshot.waiting[0]?.conditions[0]?.owner).toEqual({ kind: "unknown" });
    expect(snapshot.needsYou[0]?.nextAction).toEqual({
      kind: "recorded",
      text: "Answer the recorded question.",
    });
  });
  it("does not expose a private worker's question or invent an empty read after store failure", async () => {
    const privateRow = { ...row("U10", "access:reader"), workBrief: {} as CoordinatorUnit["workBrief"] };
    const reader = createHomeConditionReader({ listUnits: async () => [privateRow] });
    expect(await reader.list("question-work:U10")).toEqual([]);
    const broken = createHomeConditionReader({
      listUnits: async () => {
        throw new Error("unavailable");
      },
    });
    await expect(broken.list("question-work:U10")).rejects.toThrow("unavailable");
  });
  it("uses only the matching canonical projection row and keeps standalone question reads fresh", async () => {
    const instances = new InMemoryCoordinatorInstanceStore();
    await instances.put(instance);
    await instances.putUnits([row("U10", "access:first")]);
    const reader = createHomeConditionReader(instances);
    expect((await reader.list("question-work:U10"))[0]?.owner).toEqual({ kind: "person", id: "access:first" });
    await instances.putUnits([row("U10", "access:next")]);
    expect((await reader.list("question-work:U10"))[0]?.owner).toEqual({ kind: "person", id: "access:next" });
    await expect(reader.list("question-work:U10", row("U11", "access:first"))).rejects.toThrow(
      "The work question is unavailable.",
    );
  });
});
