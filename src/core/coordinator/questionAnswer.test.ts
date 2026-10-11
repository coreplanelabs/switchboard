import { describe, expect, it } from "vitest";
import { InMemoryCoordinatorInstanceStore } from "./instanceStore.js";
import type { CoordinatorInstance, CoordinatorUnit } from "./contract.js";
import type { HumanGatePending } from "../ship/coordinator.js";
const instance: CoordinatorInstance = {
  id: "question-owner",
  kind: "ship",
  userId: "slack:owner",
  channelId: "slack:private",
  threadKey: "slack:private:1",
  repo: "example/app",
  branch: "work",
  createdAt: 1,
};
const question: HumanGatePending = {
  pr: { number: 12, url: "https://github.com/example/app/pull/12" },
  round: 1,
  verdict: "request_changes",
  askedAt: 2,
  assignedTo: "slack:owner",
  findings: [{ id: "F1", severity: "minor", file: "app.ts", title: "Choose behavior", humanGated: true }],
};
const row: CoordinatorUnit = {
  instanceId: instance.id,
  unit: "U10",
  slug: "question",
  branch: "work/question",
  dependsOn: [],
  rounds: [],
  idle: { why: "held", from: "coding", at: 2, spendUsd: 0, renewalsLeft: 0, wakes: 0, humanGate: question },
};
const key = { instanceId: instance.id, unit: row.unit };
const answer = {
  id: "browser:original-key",
  sender: "slack:owner",
  text: "Use the documented behavior",
  mode: "wake" as const,
  at: 3,
};
async function fixture() {
  const store = new InMemoryCoordinatorInstanceStore();
  await store.put(instance);
  await store.putUnits([row]);
  return store;
}
describe("Original question answer admission", () => {
  it("refuses to turn an unguarded legacy event into a reserved question answer", async () => {
    const store = await fixture();
    expect(await store.appendEvent(key, answer, true)).toEqual({ ok: true, seq: 1 });
    expect(await store.appendEvent(key, answer, true, undefined, undefined, { expectedQuestion: question })).toEqual({
      ok: false,
      reason: "stale",
    });
    expect(
      await store.appendEvent(key, answer, true, undefined, undefined, {
        expectedQuestion: { ...question, askedAt: 20 },
      }),
    ).toEqual({ ok: false, reason: "stale" });
    const guarded = { ...answer, id: "browser:guarded-key" };
    expect(await store.appendEvent(key, guarded, true, undefined, undefined, { expectedQuestion: question })).toEqual({
      ok: true,
      seq: 2,
    });
    expect(
      await store.appendEvent(key, { ...answer, id: "github:losing-key" }, true, undefined, undefined, {
        expectedQuestion: question,
      }),
    ).toEqual({ ok: false, reason: "stale" });
    expect(await store.listEvents(key, true)).toEqual([
      { ...answer, seq: 1 },
      { ...guarded, seq: 2, questionDigest: "b9257372a2332f7167a46c8cd6a3eb21a918e80af2da4c90f8d31f07d1c650a3" },
    ]);
  });
  it("answers a private original unit's current question once and refuses foreign or stale answers", async () => {
    const store = new InMemoryCoordinatorInstanceStore();
    const privateInstance: CoordinatorInstance = {
      ...instance,
      branch: row.branch,
      base: "main",
      merge: "person",
      plan: { id: "private-decision" },
    };
    const brief: NonNullable<CoordinatorUnit["workBrief"]> = {
      requesterId: instance.userId,
      mainThreadKey: instance.threadKey,
      actId: "decision",
      repo: instance.repo,
      base: "main",
      question: "Private requested change",
      findings: [],
      requestedChange: "Apply requested behavior",
    };
    expect(await store.put(privateInstance)).toEqual({ ok: true });
    expect(await store.putUnits([{ ...row, workBrief: brief }])).toEqual({ ok: true });
    expect(
      await store.appendEvent(key, { ...answer, sender: "access:foreign" }, true, undefined, undefined, {
        expectedQuestion: question,
      }),
    ).toEqual({ ok: false, reason: "stale" });
    expect(
      await store.appendEvent(key, answer, true, undefined, undefined, {
        expectedQuestion: { ...question, askedAt: 10 },
      }),
    ).toEqual({ ok: false, reason: "stale" });
    expect(await store.appendEvent(key, answer, true, undefined, undefined, { expectedQuestion: question })).toEqual({
      ok: true,
      seq: 1,
    });
    expect(await store.appendEvent(key, answer, true, undefined, undefined, { expectedQuestion: question })).toEqual({
      ok: true,
      seq: 1,
    });
    expect(await store.listEvents(key, true)).toEqual([
      { ...answer, seq: 1, questionDigest: "b9257372a2332f7167a46c8cd6a3eb21a918e80af2da4c90f8d31f07d1c650a3" },
    ]);
  });

  it("keeps a changed question and a foreign sender from receiving the old answer", async () => {
    const store = await fixture();
    await store.putUnits([{ ...row, idle: { ...row.idle!, humanGate: { ...question, askedAt: 4 } } }]);
    expect(await store.appendEvent(key, answer, true, undefined, undefined, { expectedQuestion: question })).toEqual({
      ok: false,
      reason: "stale",
    });
    await store.putUnits([row]);
    expect(
      await store.appendEvent(key, { ...answer, sender: "access:unproved" }, true, undefined, undefined, {
        expectedQuestion: question,
      }),
    ).toEqual({ ok: false, reason: "stale" });
    expect(await store.listEvents(key)).toEqual([]);
  });
  it("returns the same saved answer after the question changes and refuses altered reuse", async () => {
    const store = await fixture();
    expect(await store.appendEvent(key, answer, true, undefined, undefined, { expectedQuestion: question })).toEqual({
      ok: true,
      seq: 1,
    });
    await store.putUnits([{ ...row, idle: { ...row.idle!, humanGate: { ...question, askedAt: 4 } } }]);
    expect(await store.appendEvent(key, answer, true, undefined, undefined, { expectedQuestion: question })).toEqual({
      ok: true,
      seq: 1,
    });
    expect(
      await store.appendEvent(key, { ...answer, text: "A different choice" }, true, undefined, undefined, {
        expectedQuestion: question,
      }),
    ).toEqual({ ok: false, reason: "stale" });
    expect(await store.listEvents(key)).toEqual([
      { ...answer, seq: 1, questionDigest: "b9257372a2332f7167a46c8cd6a3eb21a918e80af2da4c90f8d31f07d1c650a3" },
    ]);
  });
  it("records a matched recovered human hold without reopening its execution", async () => {
    const store = await fixture();
    const { idle: _idle, ...base } = row;
    await store.putUnits([
      {
        ...base,
        ending: { kind: "held", at: 2, report: "Waiting for a person" },
        recoveryHold: { cause: "human", gate: question },
      },
    ]);
    expect(await store.appendEvent(key, answer, true, undefined, undefined, { expectedQuestion: question })).toEqual({
      ok: true,
      seq: 1,
    });
    expect((await store.listUnits(instance.id))[0]).toMatchObject({
      ending: { kind: "held" },
      recoveryHold: { cause: "human", gate: question },
    });
  });
  it("admits one answer across concurrent browser and GitHub sources", async () => {
    const store = await fixture();
    const browser = { ...answer, authenticatedAs: "access:owner" };
    const github = { ...answer, id: "github:comment:13", authenticatedAs: "github:owner", text: "Use another choice" };
    expect(
      await Promise.all([
        store.appendEvent(key, browser, true, undefined, undefined, { expectedQuestion: question }),
        store.appendEvent(key, github, true, undefined, undefined, { expectedQuestion: question }),
      ]),
    ).toEqual([
      { ok: true, seq: 1 },
      { ok: false, reason: "stale" },
    ]);
    expect(await store.listEvents(key)).toEqual([
      { ...browser, seq: 1, questionDigest: "b9257372a2332f7167a46c8cd6a3eb21a918e80af2da4c90f8d31f07d1c650a3" },
    ]);
  });

  it("retains a consumed question winner through clearing ending and a new question", async () => {
    const store = await fixture();
    const guard = { expectedQuestion: question };
    expect(await store.appendEvent(key, answer, true, undefined, undefined, guard)).toEqual({ ok: true, seq: 1 });
    expect(await store.markConsumed(key, [1], "original-unit-run")).toEqual({ ok: true });
    const { idle: _question, ...cleared } = row;
    await store.putUnits([cleared]);
    expect(await store.listEvents(key, true)).toEqual([]);
    await store.putUnits([row]);
    expect(
      await store.appendEvent(key, { ...answer, id: "github:second-answer" }, true, undefined, undefined, guard),
    ).toEqual({ ok: false, reason: "stale" });
    await store.putUnits([{ ...cleared, ending: { kind: "closed", at: 4, report: "Question ended" } }]);
    expect(await store.appendEvent(key, answer, true, undefined, undefined, guard)).toEqual({ ok: true, seq: 1 });
    const next = { ...question, askedAt: 5 };
    await store.putUnits([{ ...row, idle: { ...row.idle!, humanGate: next } }]);
    expect(
      await store.appendEvent(key, { ...answer, id: "browser:new-question" }, true, undefined, undefined, {
        expectedQuestion: next,
      }),
    ).toEqual({ ok: true, seq: 2 });
    expect(await store.appendEvent(key, answer, true, undefined, undefined, guard)).toEqual({ ok: true, seq: 1 });
    expect(await store.appendEvent(key, answer, true, undefined, undefined, { expectedQuestion: next })).toEqual({
      ok: false,
      reason: "stale",
    });
  });

  it("ignores unguarded caller question claims and retains the guarded claim under the event cap", async () => {
    const store = await fixture();
    const digest = "b9257372a2332f7167a46c8cd6a3eb21a918e80af2da4c90f8d31f07d1c650a3";
    const plain = { ...answer, id: "unbound:input", questionDigest: digest };
    expect(await store.appendEvent(key, plain)).toEqual({ ok: true, seq: 1 });
    expect(await store.listEvents(key)).toEqual([{ ...answer, id: "unbound:input", seq: 1 }]);
    const large = { ...answer, text: "x".repeat(500 * 1024), questionDigest: "f".repeat(64) };
    const guard = { expectedQuestion: question };
    expect(await store.appendEvent(key, large, true, undefined, undefined, guard)).toEqual({ ok: true, seq: 2 });
    const saved = (await store.listEvents(key))[1]!;
    expect(saved.questionDigest).toBe(digest);
    expect(saved.textDropped).toBeGreaterThan(0);
    expect(new TextEncoder().encode(JSON.stringify(saved)).length).toBeLessThanOrEqual(400 * 1024);
    expect(await store.appendEvent(key, large, true, undefined, undefined, guard)).toEqual({ ok: true, seq: 2 });
    expect(
      await store.appendEvent(key, { ...answer, id: "github:after-large" }, true, undefined, undefined, guard),
    ).toEqual({ ok: false, reason: "stale" });
  });
});
