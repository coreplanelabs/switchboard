import { describe, expect, it } from "vitest";
import { describeInterruptedExec, isRuntimeInterruption } from "./runtimeInterruption.js";

// Feature: features/resident-repos.md item 21 (interrupted thread ops) /
// features/execution.md item 4 (session recovery on Sandbox 1.0). The resident
// Worker imports this module by relative path, so these tests exercise the exact
// classifier it ships (same pattern as shellQuote).

describe("isRuntimeInterruption", () => {
  it.each([
    // Cloudflare platform: the DO isolate was superseded by a deploy.
    "Durable Object reset because its code was updated.",
    "This script has been upgraded; the request must be retried",
    // Sandbox SDK 1.0 (@cloudflare/sandbox@next) runtime-identity fences.
    "Runtime identity is no longer active",
    "Sandbox lifetime is no longer current",
    "Sandbox operation exec was interrupted while the platform was updating the sandbox runtime",
    "Process handle proc_1 no longer identifies PID 4242",
    "Network connection lost.",
  ])("recognizes %j as a runtime interruption", (msg) => {
    expect(isRuntimeInterruption(new Error(msg))).toBe(true);
  });

  it("walks the error's cause chain (the SDK wraps platform errors)", () => {
    const err = new Error("RPC call failed", { cause: new Error("Durable Object reset because its code was updated.") });
    expect(isRuntimeInterruption(err)).toBe(true);
  });

  it.each([
    "exit 1: npm ERR! something broke",
    "not-attached: no binding for this threadKey — POST /attach first",
    "worktree-missing: the container disk was recycled since the last attach — POST /attach to recreate",
    "Command execution failed",
    "command timed out after 300000ms",
  ])("does NOT classify an ordinary failure %j as an interruption", (msg) => {
    expect(isRuntimeInterruption(new Error(msg))).toBe(false);
  });

  it("is false for non-error values without throwing", () => {
    expect(isRuntimeInterruption(undefined)).toBe(false);
    expect(isRuntimeInterruption(null)).toBe(false);
    expect(isRuntimeInterruption(42)).toBe(false);
    expect(isRuntimeInterruption("Runtime identity is no longer active")).toBe(true);
  });
});

describe("describeInterruptedExec", () => {
  it("names the cause, warns the command may have completed, and carries the SDK text", () => {
    const text = describeInterruptedExec(new Error("Runtime identity is no longer active"));
    expect(text).toMatch(/^interrupted: /);
    expect(text).toMatch(/replaced|redeploy/i);
    expect(text).toMatch(/may have (run|completed)/i);
    expect(text).toMatch(/not (been )?re-?run|not retried/i);
    expect(text).toContain("Runtime identity is no longer active");
  });
});
