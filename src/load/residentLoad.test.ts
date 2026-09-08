import { describe, expect, it } from "vitest";
import { summarize } from "./aggregate.js";
import {
  purgePrefixFor,
  RESIDENT_LOAD_MAX_THREADS,
  runResidentLoad,
  type ResidentThreadClient,
} from "./residentLoad.js";

// `load:resident` against an in-memory resident (docs/reference/specs/load-harness.md
// item 8): a pool of N seats, named refusals past it, releases that free a
// seat, and the admin purge. The clock is virtual; nothing sleeps.

function fakeResident(poolSize: number) {
  let live = 0;
  const attached = new Set<string>();
  const written: string[] = [];
  const purges: string[] = [];
  let t = 0;
  const now = () => t;
  const sleep = async (ms: number) => {
    t += ms;
  };
  const openClient = (threadKey: string, readonly: boolean): ResidentThreadClient => ({
    async attach() {
      if (live >= poolSize) {
        throw new Error(
          `resident attach failed for repo:x/y: user-pool-exhausted: all ${poolSize} thread users are allocated`,
        );
      }
      live++;
      attached.add(threadKey);
      t += 100;
      return { ref: "main", sha: "abc" };
    },
    async exec(command) {
      t += command.includes("node -e") ? 3_000 : 50;
      return "ok";
    },
    async readFile() {
      t += 20;
      return "# readme";
    },
    async writeFile(path) {
      if (readonly) throw new Error("resident /write: read-only worktree");
      written.push(path);
      t += 30;
      return `Wrote ${path}`;
    },
    async release() {
      live--;
      attached.delete(threadKey);
      t += 40;
      return { released: true };
    },
  });
  return {
    now,
    sleep,
    openClient,
    written,
    purges,
    status: async () => ({ state: "warm", inFlight: 0 }),
    purge: async (prefix: string) => {
      purges.push(prefix);
      return { purged: attached.size, keptLive: 0 };
    },
    get live() {
      return live;
    },
  };
}

describe("runResidentLoad", () => {
  it("drives the coding mix per thread, releases every seat, and purges the run's bindings", async () => {
    const fake = fakeResident(16);
    const out = await runResidentLoad(
      {
        runId: "r1",
        resource: "repo:x/y",
        threads: 3,
        staggerMs: 0,
        holdMs: 5_000,
        profile: "coding",
        cpuSeconds: 3,
        pauseMs: 0,
      },
      fake,
    );
    const s = summarize(out.samples);
    expect(s.ops.map((o) => o.op)).toEqual(["attach", "read", "exec", "exec-cpu", "write", "detach"]);
    expect(s.ops.find((o) => o.op === "attach")).toMatchObject({ count: 3, ok: 3 });
    expect(s.ops.find((o) => o.op === "detach")).toMatchObject({ count: 3, ok: 3 });
    expect(s.refusals).toEqual({});
    expect(fake.live).toBe(0);
    expect(fake.written.every((p) => p.startsWith(".load-harness/thread-"))).toBe(true);
    expect(fake.purges).toEqual([purgePrefixFor("r1")]);
    expect(out.purge).toEqual({ purged: 0, keptLive: 0 });
    expect(out.result.started).toBe(3);
  });

  it("the review profile attaches read-only and never writes", async () => {
    const fake = fakeResident(16);
    const seen: boolean[] = [];
    const out = await runResidentLoad(
      {
        runId: "r2",
        resource: "repo:x/y",
        threads: 1,
        staggerMs: 0,
        holdMs: 1_000,
        profile: "review",
        cpuSeconds: 1,
        pauseMs: 0,
      },
      {
        ...fake,
        openClient: (k, ro) => {
          seen.push(ro);
          return fake.openClient(k, ro);
        },
      },
    );
    expect(seen).toEqual([true]);
    expect(summarize(out.samples).ops.map((o) => o.op)).not.toContain("write");
    expect(fake.written).toEqual([]);
  });

  it("past the pool the extra attaches are refused by name and the run still completes and purges", async () => {
    const fake = fakeResident(2);
    const out = await runResidentLoad(
      {
        runId: "r3",
        resource: "repo:x/y",
        threads: 4,
        staggerMs: 0,
        holdMs: 1_000,
        profile: "coding",
        cpuSeconds: 1,
        pauseMs: 0,
      },
      fake,
    );
    const s = summarize(out.samples);
    expect(s.refusals).toEqual({ "user-pool-exhausted": 2 });
    expect(s.ops.find((o) => o.op === "attach")).toMatchObject({ count: 4, ok: 2, failed: 2 });
    expect(out.result.setupFailures).toBe(2);
    expect(fake.live).toBe(0);
    expect(fake.purges).toHaveLength(1);
  });

  it("refuses to start when the resident has work in flight, or when in-flight is unknown", async () => {
    const fake = fakeResident(16);
    const params = {
      runId: "r4",
      resource: "repo:x/y",
      threads: 1,
      staggerMs: 0,
      holdMs: 1,
      profile: "coding" as const,
      cpuSeconds: 1,
    };
    await expect(
      runResidentLoad(params, { ...fake, status: async () => ({ state: "warm", inFlight: 2 }) }),
    ).rejects.toThrow(/2 op\(s\) in flight/);
    await expect(
      runResidentLoad(params, { ...fake, status: async () => ({ state: "unknown", inFlight: null }) }),
    ).rejects.toThrow(/unknown number/);
    expect(fake.purges).toEqual([]);
  });

  it(`refuses more than ${RESIDENT_LOAD_MAX_THREADS} threads without the override, and allows it with`, async () => {
    const fake = fakeResident(64);
    const params = {
      runId: "r5",
      resource: "repo:x/y",
      threads: 17,
      staggerMs: 0,
      holdMs: 1,
      profile: "coding" as const,
      cpuSeconds: 1,
      pauseMs: 0,
    };
    await expect(runResidentLoad(params, fake)).rejects.toThrow(/--override/);
    const out = await runResidentLoad({ ...params, override: true }, fake);
    expect(out.result.started).toBe(17);
  });

  it("a failed purge is reported, never thrown — the measurements still come back", async () => {
    const fake = fakeResident(16);
    const out = await runResidentLoad(
      {
        runId: "r6",
        resource: "repo:x/y",
        threads: 1,
        staggerMs: 0,
        holdMs: 1,
        profile: "coding",
        cpuSeconds: 1,
        pauseMs: 0,
      },
      {
        ...fake,
        purge: async () => {
          throw new Error("HTTP 403");
        },
      },
    );
    expect(out.purge).toEqual({ failed: "HTTP 403" });
    expect(out.samples.length).toBeGreaterThan(0);
  });
});
