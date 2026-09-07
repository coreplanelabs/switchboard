// Feature: features/run-history.md — the dispatcher's write path (#157 U4,
// KTD4): a finished run's record is handed to the writer AFTER the reply and
// persisted fire-and-forget with two jittered retries on transient failures,
// never on a 4xx, never on a missing route; every permanent loss is counted and
// every in-flight write (backoff included) is visible to the shutdown drain.
import { describe, expect, it } from "vitest";
import { createRunHistoryWriter, RUN_HISTORY_RETRY_DELAYS_MS } from "./runHistoryWriter.js";
import type { RunRecord } from "./runRecord.js";
import type { PutResult, RunStore } from "./runStore.js";
import { PermanentStoreError, RouteMissingError, TransientStoreError } from "./runStoreWorker.js";
import { analyzeRunFriction } from "./runFriction.js";

function record(id = "run-1"): RunRecord {
  return {
    id,
    channelId: "slack:C1",
    userId: "slack:U1",
    threadKey: "slack:C1:1.0",
    channelVisibility: "unknown",
    startedAt: 1000,
    finishedAt: 2000,
    status: "completed",
    eventCount: 0,
    storedEventCount: 0,
    truncated: false,
    events: [],
    diagnosis: analyzeRunFriction([], { finished: true }),
  };
}

const OK: PutResult = { ok: true, retained: 1, stored: true, rewritten: false };

/** A store whose `put` plays back a scripted sequence of outcomes. */
function scriptedStore(outcomes: Array<Error | PutResult>) {
  const puts: RunRecord[] = [];
  const store = {
    put: async (r: RunRecord) => {
      puts.push(r);
      const next = outcomes.shift();
      if (next instanceof Error) throw next;
      return next ?? OK;
    },
  } as unknown as RunStore;
  return { store, puts };
}

function harness(outcomes: Array<Error | PutResult>, over: { random?: () => number } = {}) {
  const { store, puts } = scriptedStore(outcomes);
  const warnings: string[] = [];
  const sleeps: number[] = [];
  const persisted: string[] = [];
  const writer = createRunHistoryWriter({
    store,
    warn: (m) => warnings.push(m),
    onPersisted: (id) => persisted.push(id),
    sleep: async (ms) => void sleeps.push(ms),
    random: over.random ?? (() => 0.5),
  });
  return { writer, puts, warnings, sleeps, persisted };
}

describe("createRunHistoryWriter", () => {
  it("a successful put is one write, pending back to 0, onPersisted called with the id", async () => {
    const h = harness([OK]);
    h.writer.write(record("run-ok"));
    expect(h.writer.pending()).toBe(1);
    await h.writer.settled();
    expect(h.writer.pending()).toBe(0);
    expect(h.puts.map((r) => r.id)).toEqual(["run-ok"]);
    expect(h.persisted).toEqual(["run-ok"]);
    expect(h.writer.failures()).toBe(0);
    expect(h.writer.degraded()).toBe(false);
    expect(h.warnings).toEqual([]);
  });

  it("a provisional write (#375, the start-of-run tombstone) skips onPersisted but is stored, retried and drain-counted like any write", async () => {
    const h = harness([new TransientStoreError("HTTP 503"), OK]);
    h.writer.write({ ...record("run-tomb"), status: "interrupted" }, { provisional: true });
    expect(h.writer.pending()).toBe(1); // drain-counted while in flight
    await h.writer.settled();
    expect(h.puts.map((r) => r.id)).toEqual(["run-tomb", "run-tomb"]); // the transient failure was retried
    expect(h.persisted).toEqual([]); // never onPersisted: the index dot means "finished and persisted"
    expect(h.writer.pending()).toBe(0);
    expect(h.writer.failures()).toBe(0);
  });

  it("503 twice then 200: three puts of the same record, backoff 1 s then 4 s (jittered), one success, pending 0, no failure counted", async () => {
    const h = harness([new TransientStoreError("HTTP 503"), new TransientStoreError("HTTP 503"), OK]);
    h.writer.write(record("run-retry"));
    await h.writer.settled();
    expect(h.puts).toHaveLength(3);
    expect(new Set(h.puts.map((r) => r.id))).toEqual(new Set(["run-retry"]));
    // random() = 0.5 → the midpoint of the jitter window is the nominal delay.
    expect(h.sleeps).toEqual(RUN_HISTORY_RETRY_DELAYS_MS);
    expect(h.writer.pending()).toBe(0);
    expect(h.writer.failures()).toBe(0);
    expect(h.persisted).toEqual(["run-retry"]);
  });

  it("pending() counts a write that is sitting in retry backoff", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const { store } = scriptedStore([new TransientStoreError("HTTP 503"), OK]);
    const writer = createRunHistoryWriter({ store, warn: () => {}, sleep: () => gate });
    writer.write(record());
    await new Promise((r) => setTimeout(r, 0)); // the first put has failed; the write is now in backoff
    expect(writer.pending()).toBe(1);
    release();
    await writer.settled();
    expect(writer.pending()).toBe(0);
  });

  it("the jitter is bounded: a delay is within ±50% of its nominal value for random() in [0, 1)", async () => {
    const lo = harness([new TransientStoreError("x"), OK], { random: () => 0 });
    lo.writer.write(record());
    await lo.writer.settled();
    expect(lo.sleeps).toEqual([RUN_HISTORY_RETRY_DELAYS_MS[0] * 0.5]);
    const hi = harness([new TransientStoreError("x"), OK], { random: () => 0.999 });
    hi.writer.write(record());
    await hi.writer.settled();
    expect(hi.sleeps[0]).toBeGreaterThan(RUN_HISTORY_RETRY_DELAYS_MS[0]);
    expect(hi.sleeps[0]).toBeLessThan(RUN_HISTORY_RETRY_DELAYS_MS[0] * 1.5);
  });

  it("three transient failures: the write is lost, counted once, warned once with the run id and attempt count", async () => {
    const h = harness([
      new TransientStoreError("HTTP 503"),
      new TransientStoreError("HTTP 502"),
      new TransientStoreError("fetch failed"),
    ]);
    h.writer.write(record("run-lost"));
    await h.writer.settled();
    expect(h.puts).toHaveLength(3);
    expect(h.writer.failures()).toBe(1);
    expect(h.writer.pending()).toBe(0);
    expect(h.warnings).toHaveLength(1);
    expect(h.warnings[0]).toContain("run-lost");
    expect(h.warnings[0]).toContain("3 attempts");
    expect(h.warnings[0]).toContain("fetch failed");
    expect(h.persisted).toEqual([]);
    expect(h.writer.degraded()).toBe(false);
  });

  it("a PermanentStoreError (413) is never retried: one put, one warn, failures +1, no sleep", async () => {
    const h = harness([new PermanentStoreError("run store /runs/put HTTP 413"), OK]);
    h.writer.write(record("run-big"));
    await h.writer.settled();
    expect(h.puts).toHaveLength(1);
    expect(h.sleeps).toEqual([]);
    expect(h.writer.failures()).toBe(1);
    expect(h.warnings).toHaveLength(1);
    expect(h.warnings[0]).toContain("HTTP 413");
    expect(h.warnings[0]).toContain("run-big");
    expect(h.writer.degraded()).toBe(false);
  });

  it("a RouteMissingError (404) logs the deploy-ordering message ONCE per writer, sets degraded, never retries, counts every loss", async () => {
    const h = harness([new RouteMissingError("HTTP 404"), new RouteMissingError("HTTP 404")]);
    h.writer.write(record("run-a"));
    h.writer.write(record("run-b"));
    await h.writer.settled();
    expect(h.puts).toHaveLength(2);
    expect(h.sleeps).toEqual([]);
    expect(h.writer.degraded()).toBe(true);
    expect(h.writer.failures()).toBe(2);
    const ordering = h.warnings.filter((w) => w.includes("state Worker has no /runs/put"));
    expect(ordering).toHaveLength(1);
    expect(ordering[0]).toBe(
      "[run-history] state Worker has no /runs/put — deploy the state Worker with run-history routes before this bot version",
    );
    expect(h.persisted).toEqual([]);
  });

  it("an unclassified error (a file store's fs failure) is treated as transient: retried, then counted", async () => {
    const h = harness([new Error("EIO"), OK]);
    h.writer.write(record("run-fs"));
    await h.writer.settled();
    expect(h.puts).toHaveLength(2);
    expect(h.writer.failures()).toBe(0);
    expect(h.persisted).toEqual(["run-fs"]);
  });

  it("a throwing onPersisted hook is isolated: still counted as a success and pending drains", async () => {
    const { store } = scriptedStore([OK]);
    const warnings: string[] = [];
    const writer = createRunHistoryWriter({
      store,
      warn: (m) => warnings.push(m),
      onPersisted: () => {
        throw new Error("boom");
      },
      sleep: async () => {},
    });
    writer.write(record());
    await writer.settled();
    expect(writer.pending()).toBe(0);
    expect(writer.failures()).toBe(0);
  });

  it("a final write for the same id stands down a provisional write sitting in retry backoff (#375): the tombstone retry never lands after the finish record", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const { store, puts } = scriptedStore([new TransientStoreError("HTTP 503"), OK, OK]);
    const persisted: string[] = [];
    const writer = createRunHistoryWriter({
      store,
      warn: () => {},
      onPersisted: (id) => persisted.push(id),
      sleep: () => gate,
    });
    writer.write({ ...record("run-x"), status: "interrupted" }, { provisional: true });
    await new Promise((r) => setTimeout(r, 0)); // the tombstone's first put failed; it is now in backoff
    writer.write(record("run-x")); // the run finished: its FINAL record is enqueued
    release();
    await writer.settled();
    // Two puts, not three: the provisional retry stood down instead of clobbering the final record.
    expect(puts.map((r) => [r.id, r.status])).toEqual([
      ["run-x", "interrupted"],
      ["run-x", "completed"],
    ]);
    expect(persisted).toEqual(["run-x"]);
    expect(writer.failures()).toBe(0); // a stood-down write is not a loss — the final record IS the run's record
    expect(writer.pending()).toBe(0);
  });

  it("the stand-down is per id: a provisional write for a DIFFERENT run retries and lands untouched", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const { store, puts } = scriptedStore([new TransientStoreError("HTTP 503"), OK, OK]);
    const writer = createRunHistoryWriter({ store, warn: () => {}, sleep: () => gate });
    writer.write({ ...record("run-a"), status: "interrupted" }, { provisional: true });
    await new Promise((r) => setTimeout(r, 0)); // run-a's tombstone is in backoff
    writer.write(record("run-b"));
    release();
    await writer.settled();
    expect(puts.map((r) => [r.id, r.status])).toEqual([
      ["run-a", "interrupted"],
      ["run-b", "completed"],
      ["run-a", "interrupted"], // the retry ran: run-b's final write supersedes nothing of run-a's
    ]);
    expect(writer.failures()).toBe(0);
  });

  it("a provisional write enqueued after the run's final write is dropped before its first attempt", async () => {
    const h = harness([OK]);
    h.writer.write(record("run-c"));
    await h.writer.settled();
    h.writer.write({ ...record("run-c"), status: "interrupted" }, { provisional: true });
    await h.writer.settled();
    expect(h.puts.map((r) => r.status)).toEqual(["completed"]); // the final record stands
    expect(h.writer.failures()).toBe(0);
  });

  it("concurrent writes are tracked independently: pending() is the number in flight, settled() waits for all", async () => {
    const h = harness([OK, new TransientStoreError("x"), OK]);
    h.writer.write(record("run-1"));
    h.writer.write(record("run-2"));
    expect(h.writer.pending()).toBe(2);
    await h.writer.settled();
    expect(h.writer.pending()).toBe(0);
    expect(h.persisted.sort()).toEqual(["run-1", "run-2"]);
  });
});
