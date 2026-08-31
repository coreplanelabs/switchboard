import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, posix } from "node:path";
import { Sandbox } from "e2b";
import { bashTimeoutNote, clampBashTimeout } from "./bashTimeout.js";
import { truncate, type ExecOptions, type Executor, type ReleaseMode, type ReleaseResult } from "./executor.js";

// Remote execution in an E2B micro-VM. One sandbox per thread: the repo
// checkout and GH_TOKEN live inside the sandbox, never on the bot host.
// threadKey -> sandboxId is persisted so follow-ups in a thread reconnect to
// the same sandbox; if it has expired we create a fresh one (repos re-clone —
// same graceful degradation as losing the local workspace dir).

const WORKDIR = "/home/user/workspace";

// Best-effort per-sandbox setup: gh CLI + git identity + credential helper.
// GH_TOKEN is provided via sandbox env, so `gh` and (through the credential
// helper) `git` are authenticated without the token ever appearing on disk.
const SETUP = [
  `mkdir -p ${WORKDIR}`,
  `command -v gh >/dev/null 2>&1 || (curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg | sudo dd of=/usr/share/keyrings/githubcli-archive-keyring.gpg && echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" | sudo tee /etc/apt/sources.list.d/github-cli.list >/dev/null && sudo apt-get update -qq && sudo apt-get install -y -qq gh)`,
  `git config --global credential.helper '!gh auth git-credential' || true`,
  `git config --global user.name "switchboard-bot" || true`,
  `git config --global user.email "switchboard-bot@users.noreply.github.com" || true`,
].join(" && ");

export interface E2BOptions {
  apiKey?: string;
  threadKey: string;
  /** sandbox idle lifetime; each request extends it */
  timeoutMs: number;
  /** JSON file persisting threadKey -> sandboxId */
  statePath: string;
  /** env vars injected into the sandbox (e.g. GH_TOKEN) */
  envs: Record<string, string>;
  /** resident repo/ref context — reserved for resident environments (not yet used) */
  repo?: string;
  ref?: string;
}

export class E2BExecutor implements Executor {
  private constructor(private sbx: Sandbox) {}

  static async open(opts: E2BOptions): Promise<E2BExecutor> {
    const state = readState(opts.statePath);
    const existing = state[opts.threadKey];

    if (existing) {
      try {
        const sbx = await Sandbox.connect(existing, { apiKey: opts.apiKey });
        await sbx.setTimeout(opts.timeoutMs);
        return new E2BExecutor(sbx);
      } catch {
        // expired or gone — fall through and create a fresh one
        delete state[opts.threadKey];
      }
    }

    const sbx = await Sandbox.create({
      apiKey: opts.apiKey,
      timeoutMs: opts.timeoutMs,
      envs: opts.envs,
    });
    await sbx.commands.run(SETUP, { timeoutMs: 3 * 60_000 }).catch(() => {
      // gh install is best-effort; agents report failures via tool output
    });
    state[opts.threadKey] = sbx.sandboxId;
    writeState(opts.statePath, state);
    return new E2BExecutor(sbx);
  }

  /** The e2b command API takes no AbortSignal, so a hard run stop (#101)
   *  degrades safely here: the runner stops waiting on this call, and the
   *  dispatcher's `release("always")` then kills the whole sandbox below.
   *  `opts.timeoutMs` (the bash tool's per-call budget, re-clamped here) IS
   *  honored — it maps onto the SDK's own command timeout. */
  async exec(command: string, opts?: ExecOptions): Promise<string> {
    const timeoutMs = clampBashTimeout(opts?.timeoutMs);
    const result = await this.sbx.commands
      .run(command, { cwd: WORKDIR, timeoutMs })
      .catch((err: unknown) => {
        const e = err as { name?: string; exitCode?: number; stdout?: string; stderr?: string; message?: string };
        // The SDK's deadline kill throws TimeoutError with no exit code —
        // render it as exit 124 naming the limit that fired, so the model can
        // self-correct instead of reading a generic failure.
        // Exactly the SDK's TimeoutError — a message-regex fallback would also
        // catch CONNECTION timeouts and mislabel them as the command deadline.
        if (e.exitCode === undefined && e.name === "TimeoutError") {
          return { exitCode: 124, stdout: e.stdout ?? "", stderr: bashTimeoutNote(timeoutMs) };
        }
        // e2b throws on non-zero exit; surface it as output like LocalExecutor
        return {
          exitCode: e.exitCode ?? 1,
          stdout: e.stdout ?? "",
          stderr: e.stderr ?? e.message ?? String(err),
        };
      });
    const parts = [result.stdout, result.stderr].filter(Boolean).join("\n--- stderr ---\n");
    if (result.exitCode !== 0) {
      return truncate(`exit ${result.exitCode}:\n${parts}`);
    }
    return truncate(parts || "(no output)");
  }

  async readFile(path: string): Promise<string> {
    return truncate(await this.sbx.files.read(confine(path)));
  }

  async writeFile(path: string, content: string): Promise<string> {
    await this.sbx.files.write(confine(path), content);
    return `Wrote ${path}`;
  }

  /** "always" (a read-only run, or a hard stop) kills the micro-VM outright —
   *  the only way to end a command e2b's API can't cancel; the next request in
   *  the thread creates a fresh sandbox (repos re-clone). "if-clean" keeps the
   *  sandbox: its idle timeout is the existing reclaim path. Never throws. */
  async release(mode: ReleaseMode): Promise<ReleaseResult> {
    if (mode !== "always") return { released: false, reason: "kept for the thread (idle timeout reclaims it)" };
    try {
      await this.sbx.kill();
      return { released: true };
    } catch (err) {
      return { released: false, reason: err instanceof Error ? err.message : String(err) };
    }
  }
}

function confine(p: string): string {
  const abs = posix.resolve(WORKDIR, p);
  if (abs !== WORKDIR && !abs.startsWith(WORKDIR + "/")) {
    throw new Error(`Path escapes workspace: ${p}`);
  }
  return abs;
}

function readState(path: string): Record<string, string> {
  if (!existsSync(path)) return {};
  try {
    return JSON.parse(readFileSync(path, "utf8")) as Record<string, string>;
  } catch {
    return {};
  }
}

function writeState(path: string, state: Record<string, string>): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(state, null, 2));
}
