import { describe, expect, it, vi } from "vitest";
import { buildScheduleStore, InMemoryScheduleStore, SCHEDULE_WORKER_TIMEOUT_MS, WorkerScheduleStore } from "./scheduleStore.js";
import type { ScheduleFiring } from "./schedules.js";

// Feature: features/live-view.md item 13 (#244): where a schedule's firings
// live. Two implementations of one seam (AGENTS.md invariant 2): the durable
// Worker client (ScheduleDO on the state Worker — the production choice, so
// the record survives bot restarts, invariant 6) and the in-memory store for
// tests. The shim WRITES firings; the bot's /runs panel READS the latest.

const firing = (schedule: string, firedAt: number, over: Partial<ScheduleFiring> = {}): ScheduleFiring => ({
  schedule,
  firedAt,
  outcome: "completed",
  runId: `run-${schedule}-${firedAt}`,
  ...over,
});

describe("InMemoryScheduleStore", () => {
  it("latest() is the newest firing per schedule, oldest schedule first; empty when nothing fired", async () => {
    const store = new InMemoryScheduleStore();
    expect(await store.latest()).toEqual([]);
    await store.record(firing("self-improvement", 100));
    await store.record(firing("self-improvement", 300, { outcome: "failed" }));
    await store.record(firing("nightly", 200));
    // Out-of-order write: an older firing arriving late never replaces the newest.
    await store.record(firing("self-improvement", 250));
    expect(await store.latest()).toEqual([firing("self-improvement", 300, { outcome: "failed" }), firing("nightly", 200)]);
  });

  it("firing while a previous firing's run is still in flight: both are kept, the newer wins latest()", async () => {
    const store = new InMemoryScheduleStore();
    await Promise.all([store.record(firing("s", 1000, { runId: "a" })), store.record(firing("s", 1001, { runId: "b" }))]);
    expect((await store.latest())[0].runId).toBe("b");
    expect(store.all("s").map((f) => f.runId)).toEqual(["a", "b"]);
  });

  it("returns copies — a caller mutating a result cannot corrupt the store", async () => {
    const store = new InMemoryScheduleStore();
    await store.record(firing("s", 1));
    const [f] = await store.latest();
    f.outcome = "failed";
    expect((await store.latest())[0].outcome).toBe("completed");
  });
});

describe("WorkerScheduleStore (HTTPS client to the state Worker)", () => {
  const opts = { baseUrl: "https://memory.test/", token: "tok" };

  it("record POSTs /schedules/record with the bearer, the firing, and a timeout; non-2xx throws with the Worker's error", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ ok: true, retained: 3 }), { status: 200 }));
    const store = new WorkerScheduleStore({ ...opts, fetch: fetchImpl as unknown as typeof fetch });
    await store.record(firing("s", 5));
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://memory.test/schedules/record");
    expect(init.method).toBe("POST");
    expect((init.headers as Record<string, string>).authorization).toBe("Bearer tok");
    expect(JSON.parse(init.body as string)).toEqual({ firing: firing("s", 5) });
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect(SCHEDULE_WORKER_TIMEOUT_MS).toBe(10_000);

    const failing = new WorkerScheduleStore({
      ...opts,
      fetch: (async () => new Response(JSON.stringify({ error: "firing must be a ScheduleFiring" }), { status: 400 })) as unknown as typeof fetch,
    });
    await expect(failing.record(firing("s", 6))).rejects.toThrow("schedule worker /record HTTP 400: firing must be a ScheduleFiring");
  });

  it("latest POSTs /schedules/latest and shape-checks the firings coming back (foreign rows dropped)", async () => {
    const good = firing("s", 1);
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ firings: [good, { schedule: "x" }, "junk"] }), { status: 200 }));
    const store = new WorkerScheduleStore({ ...opts, fetch: fetchImpl as unknown as typeof fetch });
    expect(await store.latest()).toEqual([good]);
    expect((fetchImpl.mock.calls[0] as unknown as [string])[0]).toBe("https://memory.test/schedules/latest");
  });

  it("latest throws on non-2xx, a non-JSON body, or a body without `firings` (the panel shows the error, never a fake empty state)", async () => {
    const mk = (res: () => Response) => new WorkerScheduleStore({ ...opts, fetch: (async () => res()) as unknown as typeof fetch });
    await expect(mk(() => new Response("nope", { status: 503 })).latest()).rejects.toThrow("schedule worker /latest HTTP 503");
    await expect(mk(() => new Response("<html>", { status: 200 })).latest()).rejects.toThrow("no firings array");
    await expect(mk(() => new Response(JSON.stringify({ ok: true }), { status: 200 })).latest()).rejects.toThrow("no firings array");
  });

  it("a transport failure propagates (the caller decides how to surface it)", async () => {
    const store = new WorkerScheduleStore({
      ...opts,
      fetch: (async () => {
        throw new TypeError("fetch failed");
      }) as unknown as typeof fetch,
    });
    await expect(store.latest()).rejects.toThrow("fetch failed");
  });
});

describe("buildScheduleStore (startup selection)", () => {
  it("worker + bearer → the durable Worker store", () => {
    const warn = vi.fn();
    const store = buildScheduleStore({ worker: { baseUrl: "https://m.test", tokenEnv: "T" } }, { T: "secret" }, warn);
    expect(store).toBeInstanceOf(WorkerScheduleStore);
    expect(warn).not.toHaveBeenCalled();
  });

  it("defaults the bearer env var to MEMORY_TOKEN (the state Worker's one secret)", () => {
    const store = buildScheduleStore({ worker: { baseUrl: "https://m.test" } }, { MEMORY_TOKEN: "secret" }, vi.fn());
    expect(store).toBeInstanceOf(WorkerScheduleStore);
  });

  it("no config → undefined with a warning naming what to set (the panel says firings are unavailable)", () => {
    const warn = vi.fn();
    expect(buildScheduleStore(undefined, {}, warn)).toBeUndefined();
    expect(warn.mock.calls[0][0]).toContain("schedules.worker.baseUrl");
  });

  it("worker configured but its bearer unset → undefined with a warning naming the env var", () => {
    const warn = vi.fn();
    expect(buildScheduleStore({ worker: { baseUrl: "https://m.test", tokenEnv: "STATE_BEARER" } }, {}, warn)).toBeUndefined();
    expect(warn.mock.calls[0][0]).toContain("STATE_BEARER");
  });
});
