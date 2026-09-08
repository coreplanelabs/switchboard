import { describe, expect, it } from "vitest";
import {
  BASH_TIMEOUT_MAX_MS,
  BASH_TIMEOUT_MIN_MS,
  BASH_TIMEOUT_MS,
  EXEC_CALL_MARGIN_MS,
  bashTimeoutNote,
  clampBashTimeout,
} from "./bashTimeout.js";

// Feature: docs/reference/specs/execution.md item 11 — the per-call bash timeout policy.
// One clamp, shared by the tool layer, every executor, and both deploy
// Workers, so the bounds can never drift apart. The documented rule: a finite
// number is truncated and clamped into [1s, 20 min]; anything else (absent,
// NaN, a string) falls back to the 5-minute default.

describe("bash timeout constants", () => {
  it("default 5 min, floor 1s, ceiling 20 min — ceiling far inside the 45-min run budget", () => {
    expect(BASH_TIMEOUT_MS).toBe(5 * 60_000);
    expect(BASH_TIMEOUT_MIN_MS).toBe(1_000);
    expect(BASH_TIMEOUT_MAX_MS).toBe(20 * 60_000);
    expect(BASH_TIMEOUT_MAX_MS).toBeLessThan(45 * 60_000);
    expect(EXEC_CALL_MARGIN_MS).toBeGreaterThan(0);
  });
});

describe("clampBashTimeout", () => {
  it("a 25-minute request runs at the 20-minute ceiling", () => {
    expect(clampBashTimeout(25 * 60_000)).toBe(BASH_TIMEOUT_MAX_MS);
  });

  it("0 and negative values clamp up to the 1s floor (finite numbers clamp, they never default)", () => {
    expect(clampBashTimeout(0)).toBe(BASH_TIMEOUT_MIN_MS);
    expect(clampBashTimeout(-5)).toBe(BASH_TIMEOUT_MIN_MS);
    expect(clampBashTimeout(500)).toBe(BASH_TIMEOUT_MIN_MS);
  });

  it("NaN, Infinity, strings, and absence fall back to the default", () => {
    expect(clampBashTimeout(Number.NaN)).toBe(BASH_TIMEOUT_MS);
    expect(clampBashTimeout(Number.POSITIVE_INFINITY)).toBe(BASH_TIMEOUT_MS);
    expect(clampBashTimeout("600000")).toBe(BASH_TIMEOUT_MS);
    expect(clampBashTimeout(undefined)).toBe(BASH_TIMEOUT_MS);
    expect(clampBashTimeout(null)).toBe(BASH_TIMEOUT_MS);
  });

  it("an in-range value passes through, truncated to an integer", () => {
    expect(clampBashTimeout(90_000)).toBe(90_000);
    expect(clampBashTimeout(1_500.9)).toBe(1_500);
  });
});

describe("bashTimeoutNote", () => {
  it("names the limit that fired and the knob that raises it, so the model can self-correct", () => {
    const note = bashTimeoutNote(300_000);
    expect(note).toContain("300s");
    expect(note).toContain("timeoutMs");
    expect(note).toContain(String(BASH_TIMEOUT_MAX_MS));
  });
});
