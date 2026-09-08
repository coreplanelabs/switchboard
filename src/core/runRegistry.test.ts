import { describe, expect, it } from "vitest";
import { RunControl, RunRegistry, type IndexEvent, type RunRegistryOptions } from "./runRegistry.js";
import type { RunEvent } from "./runEvents.js";

// Feature: features/live-view.md — the in-memory, live-only run registry that
// backs the external live-view page. It mints an unguessable id+token per run,
// buffers a bounded backlog so a viewer who opens the link mid-run sees what
// already happened, fans events out to live subscribers, and evicts finished
// runs after a TTL. Id/token/clock are injectable so every property is
// deterministic here.

const call = (summary: string): RunEvent => ({ type: "tool_call", tool: "bash", summary });
const result = (ok: boolean, summary: string): RunEvent => ({ type: "tool_result", tool: "bash", ok, summary });
/** What `publish` hands back: the input event stamped with its per-run `seq` (#157). */
const seq = (n: number, e: RunEvent): RunEvent => ({ ...e, seq: n });

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
    expect(a).toMatchObject({ id: "id-1", token: "tok-1" });
    expect(b).toMatchObject({ id: "id-2", token: "tok-2" });
    expect(a.id).not.toBe(b.id);
    expect(a.token).not.toBe(b.token);
    expect(a.control).not.toBe(b.control); // each run owns its own stop control (#101)
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

  // Feature: features/run-history.md item 37 — a resumed run keeps its identity
  // and its past: the ledger's run id, and the events published before the
  // restart under their original seqs, so the stream stays one contiguous record.
  it("a resume creates the run under a given id, with its original start and its earlier events replayed under their seqs; new events continue past the highest", () => {
    const { reg } = testRegistry();
    const run = reg.create("resumed", undefined, {
      id: "ledger-run-1",
      startedAt: 4_242, // the original start, from the ledger row
      replay: [
        { type: "tool_call", tool: "bash", summary: "ls", at: 2, seq: 2 },
        { type: "input", text: "go", at: 1, seq: 1 }, // out of order on purpose: replay sorts by seq
      ],
    });
    expect(run.id).toBe("ledger-run-1");
    reg.publish(run.id, { type: "tool_result", tool: "bash", ok: true, summary: "x", at: 3 });
    const snap = reg.snapshot(run.id, run.token)!;
    expect(snap.events.map((e) => [e.seq, e.type])).toEqual([
      [1, "input"],
      [2, "tool_call"],
      [3, "tool_result"],
    ]);
    expect(snap.eventCount).toBe(3);
    expect(snap.startedAt).toBe(4_242);
    // The next fresh run still mints its own id.
    expect(reg.create().id).toBe("id-1");
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
    expect(seen).toEqual([seq(1, call("$ echo hi")), seq(2, result(true, "hi"))]);
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
    expect(seen).toEqual([seq(1, call("first")), seq(2, result(true, "first done"))]); // replayed

    reg.publish(id, call("second"));
    expect(seen).toEqual([seq(1, call("first")), seq(2, result(true, "first done")), seq(3, call("second"))]); // + live
  });

  it("bounds the backlog: only the most recent N events are retained for replay", () => {
    const { reg } = testRegistry({ backlogLimit: 3 });
    const { id, token } = reg.create();
    for (let i = 1; i <= 5; i++) reg.publish(id, call(`e${i}`));
    const seen: RunEvent[] = [];
    reg.subscribe(id, token, (e) => seen.push(e));
    expect(seen).toEqual([seq(3, call("e3")), seq(4, call("e4")), seq(5, call("e5"))]); // oldest two evicted
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
    expect(seen).toEqual([seq(1, call("before"))]);
  });
});

describe("RunRegistry.finish", () => {
  it("notifies a live subscriber via onFinish and stops forwarding further events", () => {
    const { reg } = testRegistry();
    const { id, token } = reg.create();
    const seen: RunEvent[] = [];
    let finished = false;
    reg.subscribe(
      id,
      token,
      (e) => seen.push(e),
      () => (finished = true),
    );
    reg.publish(id, call("during"));
    reg.finish(id);
    expect(finished).toBe(true);
    reg.publish(id, call("after-finish")); // no-op after finish
    expect(seen).toEqual([seq(1, call("during"))]);
  });

  it("a subscriber that arrives after finish (within TTL) replays the backlog then gets onFinish immediately", () => {
    const { reg } = testRegistry();
    const { id, token } = reg.create();
    reg.publish(id, call("happened"));
    reg.finish(id);
    const seen: RunEvent[] = [];
    let finished = false;
    const unsub = reg.subscribe(
      id,
      token,
      (e) => seen.push(e),
      () => (finished = true),
    );
    expect(unsub).not.toBeNull();
    expect(seen).toEqual([seq(1, call("happened"))]);
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
      activity: "x", // the latest tool call (item 20)
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

  it("carries the RunMeta given at create() on every summary (absent fields omitted) and hands back the redacted label", () => {
    const { reg } = testRegistry();
    const handle = reg.create('coding · acme/x · "token ghp_abcdefghijklmnopqrstuvwxyz0123"', {
      agent: "coding",
      model: "anthropic/claude",
      channelId: "slack:C1",
      userId: "slack:U1",
      threadKey: "slack:C1:1",
      repo: "acme/x",
      sourceUrl: "https://acme.slack.com/archives/C1/p1",
      userName: "justin",
      receivedAt: 900,
    });
    expect(handle.label).toBe('coding · acme/x · "token «redacted-github-token»"');
    const [row] = reg.listActive();
    expect(row).toMatchObject({
      label: handle.label,
      agent: "coding",
      model: "anthropic/claude",
      channelId: "slack:C1",
      userId: "slack:U1",
      threadKey: "slack:C1:1",
      repo: "acme/x",
      receivedAt: 900,
      sourceUrl: "https://acme.slack.com/archives/C1/p1",
      userName: "justin",
    }); // sourceUrl + userName: live-view item 21, the index's thread link and its hover identity
    expect(reg.getById(handle.id)).toMatchObject({ agent: "coding", repo: "acme/x" });
    const bare = reg.create();
    const bareRow = reg.listActive().find((r) => r.id === bare.id)!;
    expect(bare.label).toBeUndefined();
    expect(Object.keys(bareRow).sort()).toEqual(["eventCount", "finished", "id", "startedAt", "token"]);
    const chat = reg.create("general · #ch", { channelId: "slack:C1", userId: "slack:U1", threadKey: "slack:C1:2" });
    expect(reg.getById(chat.id)).not.toHaveProperty("repo");
    expect(reg.getById(chat.id)).not.toHaveProperty("sourceUrl");
    expect(reg.getById(chat.id)).not.toHaveProperty("agent");
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
    expect(seen).toEqual([seq(1, call("still going"))]);
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
        run: {
          id: "id-2",
          token: "tok-2",
          label: "review · thread-42",
          finished: false,
          startedAt: 1010,
          eventCount: 0,
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
        run: { id: "id-1", token: "tok-1", label: "x", finished: false, startedAt: 1000, eventCount: 0 },
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
        run: { id: "id-1", token: "tok-1", finished: false, startedAt: 1000, eventCount: 1, activity: "x" },
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
        },
      },
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
    expect(live).toEqual({
      events: [seq(1, ev)],
      finished: false,
      startedAt: expect.any(Number),
      eventCount: 1,
      truncated: false,
    });
    expect("finishedAt" in live!).toBe(false);
    // A copy: mutating it does not touch the registry's backlog.
    live!.events.push({ type: "tool_call", tool: "bash", summary: "$ rm -rf", at: 6 });
    expect(reg.snapshot(id, token)!.events).toHaveLength(1);

    reg.finish(id);
    expect(reg.snapshot(id, token)).toEqual({
      events: [seq(1, ev)],
      finished: true,
      startedAt: expect.any(Number),
      finishedAt: expect.any(Number),
      eventCount: 1,
      truncated: false,
    });
    expect(reg.snapshot(id, "wrong")).toBeNull();
    expect(reg.snapshot("nope", token)).toBeNull();
  });
});

// Feature: features/run-history.md — `markPersisted` (#157 KTD9): the history
// writer confirms a run is in the durable store; the index learns it through
// an upsert whose summary carries `persisted: true`.
describe("RunRegistry.markPersisted", () => {
  it("sets persisted on the summary and emits one index upsert", () => {
    const { reg } = testRegistry();
    const { id } = reg.create("x");
    reg.finish(id);
    const events: IndexEvent[] = [];
    reg.subscribeIndex((ev) => events.push(ev));
    events.length = 0; // drop the replay upsert
    reg.markPersisted(id);
    expect(events).toEqual([
      {
        type: "upsert",
        run: {
          id: "id-1",
          token: "tok-1",
          label: "x",
          finished: true,
          startedAt: 1000,
          finishedAt: 1000,
          eventCount: 0,
          persisted: true,
        },
      },
    ]);
    expect(reg.listActive()[0].persisted).toBe(true);
  });

  it("is a no-op for an unknown or evicted run (no upsert, no throw)", () => {
    const { reg, tick } = testRegistry({ ttlMs: 10 });
    const { id } = reg.create();
    reg.finish(id);
    tick(20);
    reg.listActive(); // sweep → evicted
    const events: IndexEvent[] = [];
    reg.subscribeIndex((ev) => events.push(ev));
    expect(() => reg.markPersisted(id)).not.toThrow();
    expect(() => reg.markPersisted("never-existed")).not.toThrow();
    expect(events).toEqual([]);
  });

  it("an unpersisted run's summary has no persisted key at all", () => {
    const { reg } = testRegistry();
    reg.create();
    expect("persisted" in reg.listActive()[0]).toBe(false);
  });
});

describe("RunRegistry.snapshot — record inputs (#157 U4)", () => {
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

  it("carries receivedAt from the RunMeta onto the summary and the snapshot, and omits it when absent (features/tracing.md)", () => {
    const { reg } = testRegistry();
    const stamped = reg.create("x", {
      channelId: "slack:C1",
      userId: "slack:U1",
      threadKey: "slack:C1:1",
      receivedAt: 900,
    });
    const plain = reg.create("y", { channelId: "slack:C1", userId: "slack:U1", threadKey: "slack:C1:2" });
    expect(reg.snapshot(stamped.id, stamped.token)?.receivedAt).toBe(900);
    expect(reg.listActive().find((r) => r.id === stamped.id)?.receivedAt).toBe(900);
    expect("receivedAt" in (reg.snapshot(plain.id, plain.token) ?? {})).toBe(false);
    expect("receivedAt" in (reg.listActive().find((r) => r.id === plain.id) ?? {})).toBe(false);
  });
});

// Feature: features/live-view.md item 10 — run control (#101). Every run owns a
// RunControl (soft/hard stop request + a hard AbortSignal); `requestStop` is the
// token-gated control-plane entry the /runs surface calls.
describe("RunControl", () => {
  it("starts unrequested with a live hard signal", () => {
    const c = new RunControl();
    expect(c.requested).toBeUndefined();
    expect(c.hardSignal.aborted).toBe(false);
  });

  it("soft: records the mode, does NOT abort the hard signal", () => {
    const c = new RunControl();
    expect(c.requestStop("soft")).toBe("soft");
    expect(c.requested).toBe("soft");
    expect(c.hardSignal.aborted).toBe(false);
  });

  it("hard: records the mode AND aborts the hard signal", () => {
    const c = new RunControl();
    expect(c.requestStop("hard")).toBe("hard");
    expect(c.requested).toBe("hard");
    expect(c.hardSignal.aborted).toBe(true);
  });

  it("escalates soft → hard, never de-escalates hard → soft; repeats are idempotent", () => {
    const c = new RunControl();
    c.requestStop("soft");
    expect(c.requestStop("hard")).toBe("hard");
    expect(c.requested).toBe("hard");
    expect(c.requestStop("soft")).toBe("hard"); // stays hard
    expect(c.requested).toBe("hard");
    expect(c.requestStop("hard")).toBe("hard");
  });
});

describe("RunRegistry.requestStop — run control (#101)", () => {
  it("create() hands out the run's control; a valid stop drives it and reports the effective mode", () => {
    const { reg } = testRegistry();
    const { id, token, control } = reg.create();
    expect(reg.requestStop(id, token, "soft")).toEqual({ ok: true, mode: "soft" });
    expect(control.requested).toBe("soft");
    expect(reg.requestStop(id, token, "hard")).toEqual({ ok: true, mode: "hard" });
    expect(control.hardSignal.aborted).toBe(true);
  });

  it("is token-gated like every read: wrong token / unknown run → not-found, control untouched", () => {
    const { reg } = testRegistry();
    const { id, control } = reg.create();
    expect(reg.requestStop(id, "wrong", "hard")).toEqual({ ok: false, reason: "not-found" });
    expect(reg.requestStop("nope", "tok-1", "hard")).toEqual({ ok: false, reason: "not-found" });
    expect(control.requested).toBeUndefined();
  });

  it("refuses a stop on a finished run", () => {
    const { reg } = testRegistry();
    const { id, token, control } = reg.create();
    reg.finish(id);
    expect(reg.requestStop(id, token, "soft")).toEqual({ ok: false, reason: "finished" });
    expect(control.requested).toBeUndefined();
  });

  it("publishes a typed `stop_requested` run_note to the run's stream (viewers see the request)", () => {
    const { reg } = testRegistry();
    const { id, token } = reg.create();
    const got: RunEvent[] = [];
    reg.subscribe(id, token, (e) => got.push(e));
    reg.requestStop(id, token, "soft");
    expect(got).toEqual([expect.objectContaining({ type: "run_note", kind: "stop_requested", mode: "soft" })]);
  });

  it("reflects the state on the index: stopping while live, stopped once finished", () => {
    const { reg } = testRegistry();
    const { id, token } = reg.create();
    const seen: IndexEvent[] = [];
    reg.subscribeIndex((ev) => seen.push(ev));
    expect(reg.listActive()[0].stop).toBeUndefined();
    reg.requestStop(id, token, "hard");
    expect(reg.listActive()[0].stop).toEqual({ mode: "hard", state: "stopping" });
    // The request itself is an index upsert so open index pages repaint the row.
    expect(seen.at(-1)).toEqual({
      type: "upsert",
      run: expect.objectContaining({ stop: { mode: "hard", state: "stopping" } }),
    });
    reg.finish(id);
    expect(reg.listActive()[0].stop).toEqual({ mode: "hard", state: "stopped" });
  });

  it("a run that was never asked to stop has no `stop` field (additive, inert)", () => {
    const { reg } = testRegistry();
    const { id } = reg.create();
    reg.finish(id);
    expect("stop" in reg.listActive()[0]).toBe(false);
  });
});

// Feature: features/run-visibility.md — the exchange in the stream (#157 U1): every
// published event is stamped with a monotonic per-run `seq`, an event published
// after finish() is dropped (the dispatcher must publish the answer BEFORE finishing),
// and the label is redacted at create() so a secret in the request snippet never
// reaches the index.
describe("RunRegistry — text events, seq, label redaction (#157 U1)", () => {
  const text = (type: "input" | "context" | "answer", text: string): RunEvent => ({ type, text });

  it("stamps every published event with a monotonic per-run seq (1, 2, 3…)", () => {
    const { reg } = testRegistry();
    const a = reg.create();
    const b = reg.create();
    reg.publish(a.id, text("input", "hi"));
    reg.publish(a.id, call("$ ls"));
    reg.publish(b.id, text("input", "other run"));
    reg.publish(a.id, result(true, "ok"));
    expect(reg.snapshot(a.id, a.token)?.events.map((e) => e.seq)).toEqual([1, 2, 3]);
    expect(reg.snapshot(b.id, b.token)?.events.map((e) => e.seq)).toEqual([1]); // per run, not global
  });

  it("an event published after finish() is a silent no-op — not in the snapshot, not delivered", () => {
    const { reg } = testRegistry();
    const { id, token } = reg.create();
    const seen: RunEvent[] = [];
    reg.subscribe(id, token, (e) => seen.push(e));
    reg.publish(id, text("input", "request"));
    reg.finish(id);
    reg.publish(id, text("answer", "too late"));
    const snap = reg.snapshot(id, token);
    expect(snap?.events.map((e) => e.type)).toEqual(["input"]);
    expect(seen).toHaveLength(1);
  });

  it("redacts a secret in the label at create(), so listActive() and the index feed never see it", () => {
    const { reg } = testRegistry();
    const seen: IndexEvent[] = [];
    reg.subscribeIndex((e) => seen.push(e));
    reg.create('coding · owner/repo · "use ghp_abcdefghijklmnopqrstuvwxyz0123 to push"');
    const label = reg.listActive()[0]?.label ?? "";
    expect(label).not.toContain("ghp_abcdefghijklmnopqrstuvwxyz0123");
    expect(label).toContain("«redacted-github-token»");
    expect(JSON.stringify(seen)).not.toContain("ghp_abcdefghijklmnopqrstuvwxyz0123");
  });
});

// Feature: features/live-view.md — one backlog bounded by count AND bytes (#157
// U11): the registry backlog is the only per-run event store (the dispatcher's
// separate ring is gone), so its bounds are what the friction diagnosis and the
// live replay see. A throwing per-run subscriber is isolated like index sinks.
describe("RunRegistry — backlog bounds and subscriber isolation (#157 U11)", () => {
  it("defaults to a 5000-event backlog: the 5001st event drops the oldest one; eventCount keeps counting", () => {
    const { reg } = testRegistry();
    const { id, token } = reg.create();
    for (let i = 1; i <= 5001; i++) reg.publish(id, call(`$ step ${i}`));
    const snap = reg.snapshot(id, token);
    expect(snap?.events).toHaveLength(5000);
    expect(snap?.events[0]).toMatchObject({ type: "tool_call", summary: "$ step 2", seq: 2 });
    expect(snap?.events[4999]).toMatchObject({ summary: "$ step 5001", seq: 5001 });
    expect(reg.listActive()[0]?.eventCount).toBe(5001);
  });

  const bytesOf = (e: RunEvent) => Buffer.byteLength(JSON.stringify(e), "utf8");
  const filler = (n: number): RunEvent => ({ type: "context", text: "x".repeat(n) });

  it("bounds the backlog by bytes (default 4 MiB, measured as each event's JSON): 4 × 1 MiB context events exceed it, so the oldest is dropped", () => {
    const { reg } = testRegistry();
    const { id, token } = reg.create();
    for (let i = 0; i < 4; i++) reg.publish(id, filler(1024 * 1024));
    const events = reg.snapshot(id, token)!.events;
    expect(events.reduce((n, e) => n + bytesOf(e), 0)).toBeLessThanOrEqual(4 * 1024 * 1024);
    expect(events.map((e) => e.seq)).toEqual([2, 3, 4]); // seq 1 dropped; the newest always survives
    expect(reg.listActive()[0]?.eventCount).toBe(4);
  });

  it("budget + 1 byte drops the oldest until under budget (explicit backlogBytes; exact boundary)", () => {
    // Budget = exactly three stamped events: all three fit; the fourth (one byte
    // over) evicts the first; a fifth, larger one evicts two more.
    const stampedSize = bytesOf({ ...filler(100), seq: 1 });
    const { reg } = testRegistry({ backlogBytes: 3 * stampedSize });
    const { id, token } = reg.create();
    for (let i = 0; i < 3; i++) reg.publish(id, filler(100));
    expect(reg.snapshot(id, token)!.events.map((e) => e.seq)).toEqual([1, 2, 3]);
    reg.publish(id, filler(101)); // +1 byte over budget: dropping seq 1 alone still leaves 3S+1 → seq 2 goes too
    expect(reg.snapshot(id, token)!.events.map((e) => e.seq)).toEqual([3, 4]);
    reg.publish(id, filler(100 + stampedSize)); // a 2S event → only it fits beside nothing older
    expect(reg.snapshot(id, token)!.events.map((e) => e.seq)).toEqual([5]);
    const used = reg.snapshot(id, token)!.events.reduce((n, e) => n + bytesOf(e), 0);
    expect(used).toBeLessThanOrEqual(3 * stampedSize);
  });

  it("a throwing per-run subscriber does not break publish for other subscribers or the publisher", () => {
    const { reg } = testRegistry();
    const { id, token } = reg.create();
    const seen: RunEvent[] = [];
    reg.subscribe(id, token, () => {
      throw new Error("dead sink");
    });
    reg.subscribe(id, token, (e) => seen.push(e));
    expect(() => reg.publish(id, call("$ ls"))).not.toThrow();
    expect(seen).toHaveLength(1);
    expect(reg.snapshot(id, token)?.events).toHaveLength(1); // still recorded
  });
});

describe("RunRegistry — token-free operator reads (#157 U5, KTD7)", () => {
  it("getById/snapshotById mirror the token-gated reads and are null for unknown or evicted runs", () => {
    const { reg, tick } = testRegistry({ ttlMs: 60_000 });
    const { id, token } = reg.create("lbl");
    reg.publish(id, call("$ ls"));
    expect(reg.getById(id)).toEqual(reg.listActive()[0]);
    expect(reg.snapshotById(id)).toEqual(reg.snapshot(id, token));
    expect(reg.getById("nope")).toBeNull();
    expect(reg.snapshotById("nope")).toBeNull();
    reg.finish(id);
    tick(60_001);
    expect(reg.getById(id)).toBeNull();
    expect(reg.snapshotById(id)).toBeNull();
  });

  it("requestStopById drives the control, publishes stop_requested with a sanitized actor, and refuses finished/unknown runs", () => {
    const { reg } = testRegistry();
    const { id, token, control } = reg.create();
    const seen: RunEvent[] = [];
    reg.subscribe(id, token, (e) => seen.push(e));
    expect(reg.requestStopById(id, "soft", { kind: "mcp", id: "mcp:agent one!" })).toEqual({ ok: true, mode: "soft" });
    expect(control.requested).toBe("soft");
    expect(seen.at(-1)).toMatchObject({
      type: "run_note",
      kind: "stop_requested",
      mode: "soft",
      actor: { kind: "mcp", id: "mcp:agentone" },
    });
    // The token-gated path publishes no actor: the capability, not a person, asked.
    reg.requestStop(id, token, "hard");
    expect(seen.at(-1)).toMatchObject({ kind: "stop_requested", mode: "hard" });
    expect(seen.at(-1)).not.toHaveProperty("actor");
    reg.finish(id);
    expect(reg.requestStopById(id, "soft", { kind: "cli", id: "cli:local" })).toEqual({
      ok: false,
      reason: "finished",
    });
    expect(reg.requestStopById("nope", "soft", { kind: "cli", id: "cli:local" })).toEqual({
      ok: false,
      reason: "not-found",
    });
  });

  it("an actor id with nothing allowed in it becomes `unknown`", () => {
    const { reg } = testRegistry();
    const { id, token } = reg.create();
    const seen: RunEvent[] = [];
    reg.subscribe(id, token, (e) => seen.push(e));
    reg.requestStopById(id, "soft", { kind: "chat", id: "   " });
    expect(seen.at(-1)).toMatchObject({ actor: { kind: "chat", id: "unknown" } });
  });
});

describe("RunRegistry — `activity` on the summary (live-view item 20)", () => {
  it("is the latest narration line / tool-call summary / the answer's first line, one line, capped; absent before the first such event", () => {
    const reg = new RunRegistry({ genId: () => "a1", genToken: () => "t" });
    const { id } = reg.create("x");
    expect("activity" in reg.listActive()[0]).toBe(false);
    reg.publish(id, { type: "input", text: "hello" }); // not an activity
    expect("activity" in reg.listActive()[0]).toBe(false);
    reg.publish(id, { type: "assistant", text: "Checking the\n  remaining   touchpoints." });
    expect(reg.listActive()[0].activity).toBe("Checking the remaining touchpoints.");
    reg.publish(id, { type: "tool_call", tool: "bash", summary: "$ npm test" });
    expect(reg.listActive()[0].activity).toBe("$ npm test");
    reg.publish(id, { type: "tool_result", tool: "bash", ok: true, summary: "exit 0" }); // results do not change it
    expect(reg.listActive()[0].activity).toBe("$ npm test");
    reg.publish(id, { type: "assistant", text: "x".repeat(300) });
    expect(reg.listActive()[0].activity).toHaveLength(120);
    expect(reg.listActive()[0].activity!.endsWith("…")).toBe(true);
    reg.publish(id, { type: "answer", text: "⚠️ resident not onboarded: acme/web\nsecond line" });
    expect(reg.listActive()[0].activity).toBe("⚠️ resident not onboarded: acme/web second line"); // a failed inline run's reply IS the failure
  });
});

describe("RunRegistry — terminal status + finishedAt on the summary; truncated on the snapshot (review)", () => {
  it("finish(id, status) stores the status: the summary and the index upsert carry `status` and `finishedAt`; a live run has neither", () => {
    const { reg, tick } = testRegistry();
    const run = reg.create("l", { channelId: "slack:C1", userId: "slack:U1", threadKey: "slack:C1:1" });
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
