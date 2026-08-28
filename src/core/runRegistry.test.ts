import { describe, expect, it } from "vitest";
import { RunRegistry, type IndexEvent, type RunRegistryOptions } from "./runRegistry.js";
import type { RunEvent } from "./runEvents.js";

// Feature: features/live-view.md — the in-memory, live-only run registry that
// backs the external live-view page. It mints an unguessable id+token per run,
// buffers a bounded backlog so a viewer who opens the link mid-run sees what
// already happened, fans events out to live subscribers, and evicts finished
// runs after a TTL. Id/token/clock are injectable so every property is
// deterministic here.

const call = (summary: string): RunEvent => ({ type: "tool_call", tool: "bash", summary });
const result = (ok: boolean, summary: string): RunEvent => ({ type: "tool_result", tool: "bash", ok, summary });

/** A registry with deterministic ids/tokens/clock for tests. */
function testRegistry(over: Partial<RunRegistryOptions> = {}) {
  let n = 0;
  let clock = 1000;
  const reg = new RunRegistry({
    genId: () => `id-${++n}`,
    genToken: () => `tok-${n}`,
    now: () => clock,
    ...over,
  });
  return { reg, tick: (ms: number) => (clock += ms) };
}

describe("RunRegistry.create", () => {
  it("mints a distinct id and token per run", () => {
    const { reg } = testRegistry();
    const a = reg.create();
    const b = reg.create();
    expect(a).toEqual({ id: "id-1", token: "tok-1" });
    expect(b).toEqual({ id: "id-2", token: "tok-2" });
    expect(a.id).not.toBe(b.id);
    expect(a.token).not.toBe(b.token);
  });

  it("defaults to crypto-random ids/tokens that are unguessable and distinct", () => {
    const reg = new RunRegistry();
    const a = reg.create();
    const b = reg.create();
    expect(a.id).not.toBe(b.id);
    expect(a.token).not.toBe(b.token);
    // A capability token needs real entropy — the default is 32 random bytes hex.
    expect(a.token).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("RunRegistry.subscribe — token gate (constant-time capability)", () => {
  it("delivers published events to a live subscriber", () => {
    const { reg } = testRegistry();
    const { id, token } = reg.create();
    const seen: RunEvent[] = [];
    const unsub = reg.subscribe(id, token, (e) => seen.push(e));
    expect(unsub).not.toBeNull();
    reg.publish(id, call("$ echo hi"));
    reg.publish(id, result(true, "hi"));
    expect(seen).toEqual([call("$ echo hi"), result(true, "hi")]);
  });

  it("rejects a wrong token (returns null; nothing delivered)", () => {
    const { reg } = testRegistry();
    const { id } = reg.create();
    const seen: RunEvent[] = [];
    const unsub = reg.subscribe(id, "tok-WRONG", (e) => seen.push(e));
    expect(unsub).toBeNull();
    reg.publish(id, call("secret"));
    expect(seen).toEqual([]);
  });

  it("rejects a missing/empty token", () => {
    const { reg } = testRegistry();
    const { id } = reg.create();
    expect(reg.subscribe(id, "", () => {})).toBeNull();
  });

  it("rejects an unknown run id without revealing existence (null, like a bad token)", () => {
    const { reg } = testRegistry();
    reg.create();
    expect(reg.subscribe("id-does-not-exist", "tok-1", () => {})).toBeNull();
  });

  it("has() mirrors the same constant-time gate the page uses", () => {
    const { reg } = testRegistry();
    const { id, token } = reg.create();
    expect(reg.has(id, token)).toBe(true);
    expect(reg.has(id, "tok-WRONG")).toBe(false);
    expect(reg.has(id, "")).toBe(false);
    expect(reg.has("nope", token)).toBe(false);
  });
});

describe("RunRegistry — backlog replay for a late subscriber", () => {
  it("replays already-published events, in order, then live-forwards new ones", () => {
    const { reg } = testRegistry();
    const { id, token } = reg.create();
    reg.publish(id, call("first"));
    reg.publish(id, result(true, "first done"));

    const seen: RunEvent[] = [];
    reg.subscribe(id, token, (e) => seen.push(e)); // subscribes AFTER two events
    expect(seen).toEqual([call("first"), result(true, "first done")]); // replayed

    reg.publish(id, call("second"));
    expect(seen).toEqual([call("first"), result(true, "first done"), call("second")]); // + live
  });

  it("bounds the backlog: only the most recent N events are retained for replay", () => {
    const { reg } = testRegistry({ backlogLimit: 3 });
    const { id, token } = reg.create();
    for (let i = 1; i <= 5; i++) reg.publish(id, call(`e${i}`));
    const seen: RunEvent[] = [];
    reg.subscribe(id, token, (e) => seen.push(e));
    expect(seen).toEqual([call("e3"), call("e4"), call("e5")]); // oldest two evicted
  });
});

describe("RunRegistry.unsubscribe", () => {
  it("stops delivery after unsubscribe", () => {
    const { reg } = testRegistry();
    const { id, token } = reg.create();
    const seen: RunEvent[] = [];
    const unsub = reg.subscribe(id, token, (e) => seen.push(e))!;
    reg.publish(id, call("before"));
    unsub();
    reg.publish(id, call("after"));
    expect(seen).toEqual([call("before")]);
  });
});

describe("RunRegistry.finish", () => {
  it("notifies a live subscriber via onFinish and stops forwarding further events", () => {
    const { reg } = testRegistry();
    const { id, token } = reg.create();
    const seen: RunEvent[] = [];
    let finished = false;
    reg.subscribe(id, token, (e) => seen.push(e), () => (finished = true));
    reg.publish(id, call("during"));
    reg.finish(id);
    expect(finished).toBe(true);
    reg.publish(id, call("after-finish")); // no-op after finish
    expect(seen).toEqual([call("during")]);
  });

  it("a subscriber that arrives after finish (within TTL) replays the backlog then gets onFinish immediately", () => {
    const { reg } = testRegistry();
    const { id, token } = reg.create();
    reg.publish(id, call("happened"));
    reg.finish(id);
    const seen: RunEvent[] = [];
    let finished = false;
    const unsub = reg.subscribe(id, token, (e) => seen.push(e), () => (finished = true));
    expect(unsub).not.toBeNull();
    expect(seen).toEqual([call("happened")]);
    expect(finished).toBe(true);
  });

  it("publish to an unknown run is a silent no-op (never throws)", () => {
    const { reg } = testRegistry();
    expect(() => reg.publish("ghost", call("x"))).not.toThrow();
  });
});

describe("RunRegistry.listActive", () => {
  it("returns non-evicted runs newest-first with id, token, label, startedAt, and event count", () => {
    const { reg, tick } = testRegistry();
    const a = reg.create("coding · owner/repo");
    tick(10);
    const b = reg.create("review · thread-42");
    reg.publish(b.id, call("x"));
    reg.publish(b.id, result(true, "ok"));

    const list = reg.listActive();
    expect(list.map((r) => r.id)).toEqual(["id-2", "id-1"]); // newest run first
    expect(list[0]).toEqual({
      id: "id-2",
      token: "tok-2",
      label: "review · thread-42",
      finished: false,
      startedAt: 1010, // clock at create()
      eventCount: 2,
    });
    expect(list[1]).toEqual({
      id: "id-1",
      token: "tok-1",
      label: "coding · owner/repo",
      finished: false,
      startedAt: 1000,
      eventCount: 0,
    });
    expect(a.id).toBe("id-1");
  });

  it("omits label when the run was created without one", () => {
    const { reg } = testRegistry();
    reg.create();
    const [only] = reg.listActive();
    expect(only.label).toBeUndefined();
  });

  it("includes a recently-finished run (until TTL) marked finished, then excludes it once evicted", () => {
    const { reg, tick } = testRegistry({ ttlMs: 60_000 });
    const { id } = reg.create("done-soon");
    reg.publish(id, call("x"));
    reg.finish(id);

    tick(59_000); // still within TTL
    const still = reg.listActive();
    expect(still.map((r) => r.id)).toEqual([id]);
    expect(still[0].finished).toBe(true);
    expect(still[0].eventCount).toBe(1); // count survives finish

    tick(2_000); // past the TTL → evicted
    expect(reg.listActive()).toEqual([]);
  });

  it("returns an empty list when there are no runs", () => {
    const { reg } = testRegistry();
    expect(reg.listActive()).toEqual([]);
  });
});

describe("RunRegistry — finished-run eviction after TTL", () => {
  it("keeps a finished run subscribable until the TTL, then evicts it (subscribe → null)", () => {
    const { reg, tick } = testRegistry({ ttlMs: 60_000 });
    const { id, token } = reg.create();
    reg.publish(id, call("x"));
    reg.finish(id);

    tick(59_000); // still within TTL
    expect(reg.has(id, token)).toBe(true);
    expect(reg.subscribe(id, token, () => {})).not.toBeNull();

    tick(2_000); // now past the 60s TTL
    expect(reg.has(id, token)).toBe(false);
    expect(reg.subscribe(id, token, () => {})).toBeNull();
  });

  it("does NOT evict a still-running (unfinished) run no matter how old", () => {
    const { reg, tick } = testRegistry({ ttlMs: 1_000 });
    const { id, token } = reg.create();
    tick(1_000_000); // long-running agent
    expect(reg.has(id, token)).toBe(true);
    const seen: RunEvent[] = [];
    reg.subscribe(id, token, (e) => seen.push(e));
    reg.publish(id, call("still going"));
    expect(seen).toEqual([call("still going")]);
  });
});

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
        run: { id: "id-2", token: "tok-2", label: "review · thread-42", finished: false, startedAt: 1010, eventCount: 0 },
      },
      {
        type: "upsert",
        run: { id: "id-1", token: "tok-1", label: "coding · owner/repo", finished: false, startedAt: 1000, eventCount: 0 },
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
      { type: "upsert", run: { id: "id-1", token: "tok-1", label: "x", finished: false, startedAt: 1000, eventCount: 0 } },
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
      { type: "upsert", run: { id: "id-1", token: "tok-1", finished: false, startedAt: 1000, eventCount: 1 } },
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
      { type: "upsert", run: { id: "id-1", token: "tok-1", label: "done-run", finished: true, startedAt: 1000, eventCount: 0 } },
    ]);
  });

  it("emits a removed event when a finished run is evicted after its TTL (via a sweep entry point)", () => {
    const { reg, tick } = testRegistry({ ttlMs: 60_000 });
    const { id } = reg.create();
    reg.finish(id);
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
      run: { id: "id-1", token: "tok-1", label: "x", finished: false, startedAt: 1000, eventCount: 0 },
    });
    // …and registry state is uncorrupted.
    expect(reg.listActive().map((r) => r.label)).toEqual(["x"]);
  });
});

describe("snapshot — token-gated read of a run's backlog (#84)", () => {
  it("returns a copy of the backlog plus the finished flag; null for a bad token or unknown run", () => {
    const reg = new RunRegistry({ genId: () => "r1", genToken: () => "tok" });
    const { id, token } = reg.create();
    const ev = { type: "tool_call", tool: "bash", summary: "$ ls", at: 5 } as const;
    reg.publish(id, ev);
    const live = reg.snapshot(id, token);
    expect(live).toEqual({ events: [ev], finished: false });
    // A copy: mutating it does not touch the registry's backlog.
    live!.events.push({ type: "tool_call", tool: "bash", summary: "$ rm -rf", at: 6 });
    expect(reg.snapshot(id, token)!.events).toHaveLength(1);

    reg.finish(id);
    expect(reg.snapshot(id, token)).toEqual({ events: [ev], finished: true });
    expect(reg.snapshot(id, "wrong")).toBeNull();
    expect(reg.snapshot("nope", token)).toBeNull();
  });
});
