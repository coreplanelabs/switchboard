// Feature: docs/reference/specs/load-harness.md — offline, repeatable model admission qualification.
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { Worker } from "node:worker_threads";
import { MODEL_CAPACITY_BENCHMARK, RESPONSES_VALIDATION_LIMITS } from "../core/budgets.js";
import { systemClock } from "../core/trace/clock.js";
import { createTracer } from "../core/trace/tracer.js";
import { RunBearerStore } from "../core/modelProxy/runBearers.js";
import { readProxyUnknownTerminal } from "../core/modelProxy/providerFailureAuth.js";
import { createModelProxyHandler } from "../channels/modelProxy.js";
import { responsesValidationCapacity as pool } from "../channels/responsesValidationCapacity.js";
import { secretsFrom } from "../secrets.js";

export interface ModelCapacityWorkload {
  profile: string;
  clients: number;
  turns: number;
  requestKiB: number;
  frameKiB: number;
  baselineMiB: number;
  providerDelayMs: number;
  minConcurrent: number;
  noQueue: boolean;
}
export function modelCapacityWorkload(profile: string): ModelCapacityWorkload {
  if (profile !== "team" && profile !== "burst") throw new Error("model-capacity profile must be team or burst");
  return {
    profile,
    clients: profile === "team" ? 20 : 64,
    turns: 2,
    requestKiB: 768,
    frameKiB: 128,
    baselineMiB: 960,
    providerDelayMs: MODEL_CAPACITY_BENCHMARK.providerDelayMs,
    minConcurrent: profile === "team" ? 20 : 32,
    noQueue: profile === "team",
  };
}
function cgroup(name: string): string | undefined {
  try {
    return readFileSync(`/sys/fs/cgroup/${name}`, "utf8").trim();
  } catch {
    return undefined;
  }
}
function percentiles(values: number[]) {
  const sorted = [...values].sort((a, b) => a - b);
  const at = (p: number) => sorted[Math.max(0, Math.ceil(sorted.length * p) - 1)] ?? 0;
  return { p50: at(0.5), p95: at(0.95), max: at(1) };
}
export type ModelCapacityReceipt = Awaited<ReturnType<typeof runModelCapacity>>;
export async function runModelCapacity(workload: ModelCapacityWorkload) {
  const held = Array.from({ length: workload.baselineMiB }, () => Buffer.alloc(1024 * 1024, 1));
  const root = createTracer({ clock: systemClock }).start("request", { sinks: [] });
  const bearers = new RunBearerStore({ clock: systemClock });
  const expected =
    `data: ${JSON.stringify({ type: "response.output_text.delta", delta: "x".repeat(workload.frameKiB * 1024) })}\n\n` +
    'data: {"type":"response.completed","response":{"id":"response","status":"completed","output":[],"usage":{"input_tokens":1,"output_tokens":1}}}\n\n';
  const start = systemClock();
  let peakActive = 0,
    peakQueued = 0,
    peakStorage = 0,
    peakRss = 0,
    attempts = 0;
  const queueWaits: number[] = [];
  const samples: { wave: number; client: number; ms: number; status: number; exact: boolean; reason?: string }[] = [];
  const sample = () => {
    peakActive = Math.max(peakActive, pool.activeCount);
    peakQueued = Math.max(peakQueued, pool.queuedCount);
    peakStorage = Math.max(peakStorage, pool.storageBytes);
    peakRss = Math.max(peakRss, process.memoryUsage().rss);
  };
  const handler = createModelProxyHandler({
    bearers,
    clock: systemClock,
    providers: () => ({
      offline: {
        type: "openai-compatible",
        wire: "openai-responses",
        baseUrl: "https://offline.invalid/v1",
        apiKeyEnv: "OPENAI_API_KEY",
      },
    }),
    secrets: secretsFrom({ OPENAI_API_KEY: "offline-fixture" }),
    log: (line) => {
      const wait = /waitMs=(\d+)/.exec(line);
      if (wait) queueWaits.push(Number(wait[1]));
      sample();
    },
    fetch: async () => {
      attempts++;
      sample();
      await new Promise((resolve) => setTimeout(resolve, workload.providerDelayMs));
      return new Response(expected, { headers: { "content-type": "text/event-stream" } });
    },
  });
  const server = createServer((req, res) => {
    if (req.url === "/healthz") {
      res.writeHead(200);
      res.end("ok");
    } else handler(req, res);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("benchmark server did not listen");
  const port = address.port;
  const probe = new Worker(
    `const {parentPort,workerData}=require('node:worker_threads');const http=require('node:http');let stopped=false;const times=[];parentPort.on('message',()=>stopped=true);(async()=>{while(!stopped){const start=process.hrtime.bigint();await new Promise((resolve,reject)=>http.get('http://127.0.0.1:'+workerData.port+'/healthz',r=>{r.resume();r.on('end',()=>{times.push(Number(process.hrtime.bigint()-start)/1e6);resolve();});}).on('error',reject));await new Promise(r=>setTimeout(r,workerData.probeMs));}parentPort.postMessage(times);})();`,
    { eval: true, env: {}, workerData: { port, probeMs: MODEL_CAPACITY_BENCHMARK.probeMs } },
  );
  // Install the result listener before stopping the probe; no race or missing final sample.
  const healthDone = new Promise<number[]>((resolve, reject) => {
    probe.once("message", resolve);
    probe.once("error", reject);
  });
  const sampler = setInterval(sample, MODEL_CAPACITY_BENCHMARK.sampleMs);
  const control = new AbortController();
  const deadline = setTimeout(() => control.abort(), MODEL_CAPACITY_BENCHMARK.deadlineMs);
  const tokens = Array.from({ length: workload.clients }, (_, id) =>
    bearers.mint({
      runId: `benchmark-${id}`,
      modelRef: "offline/gpt-5.4",
      providerName: "offline",
      providerWire: "openai-responses",
      model: "gpt-5.4",
      maxTokens: 64000,
      maxTurns: workload.turns,
      expiresAt: start + MODEL_CAPACITY_BENCHMARK.deadlineMs,
      span: root,
      publish: () => {},
    }),
  );
  const body = JSON.stringify({
    model: "gpt-5.4",
    stream: true,
    input: [{ role: "user", content: [{ type: "input_text", text: "x".repeat(workload.requestKiB * 1024) }] }],
  });
  let health: number[];
  try {
    for (let wave = 0; wave < workload.turns; wave++)
      await Promise.all(
        tokens.map(async (token, client) => {
          const began = systemClock();
          try {
            const response = await fetch(`http://127.0.0.1:${port}/v1/responses`, {
              method: "POST",
              headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
              body,
              signal: control.signal,
            });
            const text = await response.text();
            const terminal = readProxyUnknownTerminal(text);
            samples.push({
              wave,
              client,
              ms: systemClock() - began,
              status: response.status,
              exact: response.status === 200 && text === expected,
              ...(terminal
                ? {
                    reason: `${terminal.reason}:${terminal.rejection?.phase ?? "unknown"}:${terminal.rejection?.kind ?? "unknown"}`,
                  }
                : {}),
            });
          } catch {
            samples.push({
              wave,
              client,
              ms: systemClock() - began,
              status: 0,
              exact: false,
              reason: control.signal.aborted ? "deadline" : "transport",
            });
          }
        }),
      );
  } finally {
    clearTimeout(deadline);
    control.abort();
    clearInterval(sampler);
    probe.postMessage("stop");
    health = await healthDone;
    await probe.terminate();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  // Disposal must settle after HTTP close; timing out is a failed check, never a fabricated release.
  const settleBy = systemClock() + MODEL_CAPACITY_BENCHMARK.settleMs;
  while (pool.activeCount && systemClock() < settleBy)
    await new Promise((resolve) => setTimeout(resolve, MODEL_CAPACITY_BENCHMARK.sampleMs));
  sample();
  const events = cgroup("memory.events");
  const baselineHeld = held.reduce((sum, bytes) => sum + bytes[0] + bytes[bytes.length - 1], 0);
  const checks = [
    { name: "baseline stays held", pass: baselineHeld === workload.baselineMiB * 2 },
    {
      name: "every response matches",
      pass: samples.length === workload.clients * workload.turns && samples.every((s) => s.exact),
    },
    { name: "one upstream attempt per call", pass: attempts === samples.length },
    { name: "target concurrency reached", pass: peakActive >= workload.minConcurrent },
    { name: "team starts without header queuing", pass: !workload.noQueue || peakQueued === 0 },
    {
      name: "health below limit",
      pass: health.length > 0 && Math.max(...health) < MODEL_CAPACITY_BENCHMARK.maxHealthMs,
    },
    {
      name: "cgroup telemetry available",
      pass: events !== undefined && cgroup("cpu.max") !== undefined && cgroup("memory.max") !== undefined,
    },
    { name: "no OOM", pass: events !== undefined && /^oom 0$/m.test(events) && /^oom_kill 0$/m.test(events) },
    { name: "all credits returned", pass: pool.activeCount === 0 && pool.queuedCount === 0 && pool.storageBytes === 0 },
  ];
  return {
    schemaVersion: "model-capacity/1" as const,
    scope: "offline real HTTP and compiled proxy; synthetic provider; no deployment",
    at: new Date(start).toISOString(),
    workload,
    settings: { ...RESPONSES_VALIDATION_LIMITS } as { [K in keyof typeof RESPONSES_VALIDATION_LIMITS]: number },
    environment: {
      node: process.version,
      arch: process.arch,
      cpuMax: cgroup("cpu.max"),
      memoryMax: cgroup("memory.max"),
      swapMax: cgroup("memory.swap.max"),
      heldBaselineMiB: held.length,
    },
    metrics: {
      calls: samples.length,
      exact: samples.filter((s) => s.exact).length,
      attempts,
      totalMs: systemClock() - start,
      callsPerSecond: samples.length / ((systemClock() - start) / 1000),
      callMs: percentiles(samples.map((s) => s.ms)),
      queueWaitMs: percentiles(queueWaits),
      healthMs: percentiles(health),
      healthSamples: health.length,
      peakActive,
      peakQueued,
      peakStorageMiB: peakStorage / 1048576,
      peakRssMiB: peakRss / 1048576,
      cgroupPeakMiB: events === undefined ? undefined : Number(cgroup("memory.peak")) / 1048576,
      final: { active: pool.activeCount, queued: pool.queuedCount, storageBytes: pool.storageBytes },
    },
    checks,
    passed: checks.every((c) => c.pass),
    samples,
    limitations: [
      "Finite fake-provider workload, not whole-bot startup or natural provider latency.",
      "Compare hardware, runtime, workload and quota before comparing timings.",
      "Byte and storage maxima still refuse overlapping maximal payloads.",
    ],
  };
}
export function compareModelCapacity(current: ModelCapacityReceipt, baseline: ModelCapacityReceipt) {
  const sameFields = (left: object, right: object) => {
    const a = left as Record<string, unknown>,
      b = right as Record<string, unknown>;
    return Object.keys({ ...a, ...b }).every((key) => a[key] === b[key]);
  };
  const sameWorkload = sameFields(current.workload, baseline.workload);
  const sameEnvironment = sameFields(current.environment, baseline.environment);
  const settingsChanged = Object.keys(current.settings).filter(
    (key) =>
      current.settings[key as keyof typeof current.settings] !==
      baseline.settings[key as keyof typeof baseline.settings],
  );
  return {
    comparable: sameWorkload && sameEnvironment,
    reasons: [
      ...(!sameWorkload ? ["workload changed"] : []),
      ...(!sameEnvironment ? ["runtime or quota changed"] : []),
    ],
    settingsChanged,
    ...(sameWorkload && sameEnvironment
      ? {
          delta: {
            callP95Ms: current.metrics.callMs.p95 - baseline.metrics.callMs.p95,
            healthP95Ms: current.metrics.healthMs.p95 - baseline.metrics.healthMs.p95,
            peakCgroupMiB: (current.metrics.cgroupPeakMiB ?? 0) - (baseline.metrics.cgroupPeakMiB ?? 0),
            callsPerSecond: current.metrics.callsPerSecond - baseline.metrics.callsPerSecond,
          },
        }
      : {}),
  };
}
if (process.argv[2] === "--model-capacity-child") {
  const receipt = await runModelCapacity(modelCapacityWorkload(process.argv[3] ?? "team"));
  process.stdout.write(JSON.stringify(receipt));
  process.exitCode = receipt.passed ? 0 : 1;
}
