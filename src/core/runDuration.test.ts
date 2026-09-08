// Feature: features/tracing.md — one duration definition for the six surfaces.
import { describe, expect, it } from "vitest";
import { runDurationMs } from "./runDuration.js";

describe("runDurationMs", () => {
  it("a finished run measures receivedAt → finishedAt, falling back to startedAt for a run without the stamp", () => {
    expect(runDurationMs({ receivedAt: 1_000, startedAt: 5_000, finishedAt: 61_000 })).toBe(60_000);
    expect(runDurationMs({ startedAt: 5_000, finishedAt: 61_000 })).toBe(56_000);
  });

  it("a live run measures to the caller's now; without a now or a finishedAt (a tombstone) there is no duration", () => {
    expect(runDurationMs({ receivedAt: 1_000, startedAt: 5_000 }, 31_000)).toBe(30_000);
    expect(runDurationMs({ startedAt: 5_000 })).toBeUndefined();
  });

  it("finishedAt wins over a now (a finished run never ticks) and skew can never read negative", () => {
    expect(runDurationMs({ startedAt: 5_000, finishedAt: 8_000 }, 99_000)).toBe(3_000);
    expect(runDurationMs({ startedAt: 5_000, finishedAt: 4_000 })).toBe(0);
    expect(runDurationMs({ receivedAt: 9_000, startedAt: 5_000 }, 8_000)).toBe(0);
  });
});
