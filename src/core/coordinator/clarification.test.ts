import { describe, expect, it } from "vitest";
import type { IncomingMessage } from "../types.js";
import type { RunView } from "../runsService.js";
import type { CoordinatorInstance, CoordinatorUnit } from "./contract.js";
import { InMemoryCoordinatorInstanceStore } from "./instanceStore.js";
import { coordinatorClarificationFor, CoordinatorClarificationRefusal } from "./clarification.js";

async function fixture(platform = "linear", preset: "coding" | "review" = "coding") {
  const msg: IncomingMessage = {
    userId: `${platform}:alice`,
    channelId: `${platform}:team`,
    threadKey: `${platform}:session`,
    text: "Keep the current behavior.",
  };
  const instance: CoordinatorInstance = {
    id: "plan-answer",
    kind: "ship",
    userId: msg.userId,
    channelId: msg.channelId,
    threadKey: `${platform}:parent`,
    repo: "acme/api",
    branch: "plan/answer/u1",
    base: "release",
    createdAt: 0,
    caps: { maxRounds: 3, maxMinutes: 60 },
  };
  const unit: CoordinatorUnit = {
    instanceId: instance.id,
    unit: "U10",
    slug: "u1",
    branch: instance.branch,
    threadKey: preset === "coding" ? msg.threadKey : `${platform}:coding`,
    reviewThread: { threadKey: preset === "review" ? msg.threadKey : `${platform}:review` },
    pr: { number: 7, url: "https://github.com/acme/api/pull/7" },
    dependsOn: [],
    rounds: [],
    startedAt: 60_000,
  };
  const newest: RunView = {
    id: "run-question",
    finished: true,
    status: "completed",
    awaitingInput: true,
    agent: preset,
    startedAt: 60_000,
    eventCount: 1,
    userId: msg.userId,
    channelId: msg.channelId,
    threadKey: msg.threadKey,
    parentInstanceId: instance.id,
    idempotencyKey: `${instance.id}:U10/0/${preset}`,
  };
  const instances = new InMemoryCoordinatorInstanceStore();
  await instances.put(instance);
  await instances.putUnits([unit]);
  return { msg, instance, unit, newest, instances, directives: { text: msg.text }, now: 11 * 60_000 };
}

describe("coordinator clarification context", () => {
  it.each(["linear", "slack"])("keeps the %s unit branch, round, base and remaining clock", async (platform) => {
    const f = await fixture(platform);
    expect(await coordinatorClarificationFor(f)).toMatchObject({
      preset: "coding",
      remainingMinutes: 50,
      targetText: expect.stringContaining(f.unit.branch),
      tag: { parentInstanceId: f.instance.id, idempotencyKey: f.newest.idempotencyKey, base: "release" },
    });
  });

  it("resumes a review against the unit's recorded PR", async () => {
    const f = await fixture("linear", "review");
    expect(await coordinatorClarificationFor(f)).toMatchObject({
      preset: "review",
      targetText: "https://github.com/acme/api/pull/7",
    });
    await f.instances.putUnits([{ ...f.unit, pr: undefined }]);
    await expect(coordinatorClarificationFor(f)).rejects.toThrow(CoordinatorClarificationRefusal);
  });

  it.each(["userId", "channelId", "threadKey", "authenticatedAs", "postedBy"] as const)(
    "refuses a reply with a different %s",
    async (key) => {
      const f = await fixture();
      f.msg[key] = "linear:other";
      await expect(coordinatorClarificationFor(f)).rejects.toThrow(CoordinatorClarificationRefusal);
    },
  );

  it("refuses an ended unit, a foreign round and an exhausted clock", async () => {
    const f = await fixture();
    await f.instances.putUnits([{ ...f.unit, ending: { kind: "stopped", report: "Stopped", at: f.now } }]);
    await expect(coordinatorClarificationFor(f)).rejects.toThrow(CoordinatorClarificationRefusal);
    await f.instances.putUnits([f.unit]);
    await expect(
      coordinatorClarificationFor({ ...f, newest: { ...f.newest, idempotencyKey: "other:U10/0/coding" } }),
    ).rejects.toThrow(CoordinatorClarificationRefusal);
    await expect(coordinatorClarificationFor({ ...f, now: 62 * 60_000 })).rejects.toThrow(/time budget/);
  });

  it("leaves an explicit new agent and settled work independent", async () => {
    const f = await fixture();
    expect(
      await coordinatorClarificationFor({ ...f, directives: { text: f.msg.text, agent: "general" } }),
    ).toBeUndefined();
    expect(
      await coordinatorClarificationFor({ ...f, newest: { ...f.newest, awaitingInput: undefined } }),
    ).toBeUndefined();
  });
});
