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
