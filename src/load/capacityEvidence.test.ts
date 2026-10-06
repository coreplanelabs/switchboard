import { describe, expect, it } from "vitest";
import { evaluateCapacity } from "./capacityEvidence.js";
import type { E2eLoadOutcome, HealthSample } from "./e2eLoad.js";

const limits = {
  concurrent: 100,
  sampledSpanMs: 30_000,
  maxHealthGapMs: 16_000,
  maxRssMb: 3_000,
  maxLagMs: 100,
  maxHealthMs: 500,
};
const health = (at: number, overrides: Partial<HealthSample> = {}): HealthSample => ({
  at,
  ok: true,
  responseMs: 20,
  inFlight: 100,
  rssMb: 500,
  heapUsedMb: 200,
  eventLoopLagP99Ms: 10,
  draining: false,
  startedAt: "2026-01-01T00:00:00.000Z",
  buildCommit: "fixture",
  ...overrides,
});
const outcome = (): E2eLoadOutcome => ({
  samples: Array.from({ length: 100 }, (_, thread) => ({ op: "run", thread, startedAt: 0, ms: 45_000, ok: true })),
  result: { started: 100, setupFailures: 0, iterations: 100, errors: 0, teardownFailures: 0, aborted: false },
  health: [health(0), health(15_000), health(30_020), health(45_000, { inFlight: 0 })],
});
const passes = (out: E2eLoadOutcome) => evaluateCapacity(out, limits).checks.every((c) => c.pass);

describe("evaluateCapacity", () => {
  it("requires measured client overlap and a consecutive sampled server span", () => {
    const out = outcome();
    expect(passes(out)).toBe(true);
    expect(evaluateCapacity(out, limits).evidence).toMatchObject({
      requestPeak: 100,
      serverPeak: 100,
      sampledSpanMs: 30_000,
    });
    out.samples = out.samples.map((s, i) => ({ ...s, startedAt: i * 45_000 }));
    expect(passes(out)).toBe(false);
    expect(evaluateCapacity(out, limits).evidence.requestPeak).toBe(1);
  });

  it("refuses a queued server, a brief peak, and an unsampled gap", () => {
    for (const samples of [
      [health(0, { inFlight: 1 }), health(15_000, { inFlight: 1 }), health(30_000, { inFlight: 1 })],
      [health(0, { inFlight: 99 }), health(15_000), health(30_000, { inFlight: 99 })],
      [health(0), health(30_000)],
    ])
      expect(passes({ ...outcome(), health: samples })).toBe(false);
  });

  it("requires client overlap throughout the same server sampling span", () => {
    const out = outcome();
    expect(passes({ ...out, health: [health(100_000), health(115_000), health(130_000)] })).toBe(false);
    expect(passes({ ...out, samples: out.samples.map((s) => ({ ...s, ms: 10_000 })) })).toBe(false);
    expect(
      passes({
        ...out,
        samples: [0, 15_000, 30_000].flatMap((startedAt) => out.samples.map((s) => ({ ...s, startedAt, ms: 10_000 }))),
      }),
    ).toBe(false);
  });

  it("credits only the conservative span between probe observation windows", () => {
    const out = {
      ...outcome(),
      health: [health(0, { responseMs: 400 }), health(15_200, { responseMs: 100 }), health(30_100)],
    };
    expect(passes(out)).toBe(false);
    expect(evaluateCapacity(out, limits).evidence.sampledSpanMs).toBe(29_700);
    out.health[2] = health(30_400);
    expect(passes(out)).toBe(true);
    expect(evaluateCapacity(out, limits).evidence.sampledSpanMs).toBe(30_000);
  });

  it("requires client coverage through probe receipts and bounds the possible observation gap", () => {
    const out = outcome();
    const delayedLast = [health(0), health(15_000), health(30_020, { responseMs: 100 })];
    expect(passes({ ...out, health: delayedLast, samples: out.samples.map((s) => ({ ...s, ms: 30_030 })) })).toBe(
      false,
    );
    const lateGap = [health(0), health(15_800, { responseMs: 300 }), health(30_020)];
    expect(passes({ ...out, health: lateGap })).toBe(false);
  });

  it("refuses missing, failed, malformed, draining, or over-budget telemetry", () => {
    for (const override of [
      { ok: false },
      { at: Infinity },
      { rssMb: undefined },
      { heapUsedMb: NaN },
      { eventLoopLagP99Ms: -1 },
      { inFlight: 100.5 },
      { rssMb: 3_001 },
      { eventLoopLagP99Ms: 101 },
      { responseMs: 501 },
      { draining: true },
      { startedAt: undefined },
      { buildCommit: undefined },
    ])
      expect(passes({ ...outcome(), health: [health(0), health(15_000, override), health(30_000)] })).toBe(false);
    expect(passes({ ...outcome(), health: [] })).toBe(false);
    expect(
      passes({ ...outcome(), health: [health(0), health(15_000), health(30_000), health(Infinity, { inFlight: 0 })] }),
    ).toBe(false);
  });

  it("refuses aborts, failed runs, incomplete thread coverage, and process changes", () => {
    const out = outcome();
    expect(passes({ ...out, result: { ...out.result, aborted: true } })).toBe(false);
    expect(passes({ ...out, samples: out.samples.slice(1) })).toBe(false);
    expect(passes({ ...out, samples: out.samples.map((s) => ({ ...s, thread: 0 })) })).toBe(false);
    expect(passes({ ...out, samples: out.samples.map((s) => ({ ...s, ok: false })) })).toBe(false);
    expect(
      passes({
        ...out,
        health: [health(0), health(15_000, { startedAt: "2026-01-02T00:00:00.000Z" }), health(30_000)],
      }),
    ).toBe(false);
  });
});
