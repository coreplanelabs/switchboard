import { describe, expect, it } from "vitest";
import type { RunEvent } from "./runEvents.js";
import { QUIET_SUFFIX_AFTER_MS, inFlightCallAfter, quietSuffix } from "./statusCardLabel.js";

// Feature: docs/reference/specs/run-visibility.md item 2 — the live card's title suffix
// tells model time from tool time. A `pnpm typecheck` in flight for an hour
// must never render as `thinking (3601s since last tool)`: when the last event
// WAS a tool call, the run is waiting on the sandbox, not on the model.

describe("quietSuffix", () => {
  it("is empty inside the first 20 s, with or without a tool in flight", () => {
    expect(quietSuffix(QUIET_SUFFIX_AFTER_MS)).toBe("");
    expect(quietSuffix(QUIET_SUFFIX_AFTER_MS, { tool: "bash" })).toBe("");
    expect(quietSuffix(0)).toBe("");
  });

  it("no tool in flight past 20 s → the model is thinking, timed from the last tool", () => {
    expect(quietSuffix(88_000)).toBe(" — thinking (88s since last tool)");
  });

  it("a tool in flight past 20 s → `running <tool> (Ns)`, never `thinking`", () => {
    expect(quietSuffix(3_601_000, { tool: "bash" })).toBe(" — running bash (3601s)");
    expect(quietSuffix(25_400, { tool: "read_file" })).toBe(" — running read_file (25s)");
  });

  // Feature: docs/reference/specs/live-view.md item 32 (issue #1836) — a bash
  // call past its declared bound is marked, never shown as ordinary progress:
  // the bound that should have ended it is named beside the elapsed.
  it("a call past its declared bound is marked with the bound it outran — `bash 2083s, bound 600s`", () => {
    expect(quietSuffix(2_083_000, { tool: "bash", boundMs: 600_000 })).toBe(" — bash 2083s, bound 600s");
  });

  it("a call inside its bound still reads as running — the bound is a mark, not a caption", () => {
    expect(quietSuffix(599_000, { tool: "bash", boundMs: 600_000 })).toBe(" — running bash (599s)");
  });
});

describe("inFlightCallAfter", () => {
  const call = (tool: string, boundMs?: number): RunEvent => ({
    type: "tool_call",
    tool,
    summary: `${tool} …`,
    ...(boundMs !== undefined ? { boundMs } : {}),
  });
  const result = (tool: string): RunEvent => ({ type: "tool_result", tool, ok: true, summary: "ok" });

  it("a tool_call opens the in-flight call — its declared bound carried — and its tool_result closes it", () => {
    const open = inFlightCallAfter(undefined, call("bash", 600_000));
    expect(open).toEqual({ tool: "bash", boundMs: 600_000 });
    expect(inFlightCallAfter(open, result("bash"))).toBeUndefined();
    expect(inFlightCallAfter(undefined, call("read"))).toEqual({ tool: "read" });
  });

  it("other events leave the in-flight call as it was", () => {
    const note: RunEvent = { type: "run_note", kind: "wrap_up", summary: "wrapping up" };
    expect(inFlightCallAfter({ tool: "bash" }, note)).toEqual({ tool: "bash" });
    expect(inFlightCallAfter(undefined, note)).toBeUndefined();
    const text: RunEvent = { type: "assistant", text: "Let me look." };
    expect(inFlightCallAfter({ tool: "bash" }, text)).toEqual({ tool: "bash" });
  });
});
