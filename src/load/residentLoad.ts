// `load:resident`: N synthetic threads straight at the resident Worker through
// the bot's own client, each running a review- or coding-shaped tool mix on a
// loop for the hold period, then releasing. It answers the per-repo capacity
// questions that size a resident (docs/explanation/capacity-and-sizing.md):
// attach latency under load, exec latency under contended CPU, and which named
// refusals appear at which N. Guards: the target must report
// nothing in flight, more than RESIDENT_LOAD_MAX_THREADS needs an explicit
// override, and the bindings the run created are purged on the way out.

import type { Sample } from "./aggregate.js";
import { reasonOf, timed } from "./reasons.js";
import { runThreads, type RunThreadsResult } from "./runLoop.js";
import { cpuBurnCommand, HARNESS_DIR } from "./scriptedProvider.js";

/** The slice of `ResidentExecutor` the profile drives. */
export interface ResidentThreadClient {
  attach(): Promise<{ ref: string; sha: string }>;
  exec(command: string, opts?: { timeoutMs?: number }): Promise<string>;
  readFile(path: string): Promise<string>;
  writeFile(path: string, content: string): Promise<string>;
  release(mode: "always" | "if-clean"): Promise<{ released: boolean; reason?: string }>;
}

export interface ResidentLoadDeps {
  /** One client per synthetic thread; `readonly` for the review profile. */
  openClient(threadKey: string, readonly: boolean): ResidentThreadClient;
  /** The operator `GET /status` view: lifecycle state and in-flight ops. */
  status(): Promise<{ state: string; inFlight: number | null }>;
  /** The admin `purge-bindings` debug op. */
  purge(prefix: string): Promise<{ purged: number; keptLive: number }>;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  signal?: AbortSignal;
}

export interface ResidentLoadParams {
  runId: string;
  resource: string;
  threads: number;
  staggerMs: number;
  holdMs: number;
  profile: "review" | "coding";
  cpuSeconds: number;
  /** Refuse more threads than this without `override` (D9). */
  maxThreads?: number;
  override?: boolean;
  /** Pause between iterations of one thread's mix. */
  pauseMs?: number;
}

/** One resident holds 16 pool seats; a load run past that on a shared resident
 *  is a deliberate act, not a default. */
export const RESIDENT_LOAD_MAX_THREADS = 16;

export const threadKeyFor = (runId: string, thread: number) => `load:${runId}:${thread}`;
export const purgePrefixFor = (runId: string) => `load:${runId}:`;

export interface ResidentLoadOutcome {
  samples: Sample[];
  result: RunThreadsResult;
  purge: { purged: number; keptLive: number } | { failed: string };
}

export async function runResidentLoad(
  params: ResidentLoadParams,
  deps: ResidentLoadDeps,
): Promise<ResidentLoadOutcome> {
  const max = params.maxThreads ?? RESIDENT_LOAD_MAX_THREADS;
  if (params.threads > max && !params.override) {
    throw new Error(
      `refusing ${params.threads} threads against ${params.resource}: the guard is ${max} (one resident's pool); pass --override to exceed it deliberately`,
    );
  }
  const status = await deps.status();
  if (status.inFlight !== 0) {
    throw new Error(
      `refusing to start: ${params.resource} reports ${status.inFlight === null ? "an unknown number of" : status.inFlight} op(s) in flight (state ${status.state}); a load run needs a quiet resident`,
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
  const readonly = params.profile === "review";
  const burn = cpuBurnCommand(params.cpuSeconds);

  const result = await runThreads<ResidentThreadClient>({
    threads: params.threads,
    staggerMs: params.staggerMs,
    holdMs: params.holdMs,
    now,
    sleep,
    signal: deps.signal,
    setup: async (i) => {
      const client = deps.openClient(threadKeyFor(params.runId, i), readonly);
      await record("attach", i, () => client.attach());
      return client;
    },
    iterate: async (i, client) => {
      await record("read", i, () => client.readFile("README.md"));
      await record("exec", i, () => client.exec("git status --short | head -20"));
      await record("exec-cpu", i, () => client.exec(burn, { timeoutMs: Math.max(60_000, params.cpuSeconds * 4_000) }));
      if (!readonly) {
        await record("write", i, () =>
          client.writeFile(`${HARNESS_DIR}/thread-${i}.txt`, `load ${params.runId} thread ${i}\n`),
        );
      }
      await sleep(params.pauseMs ?? 1_000);
    },
    teardown: async (i, client) => {
      if (!client) return;
      await record("detach", i, () => client.release("always"));
    },
  });

  let purge: ResidentLoadOutcome["purge"];
  try {
    purge = await deps.purge(purgePrefixFor(params.runId));
  } catch (err) {
    purge = { failed: err instanceof Error ? err.message : String(err) };
  }
  return { samples, result, purge };
}
