import { describe, expect, it } from "vitest";
import type { IndexEvent } from "./indexFeed.js";
import { call, testRegistry } from "./testing.js";

// Feature: docs/reference/specs/live-view.md — the live runs-index feed: the
// active set replayed on subscribe, one upsert per lifecycle step, one removal
// at eviction, a throwing sink isolated — proven through the registry that
// drives the feed.

describe("RunRegistry.subscribeIndex — live runs-index feed", () => {
  it("replays the current active set as upserts on subscribe, newest-first", () => {
    const { reg, tick } = testRegistry();
    reg.create("coding · owner/repo");
    tick(10);
    reg.create("review · thread-42");

    const events: IndexEvent[] = [];
    reg.subscribeIndex((ev) => events.push(ev));

    expect(events).toEqual([
      {
        type: "upsert",
        run: {
          id: "id-2",
          token: "tok-2",
          label: "review · thread-42",
          finished: false,
          startedAt: 1010,
          eventCount: 0,
          stepCount: 0,
        },
      },
      {
        type: "upsert",
        run: {
          id: "id-1",
          token: "tok-1",
          label: "coding · owner/repo",
          finished: false,
          startedAt: 1000,
          eventCount: 0,
          stepCount: 0,
        },
      },
    ]);
  });

  it("replays nothing when there are no active runs", () => {
    const { reg } = testRegistry();
    const events: IndexEvent[] = [];
    reg.subscribeIndex((ev) => events.push(ev));
    expect(events).toEqual([]);
  });

  it("emits an upsert when a run is created", () => {
    const { reg } = testRegistry();
    const events: IndexEvent[] = [];
    reg.subscribeIndex((ev) => events.push(ev));
    reg.create("x");
    expect(events).toEqual([
      {
        type: "upsert",
        run: { id: "id-1", token: "tok-1", label: "x", finished: false, startedAt: 1000, eventCount: 0, stepCount: 0 },
      },
    ]);
  });

  it("emits an upsert with the incremented event count on publish (label omitted when absent)", () => {
    const { reg } = testRegistry();
    const { id } = reg.create();
    const events: IndexEvent[] = [];
    reg.subscribeIndex((ev) => events.push(ev));
    events.length = 0; // drop the create-replay upsert
    reg.publish(id, call("x"));
    expect(events).toEqual([
      {
        type: "upsert",
        run: {
          id: "id-1",
          token: "tok-1",
          finished: false,
          startedAt: 1000,
          eventCount: 1,
          stepCount: 1,
          activity: "x",
        },
      },
    ]);
  });

  it("emits an upsert marked finished on finish", () => {
    const { reg } = testRegistry();
    const { id } = reg.create("done-run");
    const events: IndexEvent[] = [];
    reg.subscribeIndex((ev) => events.push(ev));
    events.length = 0;
    reg.finish(id);
    expect(events).toEqual([
      {
        type: "upsert",
        run: {
          id: "id-1",
          token: "tok-1",
          label: "done-run",
          finished: true,
          startedAt: 1000,
          finishedAt: 1000,
          eventCount: 0,
          stepCount: 0,
        },
      },
    ]);
  });

  it("emits a removed event when a finished run is evicted after its TTL (via a sweep entry point)", () => {
    const { reg, tick } = testRegistry({ ttlMs: 60_000 });
    const { id } = reg.create();
    reg.finish(id);
    reg.seal(id); // the TTL runs from the seal
    const events: IndexEvent[] = [];
    reg.subscribeIndex((ev) => events.push(ev));
    events.length = 0; // drop the replay upsert

    tick(61_000); // past the TTL
    reg.listActive(); // an entry point → triggers the lazy sweep

    expect(events).toEqual([{ type: "removed", id }]);
  });

  it("stops delivery after unsubscribe (and unsubscribe is idempotent)", () => {
    const { reg } = testRegistry();
    const events: IndexEvent[] = [];
    const unsub = reg.subscribeIndex((ev) => events.push(ev));
    unsub();
    expect(() => unsub()).not.toThrow(); // idempotent
    reg.create("x");
    expect(events).toEqual([]);
  });

  it("isolates a throwing subscriber: registry state is intact and lifecycle calls never throw", () => {
    const { reg } = testRegistry();
    reg.subscribeIndex(() => {
      throw new Error("boom");
    });
    const good: IndexEvent[] = [];
    reg.subscribeIndex((ev) => good.push(ev));

    expect(() => reg.create("x")).not.toThrow();
    // the well-behaved subscriber still received the upsert…
    expect(good).toContainEqual({
      type: "upsert",
      run: { id: "id-1", token: "tok-1", label: "x", finished: false, startedAt: 1000, eventCount: 0, stepCount: 0 },
    });
    // …and registry state is uncorrupted.
    expect(reg.listActive().map((r) => r.label)).toEqual(["x"]);
  });
});
