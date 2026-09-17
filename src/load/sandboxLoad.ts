// `load:sandbox`: N per-thread sandboxes through the bot's own cold-path
// client, each running a trivial command then the CPU burn on a loop. In
// Phase 0 this proves the current cold path end to end and measures what the
// fleet does past `max_instances` (`fleet-busy` waits, docs/reference/specs/execution.md
// item 14); with `--seed-from` each thread first restores the resident's
// snapshot through `POST /seed` (execution.md item 25), recording the seed
// and the Worker's own step timings — the numbers D4's gate reads. Sandboxes
// are not released explicitly — the Worker destroys them after their idle window.

import type { SandboxSeed, SeedAnswer } from "../execution/seedPlan.js";
import type { Sample } from "./aggregate.js";
import { reasonOf, timed } from "./reasons.js";
import { runThreads, type RunThreadsResult } from "./runLoop.js";
import { cpuBurnCommand } from "./scriptedProvider.js";

export interface SandboxThreadClient {
  exec(command: string, opts?: { timeoutMs?: number }): Promise<string>;
  /** The bot's client has it; a stub without it cannot run a seeded load. */
  seed?(seed: SandboxSeed): Promise<SeedAnswer>;
}

export interface SandboxLoadDeps {
  openClient(threadKey: string): SandboxThreadClient;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  signal?: AbortSignal;
}

export interface SandboxLoadParams {
  runId: string;
  threads: number;
  staggerMs: number;
  holdMs: number;
  cpuSeconds: number;
  /** Refuse more threads than the fleet's ceiling without `override`. */
  maxThreads?: number;
  override?: boolean;
  pauseMs?: number;
  /** The resident's snapshot handle every thread seeds from first (`load:seeded`). */
  seed?: SandboxSeed;
}

/** The Worker's step timings as their own ops, so the receipt shows where a
 *  seed's time went: the checkout restore, the deps restore, the fix-up. */
export const SEED_STEP_OPS = { restore: "seed-restore", deps: "seed-deps", fixup: "seed-fixup" } as const;

/** Each restore's two phases as their own ops, when the Worker reports them:
 *  the download and the extraction of the checkout archive and of the deps
 *  entry's — so a slow seed's owner is a row in the receipt, not a guess. */
export const SEED_PHASE_OPS = {
  checkout: { download: "seed-checkout-download", extract: "seed-checkout-extract" },
  deps: { download: "seed-deps-download", extract: "seed-deps-extract" },
} as const;

/** The cold fleet's `max_instances` at the time of writing; past it every
 *  command waits for a seat, which is a measurement worth taking on purpose. */
export const SANDBOX_LOAD_MAX_THREADS = 25;

export const sandboxThreadKeyFor = (runId: string, thread: number) => `load:${runId}:sandbox:${thread}`;

export async function runSandboxLoad(
  params: SandboxLoadParams,
  deps: SandboxLoadDeps,
): Promise<{ samples: Sample[]; result: RunThreadsResult }> {
  const max = params.maxThreads ?? SANDBOX_LOAD_MAX_THREADS;
  if (params.threads > max && !params.override) {
    throw new Error(
      `refusing ${params.threads} sandbox threads: the guard is ${max} (the fleet's max_instances); pass --override to measure the fleet-busy wait deliberately`,
    );
  }
  const now = deps.now ?? Date.now;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const samples: Sample[] = [];
  const record = async <T>(op: string, thread: number, fn: () => Promise<T>): Promise<T> => {
    const r = await timed(fn, now);
    samples.push({
      op,
      thread,
      startedAt: r.startedAt,
      ms: r.ms,
      ok: r.ok,
      ...(r.ok ? {} : { reason: reasonOf(r.error), status: r.error.message.slice(0, 200) }),
    });
    if (!r.ok) throw r.error;
    return r.value;
  };
  const burn = cpuBurnCommand(params.cpuSeconds);
  const result = await runThreads<SandboxThreadClient>({
    threads: params.threads,
    staggerMs: params.staggerMs,
    holdMs: params.holdMs,
    now,
    sleep,
    signal: deps.signal,
    setup: async (i) => {
      const client = deps.openClient(sandboxThreadKeyFor(params.runId, i));
      if (params.seed) {
        // The seed carries the container's start (the Worker waits it out
        // like any route), the restores and the fix-up; a refused seed ends
        // the thread with its token, so the receipt counts it by reason.
        const seed = params.seed;
        if (!client.seed) throw new Error("this client cannot seed: no POST /seed");
        const seedAt = now();
        const answer = await record("seed", i, async () => {
          const a = await client.seed!(seed);
          if (!a.seeded) throw new Error(`${a.reason}: ${a.detail}`);
          return a;
        });
        for (const [step, op] of Object.entries(SEED_STEP_OPS) as Array<[keyof typeof SEED_STEP_OPS, string]>) {
          const ms = answer.steps[step];
          if (ms !== null) samples.push({ op, thread: i, startedAt: seedAt, ms, ok: true });
        }
        if (answer.phases) {
          for (const which of ["checkout", "deps"] as const) {
            const phases = answer.phases[which];
            if (!phases) continue;
            for (const phase of ["download", "extract"] as const) {
              samples.push({
                op: SEED_PHASE_OPS[which][phase],
                thread: i,
                startedAt: seedAt,
                ms: phases[phase],
                ok: true,
              });
            }
          }
        }
      }
      // The first command is what creates the container (or, seeded, what
      // proves it is up): its latency is the cold start or the fleet wait.
      await record("first-exec", i, () => client.exec("echo ok"));
      return client;
    },
    iterate: async (i, client) => {
      await record("exec", i, () => client.exec("echo ok"));
      await record("exec-cpu", i, () => client.exec(burn, { timeoutMs: Math.max(60_000, params.cpuSeconds * 4_000) }));
      await sleep(params.pauseMs ?? 1_000);
    },
    teardown: async () => {},
  });
  return { samples, result };
}
