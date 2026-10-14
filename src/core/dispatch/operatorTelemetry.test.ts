import { describe, expect, it } from "vitest";
import { RoutingRecorder } from "./operatorTelemetry.js";
import type { RouteModelObservation } from "./route.js";
import { usageOfEvents } from "../runUsage.js";
import { analyzeRunFriction } from "../runFriction.js";
import { normalizeSpans, spansFromEvents } from "../normalizeSpans.js";

describe("routing telemetry retention", () => {
  it("retains distinct same-millisecond requests through timing reconstruction", async () => {
    let clock = 1_000;
    const recorders = Array.from(
      { length: 2 },
      () => new RoutingRecorder(() => clock, 1_000, 61_000, new AbortController().signal),
    );
    await Promise.all(
      recorders.map((recorder, index) =>
        recorder.during("model", async () => {
          clock = 2_000 + index * 1_000;
          return "completed";
        }),
      ),
    );
    const events = recorders.map((recorder) => ({
      type: "operator" as const,
      mode: "on" as const,
      outcome: "binds" as const,
      reason: "follow-up",
      telemetry: recorder.snapshot(),
    }));
    const normalized = normalizeSpans(events);
    expect(spansFromEvents(normalized, "owner").map((span) => span.durationMs)).toEqual([2_000, 1_000]);
    expect(normalizeSpans(normalized)).toEqual(normalized);
  });

  it("logs rejected late observations with the receipt identity while the saved snapshot stays immutable", async () => {
    let late: ((value: RouteModelObservation) => void) | undefined;
    const logs: unknown[] = [];
    const recorder = new RoutingRecorder(
      () => 1_000,
      1_000,
      61_000,
      new AbortController().signal,
      (value) => logs.push(value),
    );
    await recorder.during("model", async (observe) => {
      late = observe;
      return "completed";
    });
    const saved = recorder.snapshot();
    late?.({ requestId: "late-provider-id" });
    expect(logs.at(-1)).toMatchObject({
      receiptId: saved.id,
      index: 1,
      phase: "model",
      ignoredObservations: 1,
      ignoredReason: "sealed",
      ignoredAt: 1_000,
    });
    expect(saved.steps[0]).toMatchObject({ outcome: "completed" });
    expect(saved.steps[0]).not.toHaveProperty("requestId");
    expect(recorder.snapshot().ignoredObservations).toBe(1);
  });
  it("bounds Unicode evidence while retaining the first and last phase and explicit loss", async () => {
    let clock = 1_000;
    const recorder = new RoutingRecorder(() => clock, clock, 100_000, new AbortController().signal);
    for (let i = 0; i < 40; i++) {
      await recorder.during("model", async (observe) => {
        observe({
          provider: "例".repeat(300),
          model: `${i}/` + "例".repeat(300),
          effort: "例".repeat(300),
          effortWord: "例".repeat(300),
          requestId: "例".repeat(300),
          stopReason: "例".repeat(300),
          usage: { inputTokens: 10, outputTokens: 20 },
        });
        clock += 100;
      });
      recorder.annotate(
        recorder.latestModel(),
        {
          tool: "ask",
          input: {
            text: "例".repeat(300),
            proposal: "例".repeat(300),
          },
        },
        "例".repeat(300),
        "例".repeat(300),
      );
    }
    const kept = recorder.snapshot();
    expect(kept.steps[0]).toMatchObject({ index: 1, startedAt: 1_000 });
    expect(kept.steps.at(-1)).toMatchObject({ index: 40, finishedAt: 5_000 });
    expect(kept.steps.length + (kept.droppedSteps ?? 0)).toBe(40);
    expect(new TextEncoder().encode(JSON.stringify(kept)).byteLength).toBeLessThanOrEqual(24 * 1024);
    expect(kept.usage?.turns).toBe(40);
    expect(Object.values(kept.usage?.byModel ?? {}).reduce((sum, model) => sum + model.outputTokens, 0)).toBe(800);
    expect(kept.usageModelOverflow).toBe(true);
    const event = {
      type: "operator" as const,
      mode: "on" as const,
      outcome: "non_decision" as const,
      reason: "operator_timeout",
      telemetry: kept,
    };
    const usage = usageOfEvents([event]);
    expect(usage.turns).toBe(40);
    expect(Object.values(usage.byModel).reduce((sum, model) => sum + model.outputTokens, 0)).toBe(800);
    const diagnosis = analyzeRunFriction([event], { finished: true, window: { start: 1_000, end: 5_000 } });
    expect(diagnosis.shape).toMatchObject({ windowMs: 4_000, overheadMs: 0 });
    expect((diagnosis.shape?.thinkingMs ?? 0) + (diagnosis.shape?.notRecordedMs ?? 0)).toBe(4_000);
  });

  it("ignores late callbacks and keeps measured usage to known counters", async () => {
    let clock = 1_000;
    let late: ((value: RouteModelObservation) => void) | undefined;
    const recorder = new RoutingRecorder(() => clock, clock, 61_000, new AbortController().signal);
    await recorder.during("model", async (observe) => {
      late = observe;
      observe({ usage: Object.assign({ inputTokens: 10, outputTokens: 20 }, { secret: "private-value" }) });
      clock += 100;
      return "completed";
    });
    late?.({ requestId: "late-id", usage: { inputTokens: 100, outputTokens: 200 } });
    const kept = recorder.snapshot();
    late?.({ requestId: "after-seal" });
    expect(kept.steps).toEqual([
      {
        index: 1,
        phase: "model",
        startedAt: 1_000,
        finishedAt: 1_100,
        durationMs: 100,
        remainingMs: 59_900,
        outcome: "completed",
        usage: { inputTokens: 10, outputTokens: 20 },
      },
    ]);
    expect(JSON.stringify(kept)).not.toContain("private-value");
  });
});
