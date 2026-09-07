// `load:e2e`: N runs through the whole bot via `POST /ingress` (synchronous
// mode: the response carries the run receipt `{ id, status }`, so one request
// is one run with its duration and terminal status), while `GET /healthz` is
// sampled for in-flight runs and the process metrics the plan's D10 bounds
// (RSS, heap, event-loop lag). The model is the scripted provider; the
// resident and sandbox Workers are whatever the bot is configured with.

import type { Sample } from "./aggregate.js";
import { runThreads, type RunThreadsResult } from "./runLoop.js";

export interface E2eLoadParams {
  runId: string;
  ingressUrl: string;
  token: string;
  /** The message each run sends, e.g. `agent:coding in owner/name: load harness`. */
  text: string;
  threads: number;
  staggerMs: number;
  holdMs: number;
  healthzUrl?: string;
  healthzEveryMs?: number;
  /** Per-request wait for the synchronous ingress answer. */
  requestTimeoutMs?: number;
  /** Pause between one thread's runs; after a failed request the pause is at
   *  least `failurePauseMs`, so a dead endpoint is never hammered at full speed. */
  pauseMs?: number;
  failurePauseMs?: number;
}

export interface E2eLoadDeps {
  fetch: typeof fetch;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  signal?: AbortSignal;
}

export interface HealthSample {
  at: number;
  ok: boolean;
  inFlight?: number;
  rssMb?: number;
  heapUsedMb?: number;
  eventLoopLagP99Ms?: number;
  error?: string;
}

export interface E2eLoadOutcome {
  samples: Sample[];
  result: RunThreadsResult;
  health: HealthSample[];
}

export const e2eThreadFor = (runId: string, thread: number) => `${runId}-${thread}`;

export async function runE2eLoad(params: E2eLoadParams, deps: E2eLoadDeps): Promise<E2eLoadOutcome> {
  const now = deps.now ?? Date.now;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const samples: Sample[] = [];
  const health: HealthSample[] = [];
  const fetchImpl = deps.fetch;
  let running = true;

  const sampleHealth = async () => {
    if (!params.healthzUrl) return;
    const at = now();
    try {
      const res = await fetchImpl(params.healthzUrl, { signal: AbortSignal.timeout(5_000) });
      const body = (await res.json()) as {
        inFlight?: number;
        process?: { rssMb?: number; heapUsedMb?: number; eventLoopLagP99Ms?: number };
      };
      health.push({
        at,
        ok: res.ok,
        ...(typeof body.inFlight === "number" ? { inFlight: body.inFlight } : {}),
        ...(body.process?.rssMb !== undefined ? { rssMb: body.process.rssMb } : {}),
        ...(body.process?.heapUsedMb !== undefined ? { heapUsedMb: body.process.heapUsedMb } : {}),
        ...(body.process?.eventLoopLagP99Ms !== undefined ? { eventLoopLagP99Ms: body.process.eventLoopLagP99Ms } : {}),
      });
    } catch (err) {
      health.push({ at, ok: false, error: err instanceof Error ? err.message : String(err) });
    }
  };
  // The sampler's sleep is raced against the threads finishing, so the run
  // ends when the last thread does — never up to healthzEveryMs later.
  let finish!: () => void;
  const finished = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const healthLoop = (async () => {
    if (!params.healthzUrl) return;
    const every = params.healthzEveryMs ?? 15_000;
    while (running) {
      await sampleHealth();
      await Promise.race([sleep(every), finished]);
    }
  })();

  const result = await runThreads<{ thread: string }>({
    threads: params.threads,
    staggerMs: params.staggerMs,
    holdMs: params.holdMs,
    now,
    sleep,
    signal: deps.signal,
    setup: async (i) => ({ thread: e2eThreadFor(params.runId, i) }),
    iterate: async (i, ctx) => {
      const startedAt = now();
      let failed: boolean;
      try {
        const res = await fetchImpl(params.ingressUrl, {
          method: "POST",
          headers: { "content-type": "application/json", authorization: `Bearer ${params.token}` },
          body: JSON.stringify({ text: params.text, channel: "load", thread: ctx.thread }),
          signal: AbortSignal.timeout(params.requestTimeoutMs ?? 45 * 60_000),
        });
        const ms = now() - startedAt;
        const body = (await res.json().catch(() => ({}))) as { run?: { id: string; status: string }; error?: string };
        const status = body.run?.status ?? (res.ok ? "no-run" : `http-${res.status}`);
        const ok = res.ok && status === "completed";
        failed = !ok;
        samples.push({ op: "run", thread: i, startedAt, ms, ok, status, ...(ok ? {} : { reason: status }) });
      } catch (err) {
        failed = true;
        samples.push({
          op: "run",
          thread: i,
          startedAt,
          ms: now() - startedAt,
          ok: false,
          status: "transport",
          reason: err instanceof Error && err.name === "TimeoutError" ? "timeout" : "transport",
        });
      }
      const pause = failed ? Math.max(params.pauseMs ?? 0, params.failurePauseMs ?? 5_000) : (params.pauseMs ?? 0);
      if (pause > 0) await sleep(pause);
    },
    teardown: async () => {},
  });
  running = false;
  finish();
  await healthLoop;
  await sampleHealth();
  return { samples, result, health };
}
