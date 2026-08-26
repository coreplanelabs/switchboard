import { execFile } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import type { OperationResult, Operations, OpName } from "../core/operations.js";

// The Executor is the seam between agents and where their commands actually
// run. Tools never touch the filesystem or spawn processes directly — they
// call an Executor, which is either the local host (dev/CLI) or a remote
// per-thread sandbox (production).

export interface Executor {
  /** Run a shell command; returns combined output (never throws on non-zero exit). */
  exec(command: string): Promise<string>;
  /** Read a file, path relative to the execution workspace. */
  readFile(path: string): Promise<string>;
  /** Write a file (creating parent dirs), path relative to the workspace. */
  writeFile(path: string, content: string): Promise<string>;
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

  async exec(command: string): Promise<string> {
    const r = await runBash(command, this.workspaceDir);
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
 *  signal-killed) and message — each caller formats its own result. */
function runBash(
  command: string,
  cwd: string,
): Promise<{ stdout: string; stderr: string; error: { code?: number | string; message: string } | null }> {
  return new Promise((res) => {
    execFile(
      "bash",
      ["-c", command],
      { cwd, timeout: BASH_TIMEOUT_MS, maxBuffer: 10 * 1024 * 1024 },
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
