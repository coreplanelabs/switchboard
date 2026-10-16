// Feature: docs/reference/specs/browser-home.md — focused canonical history and original-owner questions.
import { describe, expect, it } from "vitest";
import { actor } from "../core/authz/testing.js";
import type { CommandDef } from "../core/commandRegistry.js";
import type { CoordinatorInstance, CoordinatorUnit } from "../core/coordinator/contract.js";
import { InMemoryCoordinatorInstanceStore } from "../core/coordinator/instanceStore.js";
import { seedCoordinatorInstance, seedCoordinatorUnit } from "../core/testing/coordinatorInstance.js";
import { InMemoryConfirmationStore } from "../core/confirmations.js";
import { RunRegistry } from "../core/runRegistry.js";
import { InMemoryRunStore } from "../core/runStore.js";
import { createRunsService } from "../core/runsService.js";
import type { RunRecord } from "../core/runRecord.js";
import { analyzeRunFriction } from "../core/runFriction.js";
import type { HomeRuntimeContext } from "./homeRuntime.js";
import { createHomeThreadProjection } from "./homeThreadProjection.js";
import { withWorkViewScope } from "./workViewScope.js";

const ctx: HomeRuntimeContext = {
  actor: withWorkViewScope(actor("user", "access:alice", { actions: "all", channels: "all", repos: "all" }), {
    mode: "everyone",
    ownerIds: [],
    canEveryone: true,
  }),
  authentication: {
    source: "browser",
    kind: "human",
    identity: { issuer: "access:test", tenant: null, subject: "alice" },
  },
};
const thread = "slack:C1:1.0";
const instance: CoordinatorInstance = {
  id: "fixture",
  kind: "ship",
  userId: "slack:UALICE",
  channelId: "slack:C1",
  threadKey: thread,
  repo: "sample/api",
  branch: "work/fixture",
  createdAt: 1000,
};
const unit: CoordinatorUnit = {
  instanceId: "fixture",
  unit: "review",
  slug: "fixture",
  branch: "work/fixture",
  dependsOn: [],
  rounds: [],
  threadKey: thread,
  idle: {
    why: "human_gated",
    at: 1000,
    renewalsLeft: 1,
    wakes: 0,
    spendUsd: null,
    humanGate: {
      assignedTo: "slack:UALICE",
      pr: { number: 42, url: "https://github.com/sample/api/pull/42" },
      round: 1,
      findings: [],
      verdict: "approve",
      askedAt: 1000,
      headSha: "a".repeat(40),
    },
  },
};
function record(id: string, userId = "slack:UMORGAN"): RunRecord {
  return {
    id,
    channelId: "slack:C1",
    channelVisibility: "public",
    userId,
    threadKey: thread,
    parentInstanceId: "fixture",
    idempotencyKey: `fixture:${id}`,
    agent: "review",
    startedAt: 1000,
    finishedAt: 2000,
    status: "completed",
    eventCount: 2,
    storedEventCount: 2,
    truncated: false,
    diagnosis: analyzeRunFriction([]),
    events: [
      { type: "input", text: "Morgan's request", messageId: id, seq: 1 },
      { type: "answer", text: "Recorded answer", seq: 2 },
    ],
  };
}
async function fixture() {
  const coordinator = new InMemoryCoordinatorInstanceStore();
  seedCoordinatorInstance(coordinator, instance);
  seedCoordinatorUnit(coordinator, unit);
  const registry = new RunRegistry();
  const store = new InMemoryRunStore({ now: () => 2000 });
  expect((await store.put(record("r1"))).stored).toBe(true);
  const service = createRunsService({ registry, store, units: coordinator });
  const confirmations = new InMemoryConfirmationStore({ clock: () => 1000 });
  const projection = createHomeThreadProjection({
    service,
    registry,
    coordinator,
    confirmations,
    intake: null,
    retention: { retentionDays: 30 },
    commands: {
      list: () =>
        [
          { id: "help.show", action: "help:read", describe: "Help", effect: "read" },
          { id: "runs.list", action: "runs:read", describe: "Runs", effect: "read", surfaces: { chat: false } },
        ] as unknown as CommandDef<unknown>[],
    },
    canWriteThread: async () => true,
    provedActorIds: async () => ["access:alice"],
  });
  return { projection, coordinator, store, confirmations };
}
describe("focused browser thread projection", () => {
  it("keeps credited work in Mine without calling a relayed service request You", async () => {
    const h = await fixture();
    await h.store.put({
      ...record("relay", "access:alice"),
      authenticatedAs: "access:alice",
      postedBy: "http:automation",
    });
    const mine = { ...ctx, actor: actor("user", "access:alice", { actions: "all", channels: "all", repos: "all" }) };
    const read = await h.projection.readThread(mine, thread);
    expect(read?.entries.find((entry) => entry.id === "relay:request")).toMatchObject({
      content: "Morgan's request",
      isViewer: false,
      authorLabel: "http:automation on behalf of access:alice",
    });
    expect(read?.turns?.flatMap((turn) => ("kind" in turn ? [] : [turn.id]))).toEqual(["relay"]);
    await h.store.put({ ...record("own", "access:alice"), authenticatedAs: "access:alice" });
    const own = await h.projection.readThread(mine, thread);
    expect(own?.entries.find((entry) => entry.id === "own:request")).toMatchObject({
      isViewer: true,
      authorLabel: "You",
    });
  });
  it("uses current readable runs and proved authorship while keeping legacy coverage partial", async () => {
    const h = await fixture();
    const read = await h.projection.readThread(ctx, thread);
    expect(read?.entries).toMatchObject([
      { role: "user", content: "Morgan's request", isViewer: false, authorLabel: "slack:UMORGAN" },
      { role: "assistant", content: "Recorded answer", isViewer: false, authorLabel: "Switchboard" },
      {
        role: "receipt",
        authorLabel: "Pending question",
        content:
          "Review requested for https://github.com/sample/api/pull/42.\nVerdict: approve. Round: 1.\nRecorded head: aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.\nAssigned to: slack:UALICE.",
      },
    ]);
    expect(read?.history.status).toBe("partial");
    expect(read?.turns?.[0]).toMatchObject({ id: "r1", request: "Morgan's request", answer: "Recorded answer" });
    const refused = { ...ctx, actor: actor("user", "access:alice") };
    expect(await h.projection.readThread(refused, thread)).toBeUndefined();
    expect(h.projection.commands(ctx)).toEqual([{ chat: "help show", describe: "Help" }]);
  });
  it("keeps the question revision stable across transcript changes and changes it with the complete owner question", async () => {
    const h = await fixture();
    const first = await h.projection.readThread(ctx, thread);
    expect(first?.target).toEqual({
      key: "fixture:review:question:62288451134758:038a6a900e526283fda1702ad3f2eb3a6b6a8b130096d261ccbcc158084df22e",
      revision: 1,
    });
    expect(first?.revision).toBeGreaterThan(0);
    await h.store.put(record("r2", "slack:UOTHER"));
    expect((await h.projection.readThread(ctx, thread))?.target).toEqual(first?.target);
    seedCoordinatorUnit(h.coordinator, {
      ...unit,
      idle: { ...unit.idle!, humanGate: { ...unit.idle!.humanGate!, headSha: "b".repeat(40) } },
    });
    const next = await h.projection.readThread(ctx, thread);
    expect(next?.revision).not.toBe(first?.revision);
    seedCoordinatorUnit(h.coordinator, { ...unit, idle: undefined });
    const ordinary = await h.projection.readThread(ctx, thread);
    expect(ordinary?.revision).toBe(0);
    expect(ordinary?.target).toBeUndefined();
  });
  it("keeps a consumed canonical answer from reopening the same saved question and offers a changed question", async () => {
    const h = await fixture();
    const key = { instanceId: "fixture", unit: "review" };
    const first = await h.projection.readThread(ctx, thread);
    expect(first?.entries.find((entry) => entry.authorLabel === "Pending question")?.content).toContain(
      "Review requested for https://github.com/sample/api/pull/42.",
    );
    expect(
      await h.coordinator.appendEvent(
        key,
        { id: "browser:answer", sender: "slack:UALICE", text: "Proceed", mode: "steer", at: 2000 },
        true,
        undefined,
        undefined,
        { expectedQuestion: unit.idle!.humanGate! },
      ),
    ).toEqual({ ok: true, seq: 1 });
    expect(await h.coordinator.markConsumed(key, [1], "original-unit-run")).toEqual({ ok: true });
    seedCoordinatorUnit(h.coordinator, { ...unit, idle: undefined });
    seedCoordinatorUnit(h.coordinator, unit);
    const answered = await h.projection.readThread(ctx, thread);
    expect(answered?.entries.map((entry) => entry.authorLabel)).toEqual(["slack:UMORGAN", "Switchboard"]);
    expect(answered?.target).toBeUndefined();
    expect(answered?.revision).toBe(0);
    seedCoordinatorUnit(h.coordinator, {
      ...unit,
      idle: { ...unit.idle!, humanGate: { ...unit.idle!.humanGate!, headSha: "b".repeat(40) } },
    });
    const changed = await h.projection.readThread(ctx, thread);
    expect(changed?.entries.find((entry) => entry.authorLabel === "Pending question")?.content).toContain(
      "Recorded head: bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb.",
    );
    expect(changed?.target?.revision).toBe(1);
    expect(changed?.target?.key).not.toBe(first?.target?.key);
  });
  it("never uses an email alias for a saved confirmation and masks writes while viewing as", async () => {
    const h = await fixture();
    await h.confirmations.put(
      {
        kind: "redispatch",
        id: "c1",
        message: { userId: "slack:UALICE", channelId: "slack:C1", threadKey: thread, text: "Proceed" },
        line: "Proceed",
        code: "question",
        evidence: "Recorded",
      },
      10000,
    );
    const emailLinked = {
      ...ctx,
      actor: { ...ctx.actor, self: ["access:alice", "slack:UALICE"], asUser: { id: "slack:UALICE" } },
    };
    expect((await h.projection.readThread(emailLinked, thread))?.offer).toBeUndefined();
    await h.confirmations.put(
      {
        kind: "redispatch",
        id: "c2",
        message: { userId: "access:alice", channelId: "web:alice", threadKey: thread, text: "Proceed" },
        line: "Proceed",
        code: "question",
        evidence: "Recorded",
      },
      10000,
    );
    expect((await h.projection.readThread(ctx, thread))?.offer).toMatchObject({ id: "c2", line: "Proceed" });
    const viewed = { ...ctx, actor: { ...ctx.actor, viewingAs: { id: "slack:UMORGAN" } } };
    const readonly = await h.projection.readThread(viewed, thread);
    expect(readonly?.canWrite).toBe(false);
    expect(readonly?.offer).toBeUndefined();
  });
});
