import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ExecCapacityError,
  ExecHealthTracker,
  ExecInfraError,
  LocalExecutor,
  execDeadline,
  LocalOperations,
  type Executor,
} from "./executor.js";

// Feature: features/resident-repos.md — LocalOperations: the dev-only
// second Operations implementation (≥2-implementations invariant).
// No command table and no refs locally — fixed Node conventions run in the
// thread's local workspace dir, and a requested ref is honestly reported as
// ignored. A failing command is a RESULT (ok:false), never an error path.

function workspace(pkg: Record<string, unknown>): string {
  const dir = mkdtempSync(join(tmpdir(), "swb-localops-"));
  writeFileSync(join(dir, "package.json"), JSON.stringify(pkg));
  return dir;
}

describe("LocalOperations", () => {
  it("status reports a missing workspace as ok:false (dev-only, no resident lifecycle)", async () => {
    const ops = new LocalOperations(join(tmpdir(), "swb-localops-nonexistent"));
    const res = await ops.run("status", { repo: "acme/api" });
    expect(res).toMatchObject({ kind: "result", ok: false });
    if (res.kind === "result") expect(res.summary).toMatch(/no local workspace/i);
  });

  it("status reports an existing workspace as ok:true", async () => {
    const dir = workspace({ name: "x", version: "0.0.0" });
    const res = await ops(dir).run("status", { repo: "acme/api" });
    expect(res).toMatchObject({ kind: "result", ok: true });
  });

  it("test runs `npm test` and a passing run is ok:true", async () => {
    const dir = workspace({ name: "x", version: "0.0.0", scripts: { test: "node -e \"console.log('local-ok')\"" } });
    const res = await ops(dir).run("test", { repo: "acme/api" });
    expect(res).toMatchObject({ kind: "result", ok: true });
    if (res.kind === "result") {
      expect(res.summary).toMatch(/test .*passed/i);
      expect(res.output).toContain("local-ok");
    }
  });

  it("a failing test run is a RESULT with a named failure, not an error", async () => {
    const dir = workspace({ name: "x", version: "0.0.0", scripts: { test: 'node -e "process.exit(1)"' } });
    const res = await ops(dir).run("test", { repo: "acme/api" });
    expect(res).toMatchObject({ kind: "result", ok: false });
    if (res.kind === "result") expect(res.summary).toMatch(/failed/i);
  });

  it("build uses --if-present so a script-less package still passes", async () => {
    const dir = workspace({ name: "x", version: "0.0.0" });
    const res = await ops(dir).run("build", { repo: "acme/api" });
    expect(res).toMatchObject({ kind: "result", ok: true });
  });

  it("a requested ref is honestly reported as ignored (local mode has no refs)", async () => {
    const dir = workspace({ name: "x", version: "0.0.0", scripts: { test: 'node -e "0"' } });
    const res = await ops(dir).run("test", { repo: "acme/api", ref: "main" });
    if (res.kind === "result") expect(res.summary).toMatch(/ref .*ignored/i);
  });

  // Local mode has no onboard-time repo binding, so "for <repo>" is an intent
  // claim, not a verified checkout — the summary must disclose the workspace
  // was not verified to hold req.repo (mirrors the ref-not-verified note).
  it("a run against an existing workspace discloses it was not verified to hold the repo (local mode)", async () => {
    const dir = workspace({ name: "x", version: "0.0.0", scripts: { test: 'node -e "0"' } });
    const res = await ops(dir).run("test", { repo: "acme/api" });
    if (res.kind === "result") expect(res.summary).toMatch(/workspace not verified to hold acme\/api \(local mode\)/);
  });

  it("status on an existing workspace also discloses it was not verified to hold the repo", async () => {
    const dir = workspace({ name: "x", version: "0.0.0" });
    const res = await ops(dir).run("status", { repo: "acme/api" });
    expect(res).toMatchObject({ kind: "result", ok: true });
    if (res.kind === "result") expect(res.summary).toMatch(/workspace not verified to hold acme\/api \(local mode\)/);
  });
});

function ops(dir: string): LocalOperations {
  return new LocalOperations(dir);
}

// Distinguishing an exec-infrastructure failure (a dead/wedged sandbox)
// from a normal nonzero command exit, and counting consecutive ones so the
// runner can fail fast instead of toiling into a dead sandbox.
describe("ExecHealthTracker", () => {
  function scripted(fn: () => Promise<string>): Executor {
    return { exec: fn, readFile: fn, writeFile: async () => fn() };
  }

  it("counts consecutive ExecInfraError throws", async () => {
    const t = new ExecHealthTracker(
      scripted(async () => {
        throw new ExecInfraError("boom");
      }),
    );
    await expect(t.exec("x")).rejects.toBeInstanceOf(ExecInfraError);
    expect(t.consecutiveInfraFailures).toBe(1);
    await expect(t.exec("x")).rejects.toBeInstanceOf(ExecInfraError);
    expect(t.consecutiveInfraFailures).toBe(2);
  });

  it("resets the count on any successful op", async () => {
    let calls = 0;
    const t = new ExecHealthTracker(
      scripted(async () => {
        calls++;
        if (calls === 1) throw new ExecInfraError("boom");
        return "ok";
      }),
    );
    await expect(t.exec("x")).rejects.toBeInstanceOf(ExecInfraError);
    expect(t.consecutiveInfraFailures).toBe(1);
    await t.exec("x");
    expect(t.consecutiveInfraFailures).toBe(0);
  });

  it("leaves the count untouched on a non-infra throw (not a health signal, not a reset)", async () => {
    let calls = 0;
    const t = new ExecHealthTracker(
      scripted(async () => {
        calls++;
        if (calls === 1) throw new ExecInfraError("boom");
        throw new Error("Path escapes workspace"); // an ordinary tool error
      }),
    );
    await expect(t.exec("x")).rejects.toBeInstanceOf(ExecInfraError);
    expect(t.consecutiveInfraFailures).toBe(1);
    await expect(t.exec("x")).rejects.toThrow("Path escapes workspace");
    expect(t.consecutiveInfraFailures).toBe(1); // unchanged
  });

  // Feature: features/execution.md item 14 — a full fleet is capacity, not a
  // dead sandbox: ExecCapacityError is deliberately NOT an ExecInfraError, so
  // it must neither count toward fail-fast nor reset a real streak.
  it("leaves the count untouched on ExecCapacityError (a full fleet is not a dead sandbox)", async () => {
    let calls = 0;
    const t = new ExecHealthTracker(
      scripted(async () => {
        calls++;
        if (calls === 1) throw new ExecInfraError("boom");
        throw new ExecCapacityError("sandbox fleet busy — no free per-thread sandbox after waiting 300s");
      }),
    );
    await expect(t.exec("x")).rejects.toBeInstanceOf(ExecInfraError);
    expect(t.consecutiveInfraFailures).toBe(1);
    await expect(t.exec("x")).rejects.toBeInstanceOf(ExecCapacityError);
    await expect(t.exec("x")).rejects.toBeInstanceOf(ExecCapacityError);
    expect(t.consecutiveInfraFailures).toBe(1); // unchanged: neither counted nor reset
    expect(t.lastInfraError).toBe("boom");
  });

  it("remembers the LAST infra error's text (for a truthful abort diagnosis) and forgets it on success", async () => {
    let calls = 0;
    const t = new ExecHealthTracker(
      scripted(async () => {
        calls++;
        if (calls === 1) throw new ExecInfraError("first: transport reset");
        if (calls === 2) throw new ExecInfraError("second: Process handle refers to a previous runtime incarnation");
        return "ok";
      }),
    );
    expect(t.lastInfraError).toBeUndefined();
    await expect(t.exec("x")).rejects.toBeInstanceOf(ExecInfraError);
    expect(t.lastInfraError).toBe("first: transport reset");
    await expect(t.exec("x")).rejects.toBeInstanceOf(ExecInfraError);
    expect(t.lastInfraError).toBe("second: Process handle refers to a previous runtime incarnation");
    await t.exec("x");
    expect(t.lastInfraError).toBeUndefined();
  });

  it("a normal nonzero exit (returned as output, no throw) resets the count", async () => {
    let calls = 0;
    const t = new ExecHealthTracker(
      scripted(async () => {
        calls++;
        if (calls === 1) throw new ExecInfraError("boom");
        return "exit 1:\nnpm ERR!"; // a normal command failure is output, not a throw
      }),
    );
    await expect(t.exec("x")).rejects.toBeInstanceOf(ExecInfraError);
    expect(t.consecutiveInfraFailures).toBe(1);
    expect(await t.exec("x")).toContain("exit 1");
    expect(t.consecutiveInfraFailures).toBe(0);
  });

  it("forwards the exec abort signal to the inner executor (hard stop reaches the sandbox)", async () => {
    let seen: AbortSignal | undefined;
    const inner: Executor = {
      exec: async (_c, opts) => {
        seen = opts?.signal;
        return "ok";
      },
      readFile: async () => "",
      writeFile: async () => "",
    };
    const ctl = new AbortController();
    await new ExecHealthTracker(inner).exec("x", { signal: ctl.signal });
    expect(seen).toBe(ctl.signal);
  });
});

// Feature: features/run-loop.md item 8 — a hard stop's AbortSignal kills
// the local child process instead of waiting out its 5-minute budget.
describe("LocalExecutor exec abort", () => {
  it("kills a running command when the signal aborts and returns an exit line, never throws", async () => {
    const dir = mkdtempSync(join(tmpdir(), "sb-local-abort-"));
    const ex = new LocalExecutor(dir);
    const ctl = new AbortController();
    const started = Date.now();
    const out = ex.exec("sleep 30", { signal: ctl.signal });
    setTimeout(() => ctl.abort(), 50);
    const text = await out;
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(text).toMatch(/^exit /); // aborted → legible failure text, not a throw
  });
});

// Feature: features/execution.md item 11 — per-call bash timeout. The local
// executor honors ExecOptions.timeoutMs (execFile's `timeout`, maxBuffer kept)
// and a deadline kill renders as exit 124 NAMING the limit that fired and the
// timeoutMs knob, so the model can self-correct instead of seeing a bare abort.
describe("LocalExecutor per-call timeout", () => {
  it("kills the command at the requested timeout and names the limit + the timeoutMs knob", async () => {
    const dir = mkdtempSync(join(tmpdir(), "sb-local-timeout-"));
    const ex = new LocalExecutor(dir);
    const started = Date.now();
    const text = await ex.exec("sleep 30", { timeoutMs: 1_000 });
    expect(Date.now() - started).toBeLessThan(10_000);
    expect(text).toMatch(/^exit 124: /);
    expect(text).toContain("1s command timeout");
    expect(text).toContain("timeoutMs");
    expect(text).toContain("1200000"); // the ceiling, so the model knows the max
  });

  it("clamps a sub-floor timeoutMs up to 1s instead of killing instantly", async () => {
    const dir = mkdtempSync(join(tmpdir(), "sb-local-timeout-"));
    const ex = new LocalExecutor(dir);
    const started = Date.now();
    const text = await ex.exec("sleep 30", { timeoutMs: 0 });
    expect(Date.now() - started).toBeGreaterThanOrEqual(900);
    expect(text).toMatch(/^exit 124: /);
  });

  it("a command that finishes inside its timeout returns output as before", async () => {
    const dir = mkdtempSync(join(tmpdir(), "sb-local-timeout-"));
    const ex = new LocalExecutor(dir);
    await expect(ex.exec("echo fast", { timeoutMs: 60_000 })).resolves.toBe("fast\n");
  });

  it("a nonzero exit inside the timeout is still an ordinary exit line, never the 124 wording", async () => {
    const dir = mkdtempSync(join(tmpdir(), "sb-local-timeout-"));
    const ex = new LocalExecutor(dir);
    const text = await ex.exec("exit 3", { timeoutMs: 60_000 });
    expect(text).toMatch(/^exit 3/);
    expect(text).not.toContain("command timeout");
  });
});

// Feature: features/execution.md item 11 — the per-call deadline every remote
// executor joins with the hard-stop signal. Built on a plain timer, not
// `AbortSignal.timeout`: Node runs that one on an internal timer that neither
// fake timers nor a test can observe, so a deadline built on it could never be
// proven to fire (the sandbox executor's deadline is asserted with fake
// timers in cloudflareSandbox.test.ts).
describe("execDeadline", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("fires exactly at timeoutMs with a TimeoutError reason", async () => {
    const s = execDeadline(10_000);
    await vi.advanceTimersByTimeAsync(9_999);
    expect(s.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(s.aborted).toBe(true);
    expect((s.reason as Error).name).toBe("TimeoutError");
  });

  it("joins the hard-stop signal: a stop before the deadline aborts the joined signal at once with the stop's reason", async () => {
    const ac = new AbortController();
    const s = execDeadline(10_000, ac.signal);
    await vi.advanceTimersByTimeAsync(1_000);
    ac.abort(new Error("stopped by the operator"));
    expect(s.aborted).toBe(true);
    expect((s.reason as Error).message).toBe("stopped by the operator");
    await vi.advanceTimersByTimeAsync(20_000); // the timer must not throw or re-abort later
    expect((s.reason as Error).message).toBe("stopped by the operator");
  });
});
