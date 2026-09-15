import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LocalExecutor, execDeadline, LocalOperations } from "./executor.js";

// Feature: docs/reference/specs/resident-repos.md — LocalOperations: the dev-only
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

// Feature: docs/reference/specs/harness-pi.md item 6 — a hard stop's AbortSignal kills
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

// Feature: docs/reference/specs/harness-pi.md item 4 — a caller's extra
// environment for one command (`ExecOptions.env`): the pi harness hands the run
// bearer to the pi process this way, never on a command line. Locally the
// child gets the PUBLIC environment plus the caller's variables — a command
// that carries an env of its own never inherits the host's secrets.
describe("LocalExecutor exec env", () => {
  it("the child sees the caller's variables beside the public environment, and never a secret of the host", async () => {
    const dir = mkdtempSync(join(tmpdir(), "sb-local-env-"));
    const ex = new LocalExecutor(dir);
    process.env.SWB_TEST_SECRET_PROBE = "must-not-leak";
    process.env.ANTHROPIC_API_KEY = "sk-must-not-leak";
    try {
      const out = await ex.exec(
        'echo "probe=$SWB_PROBE path=${PATH:+set} key=${ANTHROPIC_API_KEY:-unset} plain=$SWB_TEST_SECRET_PROBE"',
        {
          env: { SWB_PROBE: "hi" },
        },
      );
      expect(out.trim()).toBe("probe=hi path=set key=unset plain=must-not-leak");
    } finally {
      delete process.env.SWB_TEST_SECRET_PROBE;
      delete process.env.ANTHROPIC_API_KEY;
    }
  });
  it("without an env the command inherits the process environment exactly as before", async () => {
    const dir = mkdtempSync(join(tmpdir(), "sb-local-env-"));
    process.env.SWB_TEST_INHERIT_PROBE = "inherited";
    try {
      expect((await new LocalExecutor(dir).exec("echo $SWB_TEST_INHERIT_PROBE")).trim()).toBe("inherited");
    } finally {
      delete process.env.SWB_TEST_INHERIT_PROBE;
    }
  });
});

// Feature: docs/reference/specs/execution.md item 11 — per-call bash timeout. The local
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

// Feature: docs/reference/specs/execution.md item 11 — the per-call deadline every remote
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
