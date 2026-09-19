import { describe, expect, it } from "vitest";
import { PACE_WINDOW_MS, boundText, paceText, stalledFor } from "./runPace.js";

// Feature: docs/reference/specs/live-view.md item 32 — the stall signal. A hung
// bash call and a slow suite must read apart: the index row and the status
// card carry the run's events per minute over the last five minutes (or "no
// tool call for N min"), and a call past its declared bound is named with the
// bound it outran. One pure rule here, shared by the card and the web row.

const MIN = 60_000;

describe("paceText", () => {
  it("says events per minute over the last five minutes while tool calls are recent", () => {
    // 14 events in the window, last tool call 9 s ago → 2.8/min.
    expect(paceText({ startedAt: 0, lastToolCallAt: 60 * MIN - 9_000, eventsLast5m: 14 }, 60 * MIN)).toBe("2.8/min");
    // A whole number drops the decimal.
    expect(paceText({ startedAt: 0, lastToolCallAt: 10 * MIN, eventsLast5m: 15 }, 10 * MIN)).toBe("3/min");
  });

  it("a run younger than the window rates over its own age, floored at a minute", () => {
    // 90 s old, 6 events → 6 / 1.5 min = 4/min; 30 s old, 6 events → floored at 1 min = 6/min.
    expect(paceText({ startedAt: 0, lastToolCallAt: 85_000, eventsLast5m: 6 }, 90_000)).toBe("4/min");
    expect(paceText({ startedAt: 0, lastToolCallAt: 25_000, eventsLast5m: 6 }, 30_000)).toBe("6/min");
  });

  it("says `no tool call for N min` once the last tool call is a window ago — the stall reads as a stall", () => {
    expect(paceText({ startedAt: 0, lastToolCallAt: 16 * MIN, eventsLast5m: 0 }, 60 * MIN)).toBe(
      "no tool call for 44 min",
    );
    // A run that never called a tool counts from its start.
    expect(paceText({ startedAt: 0, eventsLast5m: 0 }, 6 * MIN)).toBe("no tool call for 6 min");
  });

  it("says nothing for a row without the fact (an older writer, a persisted row)", () => {
    expect(paceText({ startedAt: 0 }, 60 * MIN)).toBe("");
  });
});

describe("stalledFor", () => {
  it("is the quiet stretch once no tool call landed for a window, and undefined before that", () => {
    expect(stalledFor({ startedAt: 0, lastToolCallAt: 16 * MIN, eventsLast5m: 0 }, 60 * MIN)).toBe(44 * MIN);
    expect(stalledFor({ startedAt: 0, lastToolCallAt: 59 * MIN, eventsLast5m: 2 }, 60 * MIN)).toBeUndefined();
    // Exactly at the window's edge counts as stalled.
    expect(stalledFor({ startedAt: 0, lastToolCallAt: 0, eventsLast5m: 0 }, PACE_WINDOW_MS)).toBe(PACE_WINDOW_MS);
  });

  it("never calls a row without the pace fact stalled — an older writer's row has no signal to misread", () => {
    expect(stalledFor({ startedAt: 0 }, 60 * MIN)).toBeUndefined();
  });
});

describe("boundText", () => {
  it("names the call and the bound it outran — `bash 2083s, bound 600s`", () => {
    expect(boundText({ tool: "bash", since: 0, boundMs: 600_000 }, 2_083_000)).toBe("bash 2083s, bound 600s");
  });

  it("is undefined while the call is inside its bound, and for a call that declared none", () => {
    expect(boundText({ tool: "bash", since: 0, boundMs: 600_000 }, 600_000)).toBeUndefined();
    expect(boundText({ tool: "bash", since: 0 }, 2_083_000)).toBeUndefined();
  });
});
