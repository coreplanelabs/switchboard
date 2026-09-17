import { describe, expect, it } from "vitest";
import { RunControl } from "./runControl.js";

// Feature: docs/reference/specs/live-view.md — the per-run stop control the
// registry mints at `create()` and the runner polls: soft records, hard aborts,
// escalation only ever goes one way.

describe("RunControl", () => {
  it("starts unrequested with a live hard signal", () => {
    const c = new RunControl();
    expect(c.requested).toBeUndefined();
    expect(c.hardSignal.aborted).toBe(false);
  });

  it("soft: records the mode, does NOT abort the hard signal", () => {
    const c = new RunControl();
    expect(c.requestStop("soft")).toBe("soft");
    expect(c.requested).toBe("soft");
    expect(c.hardSignal.aborted).toBe(false);
  });

  it("hard: records the mode AND aborts the hard signal", () => {
    const c = new RunControl();
    expect(c.requestStop("hard")).toBe("hard");
    expect(c.requested).toBe("hard");
    expect(c.hardSignal.aborted).toBe(true);
  });

  it("carries the run's lease clock once the harness starts it: undefined before, the clock's reading after, restarted on a resume (execution.md item 9)", () => {
    const c = new RunControl();
    expect(c.remainingMs()).toBeUndefined();
    let left = 90_000;
    c.startLease(() => left);
    expect(c.remainingMs()).toBe(90_000);
    left = 30_000;
    expect(c.remainingMs()).toBe(30_000);
    c.startLease(() => 20 * 60_000);
    expect(c.remainingMs()).toBe(20 * 60_000);
  });

  it("escalates soft → hard, never de-escalates hard → soft; repeats are idempotent", () => {
    const c = new RunControl();
    c.requestStop("soft");
    expect(c.requestStop("hard")).toBe("hard");
    expect(c.requested).toBe("hard");
    expect(c.requestStop("soft")).toBe("hard"); // stays hard
    expect(c.requested).toBe("hard");
    expect(c.requestStop("hard")).toBe("hard");
  });
});
