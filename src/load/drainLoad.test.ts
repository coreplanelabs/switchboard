import { describe, expect, it } from "vitest";
import { drainReceiptSummary } from "./drainLoad.js";

const finished = (events: Array<Record<string, unknown>>) => ({
  id: "run-1",
  status: "completed",
  finishedAt: 10_000,
  events,
});

describe("drainReceiptSummary", () => {
  it("reads typed waits and cold outcomes from finished records", () => {
    expect(
      drainReceiptSummary([
        finished([
          { type: "run_note", kind: "drain_wait", summary: "waited", durationMs: 12_000 },
          { type: "run_note", kind: "cold_sandbox", summary: "seeded", sandboxOutcome: "seeded" },
        ]),
        { ...finished([{ type: "run_note", kind: "cold_sandbox", summary: "fresh", sandboxOutcome: "fresh" }]), id: "run-2" },
      ]),
    ).toEqual({ runs: 2, waits: 1, waitDurationMs: 12_000, seeded: 1, fresh: 1 });
  });

  it.each([
    ["unfinished", { id: "r", status: "running", events: [] }],
    ["missing finish", { id: "r", status: "completed", events: [] }],
    ["legacy drain", finished([{ type: "run_note", kind: "drain_wait", summary: "waited 2 min" }])],
    ["legacy cold", finished([{ type: "run_note", kind: "cold_sandbox", summary: "using fresh sandbox" }])],
    ["malformed duration", finished([{ type: "run_note", kind: "drain_wait", durationMs: -1 }])],
  ])("fails closed on %s receipts", (_name, record) => {
    expect(() => drainReceiptSummary([record])).toThrow(/run/);
  });
});
