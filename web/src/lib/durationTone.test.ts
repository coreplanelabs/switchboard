import { describe, expect, it } from "vitest";
import { durationTone, heatStyle, heatT, isTimedOutExit } from "./durationTone";

// The duration heat scale (features/live-view.md item 24): quiet below the
// floor, a monotonic amber→red ramp to the ceiling, and a categorical
// over-budget state that no duration can reach on its own.

describe("durationTone", () => {
  it("a quick shell call inherits its colour: under the 2 s floor is level 0 with no colour", () => {
    expect(durationTone(180, "tool")).toEqual({ level: 0, over: false, t: 0 });
    expect(durationTone(2_000, "tool").level).toBe(0);
    expect(durationTone(undefined, "tool")).toEqual({ level: 0, over: false, t: 0 });
  });

  it("heat is monotonic in duration and saturates at the kind's ceiling", () => {
    const ts = [3_000, 30_000, 120_000, 300_000, 20 * 60_000, 60 * 60_000].map((ms) => heatT(ms, "tool"));
    for (let i = 1; i < ts.length; i++) expect(ts[i]).toBeGreaterThanOrEqual(ts[i - 1]);
    expect(heatT(20 * 60_000, "tool")).toBe(1);
    expect(heatT(60 * 60_000, "tool")).toBe(1);
  });

  it("the friction analyzer's thresholds land on the ramp, not below it: a 30 s tool call and a 60 s turn are warm", () => {
    expect(durationTone(30_000, "tool").level).toBeGreaterThanOrEqual(1);
    expect(durationTone(60_000, "turn").level).toBeGreaterThanOrEqual(1);
    expect(durationTone(10_000, "turn").level).toBe(0);
  });

  it("the three commands that ate the 2026-09-07 run read hot: 3m 34s and 2m 38s are level 2+, 15 min is level 3", () => {
    expect(durationTone(214_375, "tool").level).toBeGreaterThanOrEqual(2);
    expect(durationTone(158_472, "tool").level).toBeGreaterThanOrEqual(2);
    expect(durationTone(15 * 60_000, "tool").level).toBe(3);
  });

  it("the paint is one scalar: heatStyle hands the DOM `--heat-t` on the ramp (levels 1–3) and nothing when quiet or over budget", () => {
    expect(heatStyle(durationTone(180, "tool"))).toBeUndefined();
    expect(heatStyle(durationTone(30_000, "tool"))).toEqual({ "--heat-t": heatT(30_000, "tool").toFixed(3) });
    expect(heatStyle(durationTone(20 * 60_000, "tool"))).toEqual({ "--heat-t": "1.000" });
    expect(heatStyle(durationTone(1_200, "tool", true))).toBeUndefined();
  });

  it("over budget is categorical: a timed-out command is level 4 with no ramp colour, whatever its duration", () => {
    expect(durationTone(1_200, "tool", true)).toEqual({ level: 4, over: true, t: 1 });
    expect(durationTone(15 * 60_000, "tool", false).over).toBe(false);
  });

  it("isTimedOutExit recognises the runtime's deadline exit 124 only — a SIGKILL 137 (OOM, kill -9) is not a timeout", () => {
    expect(isTimedOutExit(124)).toBe(true);
    expect(isTimedOutExit(137)).toBe(false);
    expect(isTimedOutExit(1)).toBe(false);
    expect(isTimedOutExit(0)).toBe(false);
    expect(isTimedOutExit(undefined)).toBe(false);
  });

  it("a whole run is scaled to the coding wall clock: 5 min is warm, 45 min is at the ceiling", () => {
    expect(durationTone(5 * 60_000, "run").level).toBeGreaterThanOrEqual(1);
    expect(durationTone(45 * 60_000, "run").t).toBe(1);
    expect(durationTone(30_000, "run").level).toBe(0);
  });
});
