import { execFile } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import type { OperationResult, Operations, OpName } from "../core/operations.js";

// The Executor is the seam between agents and where their commands actually
// run. Tools never touch the filesystem or spawn processes directly — they
// call an Executor, which is either the local host (dev/CLI) or a remote
// per-thread sandbox (production).

export interface Executor {
  /** Run a shell command; returns combined output (never throws on non-zero
   *  exit). `opts.signal` is a hard run stop (#101): an implementation that can
   *  cancel the underlying command does so and returns/throws promptly; one that
   *  cannot simply ignores it — the runner stops waiting on it either way. */
  exec(command: string, opts?: ExecOptions): Promise<string>;
  /** Read a file, path relative to the execution workspace. */
  readFile(path: string): Promise<string>;
  /** Write a file (creating parent dirs), path relative to the workspace. */
  writeFile(path: string, content: string): Promise<string>;
  /** Optional: give back whatever the run held for this thread once it ends
   *  (a resident's pool user + worktree). "always" — nothing to preserve
   *  (read-only agents); "if-clean" — keep the workspace if it has uncommitted
   *  or unpushed work. Best-effort: implementations report, never throw. */
  release?(mode: ReleaseMode): Promise<ReleaseResult>;
}

export interface ExecOptions {
  /** Aborted when the run is hard-stopped; cancel the command if you can. */
  signal?: AbortSignal;
}

/** The per-call deadline for a remote route, joined with an optional hard-stop
 *  signal (#101): whichever fires first aborts the fetch. */
export function execDeadline(timeoutMs: number, signal?: AbortSignal): AbortSignal {
  const timeout = AbortSignal.timeout(timeoutMs);
  return signal ? AbortSignal.any([timeout, signal]) : timeout;
}

export type ReleaseMode = "always" | "if-clean";
export interface ReleaseResult {
  released: boolean;
  /** Why the workspace was kept (or why release failed) — for the log line. */
  reason?: string;
}

/** An exec-INFRASTRUCTURE failure: the sandbox/exec transport itself failed —
 *  unreachable, an HTTP error, an in-body worker error (the sandbox's
 *  "Command execution failed" / exitCode 127 signal), or a worktree that stays
 *  unrecoverable after re-attach. This is categorically different from a normal
 *  nonzero command exit, which every Executor returns as ordinary output text
 *  and NEVER as a throw. Remote executors throw this (not a bare `Error`) for
 *  infra failures so the runner can tell a wedged sandbox from a command the
 *  agent should keep handling, and fail fast instead of toiling commands into a
 *  dead sandbox (#92). Extends `Error`, so `err.message`/`instanceof Error`
 *  callers are unaffected. */
export class ExecInfraError extends Error {
  readonly infra = true as const;
  constructor(message: string) {
    super(message);
    this.name = "ExecInfraError";
  }
}

/** Decorates an Executor to track CONSECUTIVE exec-infrastructure failures
 *  (`ExecInfraError`) with no successful operation between them — the signal the
 *  runner uses to detect an unrecoverable sandbox (#92). A successful op resets
 *  the count to 0 (proves the sandbox is alive, so a one-off blip never aborts);
 *  an `ExecInfraError` increments it; any OTHER throw (e.g. a path-escape
 *  rejection, a missing file) is neither a health signal nor a reset and leaves
 *  the count untouched. A normal nonzero exit returns output (no throw), so it
 *  too resets the count and can never trip the abort. */
export class ExecHealthTracker implements Executor {
  consecutiveInfraFailures = 0;
  /** Message of the most recent `ExecInfraError` in the current streak — the
   *  evidence the runner's abort diagnosis quotes instead of guessing a cause.
   *  Cleared by a successful op along with the count. */
  lastInfraError: string | undefined;

  constructor(private readonly inner: Executor) {}

  private async track<T>(op: () => Promise<T>): Promise<T> {
    try {
      const out = await op();
      this.consecutiveInfraFailures = 0;
      this.lastInfraError = undefined;
      return out;
    } catch (err) {
      if (err instanceof ExecInfraError) {
        this.consecutiveInfraFailures++;
        this.lastInfraError = err.message;
      }
      throw err;
    }
  }

  exec(command: string, opts?: ExecOptions): Promise<string> {
    return this.track(() => this.inner.exec(command, opts));
  }

  readFile(path: string): Promise<string> {
    return this.track(() => this.inner.readFile(path));
  }

  writeFile(path: string, content: string): Promise<string> {
    return this.track(() => this.inner.writeFile(path, content));
  }
}

export const BASH_TIMEOUT_MS = 5 * 60_000;
const MAX_OUTPUT = 120_000;

export function truncate(s: string): string {
  return s.length > MAX_OUTPUT
    ? s.slice(0, MAX_OUTPUT) + `\n...[truncated ${s.length - MAX_OUTPUT} chars]`
    : s;
}

/** Runs everything on the local host inside a confined workspace directory. */
export class LocalExecutor implements Executor {
  constructor(private workspaceDir: string) {}

  private confine(p: string): string {
    const abs = resolve(this.workspaceDir, p);
    if (abs !== this.workspaceDir && !abs.startsWith(this.workspaceDir + "/")) {
      throw new Error(`Path escapes workspace: ${p}`);
    }
    return abs;
  }

  async exec(command: string, opts?: ExecOptions): Promise<string> {
    const r = await runBash(command, this.workspaceDir, opts?.signal);
    const parts = [r.stdout, r.stderr].filter(Boolean).join("\n--- stderr ---\n");
    if (r.error) {
      return truncate(`exit ${r.error.code ?? "error"}: ${r.error.message}\n${parts}`);
    }
    return truncate(parts || "(no output)");
  }

  async readFile(path: string): Promise<string> {
    return truncate(readFileSync(this.confine(path), "utf8"));
  }

  async writeFile(path: string, content: string): Promise<string> {
    const abs = this.confine(path);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, content);
    return `Wrote ${path}`;
  }
}

/** Dev-only deterministic ops against the thread's LOCAL workspace directory
 *  (U6, KTD8) — the second Operations implementation (≥2-implementations
 *  invariant) and the CLI-testable one. Honest about its limits: there is no
 *  onboard-time command table and no refs locally, so ops run fixed Node
 *  conventions (test → `npm test`, build → `npm run build --if-present`,
 *  status → workspace existence) against the workspace AS IT STANDS, and a
 *  requested ref is reported as ignored rather than silently dropped. A
 *  failing command is a RESULT (ok:false), never an error path. */
export class LocalOperations implements Operations {
  constructor(private workspaceDir: string) {}

  async run(op: OpName, req: { repo: string; ref?: string }): Promise<OperationResult> {
    const refNote = req.ref ? ` — ref \`${req.ref}\` ignored (local mode has no refs)` : "";
    // Local mode has no onboard-time repo binding, so "for <repo>" is a claim
    // about intent, not a verified checkout — disclose that the workspace was
    // not verified to hold req.repo, mirroring the ref-not-verified note.
    const repoNote = ` — workspace not verified to hold ${req.repo} (local mode)`;
    const exists = existsSync(this.workspaceDir);
    if (op === "status") {
      return {
        kind: "result",
        ok: exists,
        summary: exists
          ? `status: local workspace for ${req.repo} exists at ${this.workspaceDir} (dev-only — no resident lifecycle locally)${repoNote}`
          : `status: no local workspace at ${this.workspaceDir} yet (dev-only — no resident lifecycle locally)`,
      };
    }
    if (!exists) {
      return {
        kind: "result",
        ok: false,
        summary: `${op} failed: no local workspace at ${this.workspaceDir} — nothing checked out yet${refNote}`,
      };
    }
    const command = op === "test" ? "npm test" : "npm run build --if-present";
    const r = await runLocalCommand(command, this.workspaceDir);
    return {
      kind: "result",
      ok: r.exitCode === 0,
      summary:
        `${op} (\`${command}\`) ${r.exitCode === 0 ? "passed" : `failed (exit ${r.exitCode})`} ` +
        `in the local workspace for ${req.repo}${repoNote}${refNote}`,
      ...(r.output ? { output: truncate(r.output) } : {}),
    };
  }
}

async function runLocalCommand(command: string, cwd: string): Promise<{ exitCode: number; output: string }> {
  const r = await runBash(command, cwd);
  const output = [r.stdout, r.stderr].filter(Boolean).join("\n--- stderr ---\n");
  const code = r.error ? (r.error.code ?? 1) : 0;
  return { exitCode: typeof code === "number" ? code : 1, output };
}

/** Shared bash spawn-and-collect (`bash -c` under the standard budget and
 *  buffer). `error` is null on a clean zero-exit run; otherwise it carries
 *  execFile's raw code (number exit code, string errno, or undefined when
 *  signal-killed) and message — each caller formats its own result. An
 *  optional AbortSignal (hard run stop, #101) kills the child; that surfaces as
 *  an `error` like any other abnormal exit — never a throw. */
function runBash(
  command: string,
  cwd: string,
  signal?: AbortSignal,
): Promise<{ stdout: string; stderr: string; error: { code?: number | string; message: string } | null }> {
  return new Promise((res) => {
    execFile(
      "bash",
      ["-c", command],
      { cwd, timeout: BASH_TIMEOUT_MS, maxBuffer: 10 * 1024 * 1024, ...(signal ? { signal } : {}) },
      (err, stdout, stderr) => {
        res({
          stdout,
          stderr,
          error: err
            ? { code: (err as NodeJS.ErrnoException & { code?: number | string }).code, message: err.message }
            : null,
        });
      },
    );
  });
}
