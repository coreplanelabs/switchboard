import type { SloCheck } from "./aggregate.js";
import type { E2eLoadOutcome, HealthSample } from "./e2eLoad.js";
import { peakConcurrency } from "./history.js";

export interface CapacityLimits {
  concurrent: number;
  sampledSpanMs: number;
  maxHealthGapMs: number;
  maxRssMb: number;
  maxLagMs: number;
  maxHealthMs: number;
}

const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && value >= 0;
const probeEnd = (h: HealthSample): number => h.at + (h.responseMs ?? NaN);
const complete = (h: HealthSample): boolean =>
  h.ok &&
  finite(h.at) &&
  finite(h.responseMs) &&
  finite(probeEnd(h)) &&
  finite(h.inFlight) &&
  Number.isInteger(h.inFlight) &&
  finite(h.rssMb) &&
  finite(h.heapUsedMb) &&
  finite(h.eventLoopLagP99Ms) &&
  h.draining === false &&
  typeof h.startedAt === "string" &&
  Number.isFinite(Date.parse(h.startedAt)) &&
  typeof h.buildCommit === "string" &&
  h.buildCommit.length > 0;

/** Polls establish a sampled span, not continuous server occupancy between reads.
 * An isolated target is required: health's inFlight also counts other work. */
export function evaluateCapacity(out: E2eLoadOutcome, limits: CapacityLimits) {
  const health = out.health;
  const requests = out.samples
    .filter((s) => s.op === "run" && finite(s.startedAt) && finite(s.ms) && s.ms > 0)
    .map((s) => ({ startedAt: s.startedAt, finishedAt: s.startedAt + s.ms }));
  const requestPeak = peakConcurrency(requests).peak;
  const deltas = new Map<number, number>();
  for (const r of requests) {
    deltas.set(r.startedAt, (deltas.get(r.startedAt) ?? 0) + 1);
    deltas.set(r.finishedAt, (deltas.get(r.finishedAt) ?? 0) - 1);
  }
  let live = 0;
  const timeline = [...deltas].sort(([a], [b]) => a - b).map(([at, delta]) => ({ at, live: (live += delta) }));
  const clientAt = (at: number) => {
    for (let i = timeline.length - 1; i >= 0; i--) if (timeline[i].at <= at) return timeline[i].live;
    return 0;
  };
  const clientCovers = (from: number, to: number) =>
    clientAt(from) >= limits.concurrent &&
    timeline.every((point) => point.at <= from || point.at > to || point.live >= limits.concurrent);
  const serverPeak = Math.max(0, ...health.filter(complete).map((h) => h.inFlight!));
  const successfulThreads = new Set(
    out.samples.filter((s) => s.op === "run" && s.ok && s.thread !== undefined).map((s) => s.thread),
  ).size;
  let spanStart: number | undefined;
  let previous: HealthSample | undefined;
  let sampledSpanMs = 0;
  for (const h of health) {
    const end = probeEnd(h);
    const gap = previous === undefined ? 0 : end - previous.at;
    const qualifies = complete(h) && h.inFlight! >= limits.concurrent && clientCovers(h.at, end);
    if (
      !qualifies ||
      (previous !== undefined && h.at < probeEnd(previous)) ||
      gap > limits.maxHealthGapMs ||
      (previous !== undefined && !clientCovers(previous.at, end))
    )
      spanStart = undefined;
    if (qualifies) {
      // The server observed each value somewhere within its request/receipt
      // window. First receipt → last request is the shortest possible span.
      spanStart ??= end;
      sampledSpanMs = Math.max(sampledSpanMs, Math.max(0, h.at - spanStart));
    }
    previous = h;
  }
  const max = (key: "rssMb" | "eventLoopLagP99Ms" | "responseMs") => Math.max(...health.map((h) => h[key] ?? NaN));
  const first = health[0];
  const checks: SloCheck[] = [];
  const check = (name: string, pass: boolean, actual: unknown, limit: string) =>
    checks.push({ name, pass, actual: String(actual), limit });
  check(
    "requested threads completed",
    successfulThreads >= limits.concurrent,
    successfulThreads,
    `≥ ${limits.concurrent}`,
  );
  check("client request peak", requestPeak >= limits.concurrent, requestPeak, `≥ ${limits.concurrent}`);
  check(
    "server concurrency sampled span",
    sampledSpanMs >= limits.sampledSpanMs,
    `${sampledSpanMs} ms`,
    `≥ ${limits.sampledSpanMs} ms at ≥ ${limits.concurrent}`,
  );
  check(
    "complete healthy process telemetry",
    health.length >= 2 && health.every(complete),
    `${health.filter(complete).length}/${health.length}`,
    "all, at least 2",
  );
  check(
    "one serving process",
    health.length >= 2 && health.every((h) => h.startedAt === first?.startedAt && h.buildCommit === first?.buildCommit),
    first?.startedAt ?? "missing",
    "unchanged start and build",
  );
  check(
    "uninterrupted driver",
    !out.result.aborted &&
      out.result.setupFailures === 0 &&
      out.result.errors === 0 &&
      out.result.teardownFailures === 0,
    JSON.stringify(out.result),
    "no abort or driver failure",
  );
  check(
    "zero failed capacity runs",
    out.samples.length > 0 && out.samples.every((s) => s.ok),
    out.samples.filter((s) => !s.ok).length,
    "0",
  );
  for (const [name, actual, bound] of [
    ["RSS maximum", max("rssMb"), limits.maxRssMb],
    ["event-loop p99 maximum", max("eventLoopLagP99Ms"), limits.maxLagMs],
    ["health response maximum", max("responseMs"), limits.maxHealthMs],
  ] as const)
    check(name, Number.isFinite(actual) && actual <= bound, actual, `≤ ${bound}`);
  return { evidence: { requestPeak, serverPeak, sampledSpanMs, successfulThreads }, checks };
}
