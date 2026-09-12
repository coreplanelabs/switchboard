import { describe, expect, it } from "vitest";
import type { IndexEvent } from "./indexFeed.js";
import { call, testRegistry } from "./testing.js";

// Feature: docs/reference/specs/run-history.md, docs/reference/specs/run-visibility.md
// — the shapes the registry projects a run onto: the summary's terminal fields
// and the snapshot's record inputs, proven through the registry's reads.

describe("RunRegistry — terminal status + finishedAt on the summary; truncated on the snapshot (review)", () => {
  it("finish(id, status) stores the status: the summary and the index upsert carry `status` and `finishedAt`; a live run has neither", () => {
    const { reg, tick } = testRegistry();
    const run = reg.create("l", { channelId: "slack:C1", userId: "slack:UALICE", threadKey: "slack:C1:1" });
    const live = reg.getById(run.id)!;
    expect("status" in live).toBe(false);
    expect("finishedAt" in live).toBe(false);
    const events: IndexEvent[] = [];
    reg.subscribeIndex((e) => events.push(e));
    tick(5000);
    reg.finish(run.id, "stopped_soft");
    const done = reg.getById(run.id)!;
    expect(done).toMatchObject({ finished: true, status: "stopped_soft", finishedAt: 6000 });
    const upsert = events.find((e) => e.type === "upsert" && e.run.finished);
    expect(upsert).toMatchObject({ type: "upsert", run: { id: run.id, status: "stopped_soft", finishedAt: 6000 } });
  });

  it("finish(id) without a status records finishedAt but no status (an inline run that reports its outcome elsewhere)", () => {
    const { reg } = testRegistry();
    const run = reg.create("l");
    reg.finish(run.id);
    const s = reg.getById(run.id)!;
    expect(s.finishedAt).toBe(1000);
    expect("status" in s).toBe(false);
  });

  it("snapshot/snapshotById report `truncated` when the bounded backlog dropped events (eventCount > events.length)", () => {
    const { reg } = testRegistry({ backlogLimit: 3 });
    const run = reg.create("l");
    for (let i = 0; i < 2; i++) reg.publish(run.id, call(`$ step ${i}`));
    expect(reg.snapshot(run.id, run.token)).toMatchObject({ truncated: false, eventCount: 2 });
    for (let i = 2; i < 5; i++) reg.publish(run.id, call(`$ step ${i}`));
    const snap = reg.snapshotById(run.id)!;
    expect(snap.events).toHaveLength(3);
    expect(snap).toMatchObject({ truncated: true, eventCount: 5 });
  });
});

describe("RunRegistry.snapshot — record inputs", () => {
  it("carries the run's startedAt and the monotonic eventCount alongside the (bounded) backlog", () => {
    const { reg } = testRegistry({ backlogLimit: 2 });
    const { id, token } = reg.create();
    reg.publish(id, call("a"));
    reg.publish(id, call("b"));
    reg.publish(id, call("c"));
    const snap = reg.snapshot(id, token);
    expect(snap?.startedAt).toBe(1000);
    expect(snap?.eventCount).toBe(3);
    expect(snap?.events).toHaveLength(2);
  });

  it("carries receivedAt from the RunMeta onto the summary and the snapshot, and omits it when absent (docs/reference/specs/tracing.md)", () => {
    const { reg } = testRegistry();
    const stamped = reg.create("x", {
      channelId: "slack:C1",
      userId: "slack:UALICE",
      threadKey: "slack:C1:1",
      receivedAt: 900,
    });
    const plain = reg.create("y", { channelId: "slack:C1", userId: "slack:UALICE", threadKey: "slack:C1:2" });
    expect(reg.snapshot(stamped.id, stamped.token)?.receivedAt).toBe(900);
    expect(reg.listActive().find((r) => r.id === stamped.id)?.receivedAt).toBe(900);
    expect("receivedAt" in (reg.snapshot(plain.id, plain.token) ?? {})).toBe(false);
    expect("receivedAt" in (reg.listActive().find((r) => r.id === plain.id) ?? {})).toBe(false);
  });

  // docs/reference/specs/run-history.md item 46: a spawned child's live summary
  // names its parent, so a listing can draw the tree; a run with no parent
  // carries no key.
  it("carries parentRunId from the RunMeta onto the summary and the index feed, and omits it when absent", () => {
    const { reg } = testRegistry();
    const events: IndexEvent[] = [];
    reg.subscribeIndex((e) => events.push(e));
    const child = reg.create("c", {
      channelId: "slack:C1",
      userId: "slack:UALICE",
      threadKey: "slack:C1:9",
      parentRunId: "run-parent",
    });
    const plain = reg.create("p", { channelId: "slack:C1", userId: "slack:UALICE", threadKey: "slack:C1:2" });
    expect(reg.getById(child.id)?.parentRunId).toBe("run-parent");
    expect(events.find((e) => e.type === "upsert" && e.run.id === child.id)).toMatchObject({
      run: { parentRunId: "run-parent" },
    });
    expect("parentRunId" in (reg.getById(plain.id) ?? {})).toBe(false);
  });

  // docs/reference/specs/run-history.md item 48: a coordinator's child names its
  // instance and its spawn's key on the live summary too, so the spawn route
  // reads them from a live run without the record.
  it("carries parentInstanceId and idempotencyKey from the RunMeta onto the summary and the index feed, and omits them when absent", () => {
    const { reg } = testRegistry();
    const events: IndexEvent[] = [];
    reg.subscribeIndex((e) => events.push(e));
    const child = reg.create("c", {
      channelId: "slack:C1",
      userId: "slack:UALICE",
      threadKey: "slack:C1:9",
      parentInstanceId: "ship_acme_1",
      idempotencyKey: "ship_acme_1:u/0/coding",
    });
    const plain = reg.create("p", { channelId: "slack:C1", userId: "slack:UALICE", threadKey: "slack:C1:2" });
    expect(reg.getById(child.id)).toMatchObject({
      parentInstanceId: "ship_acme_1",
      idempotencyKey: "ship_acme_1:u/0/coding",
    });
    expect(events.find((e) => e.type === "upsert" && e.run.id === child.id)).toMatchObject({
      run: { parentInstanceId: "ship_acme_1", idempotencyKey: "ship_acme_1:u/0/coding" },
    });
    expect("parentInstanceId" in (reg.getById(plain.id) ?? {})).toBe(false);
    expect("idempotencyKey" in (reg.getById(plain.id) ?? {})).toBe(false);
  });
});
