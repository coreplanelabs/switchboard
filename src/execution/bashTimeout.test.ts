import { describe, expect, it } from "vitest";
import {
  BASH_TIMEOUT_MAX_MS,
  BASH_TIMEOUT_MIN_MS,
  BASH_TIMEOUT_MS,
  EXEC_CALL_MARGIN_MS,
  RUN_DEADLINE_RESERVE_MS,
  attachBoundWithinRun,
  bashTimeoutNote,
  clampBashTimeout,
} from "./bashTimeout.js";
import { ATTACH_REQUEST_MIN_MS } from "../core/budgets.js";

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

// execution.md item 9: an attach a call opens inside a run — the recovery
// attach, the wake wait's re-attach — is bounded by the attach's own default
// clipped to the run's remaining clock, the write-up reserve kept back.
describe("attachBoundWithinRun", () => {
  it("bounded by the attach default with room to spare, by the run's remainder less the reserve when that is shorter — never raised above the default", () => {
    expect(attachBoundWithinRun(10 * 60_000)).toEqual({ kind: "bounded", timeoutMs: BASH_TIMEOUT_MS });
    expect(attachBoundWithinRun(BASH_TIMEOUT_MS + RUN_DEADLINE_RESERVE_MS)).toEqual({
      kind: "bounded",
      timeoutMs: BASH_TIMEOUT_MS,
    });
    expect(attachBoundWithinRun(3 * 60_000)).toEqual({
      kind: "bounded",
      timeoutMs: 3 * 60_000 - RUN_DEADLINE_RESERVE_MS,
    });
    expect(attachBoundWithinRun(RUN_DEADLINE_RESERVE_MS + ATTACH_REQUEST_MIN_MS)).toEqual({
      kind: "bounded",
      timeoutMs: ATTACH_REQUEST_MIN_MS,
    });
  });

  it("exhausted inside the write-up reserve — at its edge, within it, past the lease — and under an attach's floor past it (61 s left is not a bound an attach can finish under, and a request cut mid-clone would be struck as a rollout); the one note names the run's clock and the bound that refused", () => {
    // Inside the reserve (its edge included): the reserve refused.
    for (const left of [RUN_DEADLINE_RESERVE_MS, 30_000, 0, -5_000]) {
      const bound = attachBoundWithinRun(left);
      expect(bound.kind, `${left}`).toBe("exhausted");
      if (bound.kind === "exhausted") {
        expect(bound.note).toBe(
          `the run has ${Math.max(0, Math.round(left / 1000))}s of wall clock left, inside the ${RUN_DEADLINE_RESERVE_MS / 1000}s write-up reserve, so no attach was opened`,
        );
      }
    }
    // Past the reserve but under the floor: the floor refused, and the note says by how much.
    for (const past of [ATTACH_REQUEST_MIN_MS - 1, 1_000, 500]) {
      const bound = attachBoundWithinRun(RUN_DEADLINE_RESERVE_MS + past);
      expect(bound.kind, `${past}`).toBe("exhausted");
      if (bound.kind === "exhausted") {
        expect(bound.note).toBe(
          `the run has ${Math.round((RUN_DEADLINE_RESERVE_MS + past) / 1000)}s of wall clock left, only ${Math.round(past / 1000)}s past the ${RUN_DEADLINE_RESERVE_MS / 1000}s write-up reserve — under the ${ATTACH_REQUEST_MIN_MS / 1000}s an attach needs — so no attach was opened`,
        );
      }
    }
  });
});
