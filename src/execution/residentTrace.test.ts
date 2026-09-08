// Feature: docs/reference/specs/tracing.md item 19 — the resident's steps are rebuilt from
// an allowlist and grafted under the calling span, rebased and clipped; nothing
// a resident sends can widen, rename or word a span.
import { describe, expect, it } from "vitest";
import { createTracer } from "../core/trace/tracer.js";
import { recordingSink } from "../core/testing/recordingSink.js";
import { graftResidentSteps, residentTraceOf, sanitizeGraftedSteps, withResidentTrace } from "./residentTrace.js";

describe("sanitizeGraftedSteps", () => {
  it("rebuilds each step from the allowlist and drops what is not a step: malformed numbers, hostile names, error text, an out-of-range exit code", () => {
    const steps = sanitizeGraftedSteps([
      { name: "clone", startMs: 5_000, durationMs: 30_000, status: "ok", exitCode: 0, error: "ghp_secret leaked" },
      { name: "<script>alert(1)</script>", startMs: 35_000.6, durationMs: -5, status: "weird", exitCode: 999 },
      { name: "mutex_wait", startMs: 0, durationMs: 4_000, status: "ok", waitedMs: 4_000 },
      { name: "install", startMs: "soon", durationMs: 10 },
      "not an object",
      null,
      { name: "build", startMs: 40_000, durationMs: Number.NaN },
      { name: "test", startMs: 41_000, durationMs: 1_000, status: "error", exitCode: 1, timedOut: true },
    ]);
    expect(steps).toEqual([
      { name: "clone", startMs: 5_000, durationMs: 30_000, status: "ok", exitCode: 0 },
      { name: "script-alert-1-script", startMs: 35_001, durationMs: 0, status: "ok" },
      { name: "mutex_wait", startMs: 0, durationMs: 4_000, status: "ok", waitedMs: 4_000 },
      { name: "test", startMs: 41_000, durationMs: 1_000, status: "error", exitCode: 1, timedOut: true },
    ]);
    expect(JSON.stringify(steps)).not.toContain("secret");
  });

  it("is bounded like the Worker's collector and tolerates a non-array", () => {
    expect(sanitizeGraftedSteps("nope")).toEqual([]);
    expect(sanitizeGraftedSteps(undefined)).toEqual([]);
    const many = Array.from({ length: 200 }, (_, i) => ({ name: `s${i}`, startMs: i, durationMs: 1 }));
    const steps = sanitizeGraftedSteps(many);
    expect(steps.length).toBeLessThanOrEqual(64);
    expect(steps.at(-1)!.name).toBe("s199");
  });
});

describe("graftResidentSteps", () => {
  it("grafts each step under the parent as <prefix>.<name>, rebased to the parent's start, clipped to now, with backend/exit/timeout/wait attrs and an infra classification on a failed step; the parent learns the clock skew", () => {
    const log = recordingSink();
    const root = createTracer({ clock: () => 100_000 }).start("request", { sinks: [log] });
    const attach = root.start("dispatch.workspace.attach", { startedAt: 10_000 });
    const grafted = graftResidentSteps(
      [
        { name: "mutex_wait", startMs: 0, durationMs: 2_000, status: "ok", waitedMs: 2_000 },
        { name: "clone", startMs: 2_000, durationMs: 30_000, status: "ok", exitCode: 0 },
        { name: "install", startMs: 32_000, durationMs: 120_000, status: "error", exitCode: 1, timedOut: true }, // runs past now
        { name: "late", startMs: 500_000, durationMs: 1_000, status: "ok" }, // starts after now
      ],
      { parent: attach, prefix: "dispatch.workspace.attach", baseAt: 10_000, clipAt: 100_000, residentTotalMs: 85_000 },
    );
    expect(grafted).toBe(4);
    expect(
      log.ends.map((e) => [e.name, e.startedAt, e.endedAt, e.status, e.attrs, e.errorKind, e.parentSpanId]),
    ).toEqual([
      [
        "dispatch.workspace.attach.mutex_wait",
        10_000,
        12_000,
        "ok",
        { backend: "resident", waitedMs: 2_000 },
        undefined,
        attach.id,
      ],
      [
        "dispatch.workspace.attach.clone",
        12_000,
        42_000,
        "ok",
        { backend: "resident", exitCode: 0 },
        undefined,
        attach.id,
      ],
      [
        "dispatch.workspace.attach.install",
        42_000,
        100_000,
        "error",
        { backend: "resident", exitCode: 1, timedOut: true },
        "infra",
        attach.id,
      ],
      ["dispatch.workspace.attach.late", 100_000, 100_000, "ok", { backend: "resident" }, undefined, attach.id],
    ]);
    expect(log.ends.every((e) => e.errorMessage === undefined)).toBe(true);
    expect(attach.record().attrs).toEqual({ clockSkewMs: 5_000 }); // 90 s seen by the bot, 85 s measured by the resident
  });

  it("an empty trace grafts nothing and leaves the parent alone", () => {
    const log = recordingSink();
    const root = createTracer({ clock: () => 5_000 }).start("request", { sinks: [log] });
    const cmd = root.start("run.command");
    expect(graftResidentSteps([], { parent: cmd, prefix: "run.command", baseAt: 5_000, clipAt: 5_000 })).toBe(0);
    expect(log.ends).toEqual([]);
    expect(cmd.record().attrs).toEqual({});
  });
});

describe("withResidentTrace / residentTraceOf", () => {
  it("pins a trace on an error and finds it through a chain of causes, never on an unrelated error", () => {
    const inner = withResidentTrace(new Error("attach failed"), {
      steps: [{ name: "clone", startMs: 0, durationMs: 10, status: "error", exitCode: 128 }],
    });
    const wrapped = new Error("resident attach: refused its own default ref", { cause: inner });
    expect(residentTraceOf(inner)?.steps).toHaveLength(1);
    expect(residentTraceOf(wrapped)?.steps[0]?.name).toBe("clone");
    expect(residentTraceOf(new Error("other"))).toBeUndefined();
    expect(residentTraceOf("a string")).toBeUndefined();
    expect(residentTraceOf(undefined)).toBeUndefined();
  });
});
