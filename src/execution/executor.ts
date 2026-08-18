import { execFile } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

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
const MAX_OUTPUT = 30_000;

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

  exec(command: string): Promise<string> {
    return new Promise((res) => {
      execFile(
        "bash",
        ["-c", command],
        { cwd: this.workspaceDir, timeout: BASH_TIMEOUT_MS, maxBuffer: 10 * 1024 * 1024 },
        (err, stdout, stderr) => {
          const parts = [stdout, stderr].filter(Boolean).join("\n--- stderr ---\n");
          if (err) {
            const code = (err as NodeJS.ErrnoException & { code?: number }).code ?? "error";
            res(truncate(`exit ${code}: ${err.message}\n${parts}`));
          } else {
            res(truncate(parts || "(no output)"));
          }
        },
      );
    });
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
