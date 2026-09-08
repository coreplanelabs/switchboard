import { describe, expect, it } from "vitest";
import type { RunEvent } from "./runEvents.js";
import { QUIET_SUFFIX_AFTER_MS, inFlightToolAfter, quietSuffix } from "./statusCardLabel.js";

// Feature: features/run-visibility.md item 2 — the live card's title suffix
// tells model time from tool time. 2026-09-07 (#531): a `pnpm typecheck` in
// flight for an hour was rendered as `thinking (3601s since last tool)`; the
// last event WAS a tool call, so the card claimed the model was thinking while
// the run was waiting on the sandbox.

describe("quietSuffix", () => {
  it("is empty inside the first 20 s, with or without a tool in flight", () => {
    expect(quietSuffix(QUIET_SUFFIX_AFTER_MS)).toBe("");
    expect(quietSuffix(QUIET_SUFFIX_AFTER_MS, "bash")).toBe("");
    expect(quietSuffix(0)).toBe("");
  });

  it("no tool in flight past 20 s → the model is thinking, timed from the last tool", () => {
    expect(quietSuffix(88_000)).toBe(" — thinking (88s since last tool)");
  });

  it("a tool in flight past 20 s → `running <tool> (Ns)`, never `thinking`", () => {
    expect(quietSuffix(3_601_000, "bash")).toBe(" — running bash (3601s)");
    expect(quietSuffix(25_400, "read_file")).toBe(" — running read_file (25s)");
  });
});

describe("inFlightToolAfter", () => {
  const call = (tool: string): RunEvent => ({ type: "tool_call", tool, summary: `${tool} …` });
  const result = (tool: string): RunEvent => ({ type: "tool_result", tool, ok: true, summary: "ok" });

  it("a tool_call opens the in-flight tool, its tool_result closes it", () => {
    const open = inFlightToolAfter(undefined, call("bash"));
    expect(open).toBe("bash");
    expect(inFlightToolAfter(open, result("bash"))).toBeUndefined();
  });

  it("other events leave the in-flight tool as it was", () => {
    const note: RunEvent = { type: "run_note", kind: "wrap_up", summary: "wrapping up" };
    expect(inFlightToolAfter("bash", note)).toBe("bash");
    expect(inFlightToolAfter(undefined, note)).toBeUndefined();
    const text: RunEvent = { type: "assistant", text: "Let me look." };
    expect(inFlightToolAfter("bash", text)).toBe("bash");
  });
});
