// Feature: features/tracing.md item 19; features/resident-repos.md item 63 —
// the resident's step trace: offsets from the request start, bounded, sanitized.
import { describe, expect, it } from "vitest";
import { createStepTrace, sanitizeStepName, STEP_TRACE_MAX, STEP_TRACE_MAX_BYTES } from "./residentStepTrace.js";

describe("createStepTrace", () => {
  it("records each step as an offset from the request start with its duration, exit and timeout; the mutex wait ends where the lock was taken", () => {
    const t = createStepTrace(1_000_000);
    t.mutexWait(4_000, 1_005_000);
    t.record("clone", { startedAt: 1_005_000, endedAt: 1_035_000, exitCode: 0 });
    t.record("install", { startedAt: 1_035_000, endedAt: 1_155_000, exitCode: 1 });
    t.record("build", { startedAt: 1_155_000, endedAt: 1_455_000, exitCode: 124, timedOut: true });
    expect(t.steps()).toEqual([
      { name: "mutex_wait", startMs: 1_000, durationMs: 4_000, status: "ok", waitedMs: 4_000 },
      { name: "clone", startMs: 5_000, durationMs: 30_000, status: "ok", exitCode: 0 },
      { name: "install", startMs: 35_000, durationMs: 120_000, status: "error", exitCode: 1 },
      { name: "build", startMs: 155_000, durationMs: 300_000, status: "error", exitCode: 124, timedOut: true },
    ]);
  });

  it("sanitizes names to the identifier charset, keeps the newest past the count cap, and never exceeds the byte cap", () => {
    const t = createStepTrace(0);
    t.record("Deps Install (scoped) — retry #2", { startedAt: 0, endedAt: 1 });
    expect(t.steps()[0]!.name).toBe("deps-install-scoped-retry-2");
    expect(sanitizeStepName("")).toBe("step");
    expect(sanitizeStepName("x".repeat(80))).toHaveLength(32);
    for (let i = 0; i < STEP_TRACE_MAX + 10; i++) t.record(`step-${i}`, { startedAt: i, endedAt: i + 1 });
    const steps = t.steps();
    expect(steps).toHaveLength(STEP_TRACE_MAX);
    expect(steps[0]!.name).toBe("step-10"); // the oldest went
    expect(steps.at(-1)!.name).toBe(`step-${STEP_TRACE_MAX + 9}`);
    expect(JSON.stringify(steps).length).toBeLessThanOrEqual(STEP_TRACE_MAX_BYTES);
  });

  it("clock skew never produces a negative offset or duration; steps() returns copies", () => {
    const t = createStepTrace(10_000);
    t.record("fetch", { startedAt: 9_000, endedAt: 8_500 });
    const first = t.steps()[0]!;
    expect(first).toMatchObject({ startMs: 0, durationMs: 0, status: "ok" });
    first.name = "mutated";
    expect(t.steps()[0]!.name).toBe("fetch");
  });
});
