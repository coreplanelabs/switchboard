// `load:sandbox`: N per-thread sandboxes through the bot's own cold-path
// client, each running a trivial command then the CPU burn on a loop. In
// Phase 0 this proves the current cold path end to end and measures what the
// fleet does past `max_instances` (`fleet-busy` waits, docs/reference/specs/execution.md
// item 14); Phase 3 adds `--seed` for the snapshot-seeded restore. Sandboxes
// are not released explicitly — the Worker sleeps them after their idle window.

import type { Sample } from "./aggregate.js";
import { reasonOf, timed } from "./reasons.js";
import { runThreads, type RunThreadsResult } from "./runLoop.js";
import { cpuBurnCommand } from "./scriptedProvider.js";

export interface SandboxThreadClient {
  exec(command: string, opts?: { timeoutMs?: number }): Promise<string>;
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
}

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
      // The first command is what creates the container: its latency is the cold start (or the fleet wait).
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
