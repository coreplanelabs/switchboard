// Feature: features/tracing.md — one duration formatter, three styles.
import { describe, expect, it } from "vitest";
import { formatDuration } from "./formatDuration.js";

describe("formatDuration", () => {
  it("precise: a single measured step", () => {
    expect(formatDuration(800, "precise")).toBe("800ms");
    expect(formatDuration(1300, "precise")).toBe("1.3s");
    expect(formatDuration(59_949, "precise")).toBe("59.9s");
    // rounding carries into the next unit instead of printing 60.0s or 1m 60s
    expect(formatDuration(59_950, "precise")).toBe("1m 00s");
    expect(formatDuration(119_500, "precise")).toBe("2m 00s");
    expect(formatDuration(119_499, "precise")).toBe("1m 59s");
    expect(formatDuration(304_000, "precise")).toBe("5m 04s");
    expect(formatDuration(-5, "precise")).toBe("0ms");
  });

  it("clock: a ticking stopwatch reading with a fixed column width", () => {
    expect(formatDuration(0, "clock")).toBe("0s");
    expect(formatDuration(38_400, "clock")).toBe("38s");
    expect(formatDuration(252_000, "clock")).toBe("4m 12s");
    expect(formatDuration(3_780_000, "clock")).toBe("1h 03m");
    expect(formatDuration(Number.NaN, "clock")).toBe("0s");
    expect(formatDuration(-1, "clock")).toBe("0s");
    expect(formatDuration(undefined, "clock")).toBe("");
  });

  it("report: a compact total, with hours", () => {
    expect(formatDuration(850, "report")).toBe("850ms");
    expect(formatDuration(45_000, "report")).toBe("45s");
    expect(formatDuration(78_000, "report")).toBe("1m 18s");
    expect(formatDuration(3_900_000, "report")).toBe("1h 05m");
  });
});
