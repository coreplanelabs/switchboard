import { describe, expect, it } from "vitest";
import { summarize } from "./aggregate.js";
import { runSandboxLoad, SANDBOX_LOAD_MAX_THREADS } from "./sandboxLoad.js";

// `load:sandbox` against a stubbed fleet (docs/reference/specs/load-harness.md item 11):
// the first command per thread is the cold start, a full fleet answers the
// capacity error the executor raises, and the ceiling guard holds.

function fleet(seats: number) {
  let t = 0;
  let live = 0;
  return {
    now: () => t,
    sleep: async (ms: number) => {
      t += ms;
    },
    openClient: () => {
      let created = false;
      return {
        async exec(command: string) {
          if (!created) {
            if (live >= seats)
              throw new Error(
                "sandbox fleet busy — no free per-thread sandbox after waiting 300s (the fleet's max_instances is reached)",
              );
            live++;
            created = true;
            t += 8_000;
          }
          t += command.includes("node -e") ? 2_000 : 100;
          return "ok";
        },
      };
    },
  };
}

describe("runSandboxLoad", () => {
  it("records the cold start as first-exec, then exec and exec-cpu per iteration", async () => {
    const out = await runSandboxLoad(
      { runId: "s1", threads: 2, staggerMs: 0, holdMs: 3_000, cpuSeconds: 2, pauseMs: 0 },
      fleet(25),
    );
    const s = summarize(out.samples);
    expect(s.ops.map((o) => o.op)).toEqual(["first-exec", "exec", "exec-cpu"]);
    expect(s.ops[0]).toMatchObject({ count: 2, ok: 2, p50: 8_100 });
  });

  it("past the fleet's seats the first command fails as fleet-busy and the thread is counted as a setup failure", async () => {
    const out = await runSandboxLoad(
      { runId: "s2", threads: 3, staggerMs: 0, holdMs: 1_000, cpuSeconds: 1, pauseMs: 0 },
      fleet(2),
    );
    expect(summarize(out.samples).refusals).toEqual({ "fleet-busy": 1 });
    expect(out.result.setupFailures).toBe(1);
  });

  it(`refuses more than ${SANDBOX_LOAD_MAX_THREADS} threads without the override`, async () => {
    await expect(
      runSandboxLoad(
        { runId: "s3", threads: SANDBOX_LOAD_MAX_THREADS + 1, staggerMs: 0, holdMs: 1, cpuSeconds: 1 },
        fleet(100),
      ),
    ).rejects.toThrow(/--override/);
  });
});

// `load:seeded` (docs/reference/specs/load-harness.md item 11, execution.md
// item 25): every thread seeds first; the seed and the Worker's step timings
// are ops of their own, and a refused seed ends the thread under its token.
describe("runSandboxLoad — seeded", () => {
  const seed = {
    slug: "acme/widgets",
    checkoutBackupId: "3f2a9c1e-5b7d-4e8f-9a0b-1c2d3e4f5a6b",
    depsBackupId: "aa11bb22-cc33-dd44-ee55-ff6677889900",
    ref: "main",
    sha: "0123456789abcdef0123456789abcdef01234567",
  };

  function seededFleet(answer: (thread: number) => { seeded: true } | { reason: string; detail: string }) {
    let t = 0;
    let opened = 0;
    const seeds: unknown[] = [];
    return {
      seeds,
      now: () => t,
      sleep: async (ms: number) => {
        t += ms;
      },
      openClient: () => {
        const thread = opened++;
        return {
          async seed(s: unknown) {
            seeds.push(s);
            t += 30_000;
            const a = answer(thread);
            if ("seeded" in a) {
              return {
                seeded: true as const,
                cached: false,
                slug: seed.slug,
                ref: seed.ref,
                sha: seed.sha,
                from: { ref: seed.ref, sha: seed.sha, checkoutBackupId: seed.checkoutBackupId },
                steps: { restore: 18_000, deps: 9_000, fixup: 3_000 },
                phases: {
                  checkout: { download: 12_000, extract: 6_000 },
                  deps: { download: 7_000, extract: 2_000 },
                },
                ms: 30_000,
              };
            }
            return { seeded: false as const, reason: a.reason as "seed-missing", detail: a.detail };
          },
          async exec() {
            t += 100;
            return "ok";
          },
        };
      },
    };
  }

  it("seeds before the first command and records the seed plus the Worker's restore, deps and fix-up timings — and each restore's download and extraction — as their own ops", async () => {
    const fleet = seededFleet(() => ({ seeded: true }));
    const out = await runSandboxLoad(
      { runId: "s4", threads: 2, staggerMs: 0, holdMs: 1_000, cpuSeconds: 1, pauseMs: 0, seed },
      fleet,
    );
    const s = summarize(out.samples);
    expect(s.ops.map((o) => o.op)).toEqual([
      "seed",
      "seed-restore",
      "seed-deps",
      "seed-fixup",
      "seed-checkout-download",
      "seed-checkout-extract",
      "seed-deps-download",
      "seed-deps-extract",
      "first-exec",
      "exec",
      "exec-cpu",
    ]);
    expect(s.ops.find((o) => o.op === "seed")).toMatchObject({ count: 2, ok: 2, p50: 30_000 });
    expect(s.ops.find((o) => o.op === "seed-restore")).toMatchObject({ count: 2, p50: 18_000 });
    // the two phases of each restore are rows of their own, so a slow seed's owner is read, not guessed
    expect(s.ops.find((o) => o.op === "seed-checkout-download")).toMatchObject({ count: 2, p50: 12_000 });
    expect(s.ops.find((o) => o.op === "seed-deps-extract")).toMatchObject({ count: 2, p50: 2_000 });
    expect(fleet.seeds).toEqual([seed, seed]);
  });

  it("a refused seed ends its thread under the Worker's token — the handle gone is `seed-missing`", async () => {
    const out = await runSandboxLoad(
      { runId: "s5", threads: 2, staggerMs: 0, holdMs: 1_000, cpuSeconds: 1, pauseMs: 0, seed },
      seededFleet((thread) =>
        thread === 0 ? { seeded: true } : { reason: "seed-missing", detail: "restore: Backup not found" },
      ),
    );
    expect(summarize(out.samples).refusals).toEqual({ "seed-missing": 1 });
    expect(out.result.setupFailures).toBe(1);
  });

  it("a client without POST /seed cannot run a seeded load", async () => {
    const out = await runSandboxLoad(
      { runId: "s6", threads: 1, staggerMs: 0, holdMs: 1, cpuSeconds: 1, pauseMs: 0, seed },
      fleet(25),
    );
    expect(out.result.setupFailures).toBe(1);
    expect(out.samples).toEqual([]);
  });
});
