import { describe, expect, it } from "vitest";
import { RunRegistry, UNSEALED_HOLD_MS } from "./runRegistry.js";
import type { RunEvent } from "./runEvents.js";
import type { IndexEvent } from "./runRegistry/indexFeed.js";
import type { FinishedFrame, SealedFrame } from "./runRegistry/state.js";
import { call, result, seq, spanEnd, testRegistry } from "./runRegistry/testing.js";

// Feature: docs/reference/specs/live-view.md — the in-memory, live-only run registry that
// backs the external live-view page. It mints an unguessable id+token per run,
// buffers a bounded backlog so a viewer who opens the link mid-run sees what
// already happened, fans events out to live subscribers, and evicts finished
// runs after a TTL. Id/token/clock are injectable so every property is
// deterministic here.

describe("RunRegistry.create", () => {
  it("mints a distinct id and token per run", () => {
    const { reg } = testRegistry();
    const a = reg.create();
    const b = reg.create();
    expect(a).toMatchObject({ id: "id-1", token: "tok-1" });
    expect(b).toMatchObject({ id: "id-2", token: "tok-2" });
    expect(a.id).not.toBe(b.id);
    expect(a.token).not.toBe(b.token);
    expect(a.control).not.toBe(b.control); // each run owns its own stop control
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

  // Feature: docs/reference/specs/run-history.md item 37 — a resumed run keeps its identity
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
    const unsub = reg.subscribe(id, token, { onEvent: (e) => seen.push(e) });
    expect(unsub).not.toBeNull();
    reg.publish(id, call("$ echo hi"));
    reg.publish(id, result(true, "hi"));
    expect(seen).toEqual([seq(1, call("$ echo hi")), seq(2, result(true, "hi"))]);
  });

  it("rejects a wrong token (returns null; nothing delivered)", () => {
    const { reg } = testRegistry();
    const { id } = reg.create();
    const seen: RunEvent[] = [];
    const unsub = reg.subscribe(id, "tok-WRONG", { onEvent: (e) => seen.push(e) });
    expect(unsub).toBeNull();
    reg.publish(id, call("secret"));
    expect(seen).toEqual([]);
  });

  it("rejects a missing/empty token", () => {
    const { reg } = testRegistry();
    const { id } = reg.create();
    expect(reg.subscribe(id, "", { onEvent: () => {} })).toBeNull();
  });

  it("rejects an unknown run id without revealing existence (null, like a bad token)", () => {
    const { reg } = testRegistry();
    reg.create();
    expect(reg.subscribe("id-does-not-exist", "tok-1", { onEvent: () => {} })).toBeNull();
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

describe("RunRegistry.unsubscribe", () => {
  it("stops delivery after unsubscribe", () => {
    const { reg } = testRegistry();
    const { id, token } = reg.create();
    const seen: RunEvent[] = [];
    const { unsubscribe } = reg.subscribe(id, token, { onEvent: (e) => seen.push(e) })!;
    reg.publish(id, call("before"));
    unsubscribe();
    reg.publish(id, call("after"));
    expect(seen).toEqual([seq(1, call("before"))]);
  });
});

describe("RunRegistry.finish", () => {
  it("notifies a live subscriber via onSealed (the end frame) once the finished run is sealed, and stops forwarding content events at finish", () => {
    const { reg } = testRegistry();
    const { id, token } = reg.create();
    const seen: RunEvent[] = [];
    let finished = false;
    reg.subscribe(id, token, { onEvent: (e) => seen.push(e), onSealed: () => (finished = true) });
    reg.publish(id, call("during"));
    reg.finish(id);
    expect(finished).toBe(false);
    reg.seal(id);
    expect(finished).toBe(true);
    reg.publish(id, call("after-finish")); // no-op after finish
    expect(seen).toEqual([seq(1, call("during"))]);
  });

  it("a subscriber that arrives after the seal (within TTL) replays the backlog then gets onSealed immediately", () => {
    const { reg } = testRegistry();
    const { id, token } = reg.create();
    reg.publish(id, call("happened"));
    reg.finish(id);
    reg.seal(id);
    const seen: RunEvent[] = [];
    let finished = false;
    const unsub = reg.subscribe(id, token, { onEvent: (e) => seen.push(e), onSealed: () => (finished = true) });
    expect(unsub).not.toBeNull();
    expect(seen).toEqual([seq(1, call("happened"))]);
    expect(finished).toBe(true);
  });

  it("publish to an unknown run is a silent no-op (never throws)", () => {
    const { reg } = testRegistry();
    expect(() => reg.publish("ghost", call("x"))).not.toThrow();
  });
});

// Feature: docs/reference/specs/run-history.md item 42 — a run created at its
// reservation whose dispatch ended before the run loop is discarded, not finished.
describe("RunRegistry.discard", () => {
  it("drops a live run without a finished frame: the index feed sees the removal, a live subscriber gets the end frame with no replyOk, and the run is unknown afterwards (a wrong-token lookup and a discard tell the same story)", () => {
    const { reg } = testRegistry();
    const { id, token } = reg.create("coding · acme/api");
    const index: IndexEvent[] = [];
    reg.subscribeIndex((ev) => index.push(ev));
    const seen: RunEvent[] = [];
    let finished = false;
    let sealed: SealedFrame | undefined;
    reg.subscribe(id, token, {
      onEvent: (e) => seen.push(e),
      onFinished: () => (finished = true),
      onSealed: (f) => (sealed = f),
    });
    reg.publish(id, call("attaching"));

    reg.discard(id);

    expect(index.at(-1)).toEqual({ type: "removed", id });
    expect(finished).toBe(false);
    expect(sealed).toEqual({ sealedAt: 1000 });
    expect(reg.getById(id)).toBeNull();
    expect(reg.listActive()).toEqual([]);
    expect(reg.subscribe(id, token, { onEvent: () => {} })).toBeNull();
    reg.publish(id, call("after")); // a discarded run takes nothing
    expect(seen).toEqual([seq(1, call("attaching"))]);
  });

  it("is a no-op for an unknown run and for a finished one — a finished run has a record, so the sweep evicts it in its own time", () => {
    const { reg } = testRegistry();
    const { id } = reg.create("review · acme/api#1");
    reg.finish(id, "completed");
    const index: IndexEvent[] = [];
    reg.subscribeIndex((ev) => index.push(ev));
    expect(() => reg.discard("ghost")).not.toThrow();
    reg.discard(id);
    expect(index.filter((ev) => ev.type === "removed")).toEqual([]);
    expect(reg.getById(id)?.finished).toBe(true);
  });
});

// Feature: docs/reference/specs/live-view.md item 4, docs/reference/specs/tracing.md — finish and seal.
describe("RunRegistry — finish and seal", () => {
  it("finish sends `finished` to attached subscribers and leaves them attached; the seal, later, sends `end` from its own clock read — two index upserts per run, one each", () => {
    let t = 1000;
    const reg = new RunRegistry({ genId: () => "id-1", genToken: () => "tok-1", now: () => t++ }); // every read ticks
    const { id, token } = reg.create();
    const index: IndexEvent[] = [];
    reg.subscribeIndex((e) => index.push(e));
    const order: string[] = [];
    reg.subscribe(id, token, {
      onEvent: () => {},
      onFinished: (f) => order.push(`finished@${f.finishedAt}`),
      onSealed: (f) => order.push(`end@${f.sealedAt}:${String(f.replyOk)}`),
    });
    const before = index.length;
    reg.finish(id, "completed");
    expect(index.length - before).toBe(1); // one index event per finish
    const row = reg.getById(id)!;
    expect(row.finishedAt).toBeDefined();
    expect(row.sealedAt).toBeUndefined();
    expect(order).toEqual([`finished@${row.finishedAt}`]);
    reg.seal(id, { replyOk: true });
    expect(index.length - before).toBe(2); // and one per seal
    const sealed = reg.getById(id)!;
    expect(sealed.sealedAt).toBeGreaterThan(sealed.finishedAt!);
    expect(order).toEqual([`finished@${row.finishedAt}`, `end@${sealed.sealedAt}:true`]);
  });

  it("finish keeps subscribers attached; span records publish after finish (forwarded, counted, no index repaint); content after finish is dropped; seal detaches with the `end` frame, upserts once and returns the events since finish", () => {
    const { reg } = testRegistry();
    const { id, token } = reg.create();
    reg.publish(id, call("x"));
    const seen: RunEvent[] = [];
    const finished: FinishedFrame[] = [];
    const sealed: SealedFrame[] = [];
    reg.subscribe(id, token, {
      onEvent: (e) => seen.push(e),
      onFinished: (f) => finished.push(f),
      onSealed: (f) => sealed.push(f),
    });
    const index: IndexEvent[] = [];
    reg.subscribeIndex((e) => index.push(e));
    reg.finish(id, "completed");
    expect(finished).toEqual([{ finishedAt: 1000 }]);
    expect(sealed).toEqual([]);
    expect(reg.getById(id)).toMatchObject({ finished: true, finishedAt: 1000 });
    expect(reg.getById(id)?.sealedAt).toBeUndefined();
    const repaints = index.length;
    reg.publish(id, spanEnd("run.agent"));
    expect(seen.at(-1)).toEqual(seq(2, spanEnd("run.agent")));
    expect(reg.getById(id)?.eventCount).toBe(2);
    expect(index.length).toBe(repaints); // a span record never repaints the index
    reg.publish(id, call("late content"));
    expect(reg.getById(id)?.eventCount).toBe(2); // content stops at finish
    const res = reg.seal(id, { replyOk: true });
    expect(res).toEqual({ events: [seq(2, spanEnd("run.agent"))], eventCount: 2, sealedAt: 1000, replyOk: true });
    expect(sealed).toEqual([{ sealedAt: 1000, replyOk: true }]);
    expect(index.length).toBe(repaints + 1); // the seal upserts once
    expect(reg.getById(id)).toMatchObject({ sealedAt: 1000, replyOk: true });
    reg.publish(id, spanEnd("post.reply"));
    expect(reg.getById(id)?.eventCount).toBe(2); // everything stops at the seal
    expect(reg.seal(id, { replyOk: false })).toEqual(res); // re-readable; the first seal's replyOk stands
    expect(index.length).toBe(repaints + 1);
  });

  it("a late subscriber to a finished-unsealed run gets the replay and `finished` and stays attached until the seal's `end`; to a sealed run it gets `finished` then `end` at once and never attaches", () => {
    const { reg } = testRegistry();
    const { id, token } = reg.create();
    reg.publish(id, call("x"));
    reg.finish(id);
    const a = { events: [] as RunEvent[], finished: 0, sealed: [] as SealedFrame[] };
    reg.subscribe(id, token, {
      onEvent: (e) => a.events.push(e),
      onFinished: () => a.finished++,
      onSealed: (f) => a.sealed.push(f),
    });
    expect(a.events).toEqual([seq(1, call("x"))]);
    expect(a.finished).toBe(1);
    expect(a.sealed).toEqual([]);
    reg.publish(id, spanEnd("run.agent"));
    expect(a.events).toHaveLength(2); // still attached
    reg.seal(id);
    expect(a.sealed).toEqual([{ sealedAt: 1000 }]);
    const b = { finished: 0, sealed: [] as SealedFrame[] };
    const got = reg.subscribe(id, token, {
      onEvent: () => {},
      onFinished: () => b.finished++,
      onSealed: (f) => b.sealed.push(f),
    })!;
    expect(b.finished).toBe(1);
    expect(b.sealed).toEqual([{ sealedAt: 1000 }]);
    expect(got.replayed).toBe(2);
    expect(() => got.unsubscribe()).not.toThrow();
  });

  it("seal on a live run is a no-op with no stamps; on an unknown run, the empty result", () => {
    const { reg } = testRegistry();
    const { id, token } = reg.create();
    expect(reg.seal(id, { replyOk: true })).toEqual({ events: [], eventCount: 0 });
    const seen: RunEvent[] = [];
    reg.subscribe(id, token, { onEvent: (e) => seen.push(e) });
    reg.publish(id, call("still live"));
    expect(seen).toHaveLength(1);
    expect(reg.getById(id)?.sealedAt).toBeUndefined();
    expect(reg.seal("ghost")).toEqual({ events: [] });
  });

  it("the sweep evicts a sealed run at sealedAt + TTL, and holds a finished-unsealed run for UNSEALED_HOLD_MS before sealing it (its subscriber gets `end`, no replyOk) and evicting it", () => {
    const { reg, tick } = testRegistry({ ttlMs: 60_000 });
    const removed: string[] = [];
    reg.subscribeIndex((e) => {
      if (e.type === "removed") removed.push(e.id);
    });
    const a = reg.create("sealed");
    reg.finish(a.id);
    reg.seal(a.id, { replyOk: true });
    const b = reg.create("unsealed");
    reg.finish(b.id);
    const bSealed: SealedFrame[] = [];
    reg.subscribe(b.id, b.token, { onEvent: () => {}, onSealed: (f) => bSealed.push(f) });
    tick(61_000);
    expect(reg.has(a.id, a.token)).toBe(false); // sealedAt + 60 s
    expect(reg.has(b.id, b.token)).toBe(true); // the hold
    expect(removed).toEqual([a.id]);
    tick(UNSEALED_HOLD_MS);
    expect(reg.has(b.id, b.token)).toBe(false);
    expect(bSealed).toEqual([{ sealedAt: 1000 + 61_000 + UNSEALED_HOLD_MS }]);
    expect(removed).toEqual([a.id, b.id]);
  });

  it("sealAllFinished seals every finished-unsealed run with the given replyOk, leaves live and sealed runs alone, and returns the count", () => {
    const { reg } = testRegistry();
    const live = reg.create("live");
    const done = reg.create("done");
    const sealed = reg.create("sealed");
    reg.finish(done.id);
    reg.finish(sealed.id);
    reg.seal(sealed.id, { replyOk: true });
    expect(reg.sealAllFinished()).toBe(1);
    expect(reg.getById(done.id)).toMatchObject({ sealedAt: 1000 });
    expect(reg.getById(done.id)?.replyOk).toBeUndefined();
    expect(reg.getById(live.id)?.sealedAt).toBeUndefined();
    expect(reg.getById(sealed.id)).toMatchObject({ sealedAt: 1000, replyOk: true });
    expect(reg.sealAllFinished()).toBe(0);
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
      stepCount: 2,
      activity: "x", // the latest tool call (item 20)
    });
    expect(list[1]).toEqual({
      id: "id-1",
      token: "tok-1",
      label: "coding · owner/repo",
      finished: false,
      startedAt: 1000,
      eventCount: 0,
      stepCount: 0,
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
      userId: "slack:UALICE",
      threadKey: "slack:C1:1",
      repo: "acme/x",
      sourceUrl: "https://acme.slack.com/archives/C1/p1",
      userName: "alice",
      receivedAt: 900,
    });
    expect(handle.label).toBe('coding · acme/x · "token «redacted-github-token»"');
    const [row] = reg.listActive();
    expect(row).toMatchObject({
      label: handle.label,
      agent: "coding",
      model: "anthropic/claude",
      channelId: "slack:C1",
      userId: "slack:UALICE",
      threadKey: "slack:C1:1",
      repo: "acme/x",
      receivedAt: 900,
      sourceUrl: "https://acme.slack.com/archives/C1/p1",
      userName: "alice",
    }); // sourceUrl + userName: live-view item 21, the index's thread link and its hover identity
    expect(reg.getById(handle.id)).toMatchObject({ agent: "coding", repo: "acme/x" });
    const bare = reg.create();
    const bareRow = reg.listActive().find((r) => r.id === bare.id)!;
    expect(bare.label).toBeUndefined();
    expect(Object.keys(bareRow).sort()).toEqual(["eventCount", "finished", "id", "startedAt", "stepCount", "token"]);
    const chat = reg.create("general · #ch", {
      channelId: "slack:C1",
      userId: "slack:UALICE",
      threadKey: "slack:C1:2",
    });
    expect(reg.getById(chat.id)).not.toHaveProperty("repo");
    expect(reg.getById(chat.id)).not.toHaveProperty("sourceUrl");
    expect(reg.getById(chat.id)).not.toHaveProperty("agent");
  });

  it("includes a recently-finished run (until TTL) marked finished, then excludes it once evicted", () => {
    const { reg, tick } = testRegistry({ ttlMs: 60_000 });
    const { id } = reg.create("done-soon");
    reg.publish(id, call("x"));
    reg.finish(id);
    reg.seal(id); // the TTL runs from the seal

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
    reg.seal(id); // the TTL runs from the seal

    tick(59_000); // still within TTL
    expect(reg.has(id, token)).toBe(true);
    expect(reg.subscribe(id, token, { onEvent: () => {} })).not.toBeNull();

    tick(2_000); // now past the 60s TTL
    expect(reg.has(id, token)).toBe(false);
    expect(reg.subscribe(id, token, { onEvent: () => {} })).toBeNull();
  });

  it("does NOT evict a still-running (unfinished) run no matter how old", () => {
    const { reg, tick } = testRegistry({ ttlMs: 1_000 });
    const { id, token } = reg.create();
    tick(1_000_000); // long-running agent
    expect(reg.has(id, token)).toBe(true);
    const seen: RunEvent[] = [];
    reg.subscribe(id, token, { onEvent: (e) => seen.push(e) });
    reg.publish(id, call("still going"));
    expect(seen).toEqual([seq(1, call("still going"))]);
  });
});

describe("snapshot — token-gated read of a run's backlog", () => {
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
      stepCount: 1,
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
      stepCount: 1,
      truncated: false,
    });
    expect(reg.snapshot(id, "wrong")).toBeNull();
    expect(reg.snapshot("nope", token)).toBeNull();
  });
});

// Feature: docs/reference/specs/run-history.md — `markPersisted`: the history
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
          stepCount: 0,
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
    reg.seal(id); // the TTL runs from the seal
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

// Feature: docs/reference/specs/live-view.md item 10 — run control. Every run owns a
// RunControl (soft/hard stop request + a hard AbortSignal); `requestStop` is the
// token-gated control-plane entry the /runs surface calls.
describe("RunRegistry.requestStop — run control", () => {
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
    reg.subscribe(id, token, { onEvent: (e) => got.push(e) });
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

// Feature: docs/reference/specs/run-visibility.md — the exchange in the stream: every
// published event is stamped with a monotonic per-run `seq`, an event published
// after finish() is dropped (the dispatcher must publish the answer BEFORE finishing),
// and the label is redacted at create() so a secret in the request snippet never
// reaches the index.
describe("RunRegistry — text events, seq, label redaction", () => {
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
    reg.subscribe(id, token, { onEvent: (e) => seen.push(e) });
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

// Feature: docs/reference/specs/live-view.md — a throwing per-run subscriber is
// isolated like index sinks.
describe("RunRegistry — subscriber isolation", () => {
  it("a throwing per-run subscriber does not break publish for other subscribers or the publisher", () => {
    const { reg } = testRegistry();
    const { id, token } = reg.create();
    const seen: RunEvent[] = [];
    reg.subscribe(id, token, {
      onEvent: () => {
        throw new Error("dead sink");
      },
    });
    reg.subscribe(id, token, { onEvent: (e) => seen.push(e) });
    expect(() => reg.publish(id, call("$ ls"))).not.toThrow();
    expect(seen).toHaveLength(1);
    expect(reg.snapshot(id, token)?.events).toHaveLength(1); // still recorded
  });
});

describe("RunRegistry — token-free operator reads", () => {
  it("getById/snapshotById mirror the token-gated reads and are null for unknown or evicted runs", () => {
    const { reg, tick } = testRegistry({ ttlMs: 60_000 });
    const { id, token } = reg.create("lbl");
    reg.publish(id, call("$ ls"));
    expect(reg.getById(id)).toEqual(reg.listActive()[0]);
    expect(reg.snapshotById(id)).toEqual(reg.snapshot(id, token));
    expect(reg.getById("nope")).toBeNull();
    expect(reg.snapshotById("nope")).toBeNull();
    reg.finish(id);
    reg.seal(id); // the TTL runs from the seal
    tick(60_001);
    expect(reg.getById(id)).toBeNull();
    expect(reg.snapshotById(id)).toBeNull();
  });

  it("requestStopById drives the control, publishes stop_requested with a sanitized actor, and refuses finished/unknown runs", () => {
    const { reg } = testRegistry();
    const { id, token, control } = reg.create();
    const seen: RunEvent[] = [];
    reg.subscribe(id, token, { onEvent: (e) => seen.push(e) });
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
    reg.subscribe(id, token, { onEvent: (e) => seen.push(e) });
    reg.requestStopById(id, "soft", { kind: "chat", id: "   " });
    expect(seen.at(-1)).toMatchObject({ actor: { kind: "chat", id: "unknown" } });
  });
});
