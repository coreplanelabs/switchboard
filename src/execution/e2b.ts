import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, posix } from "node:path";
import { Sandbox } from "e2b";
import { bashTimeoutNote, clampBashTimeout } from "./bashTimeout.js";
import {
  ExecInfraError,
  truncate,
  type ExecOptions,
  type Executor,
  type ReleaseMode,
  type ReleaseResult,
} from "./executor.js";
import {
  SandboxCredentialRefresher,
  SandboxCredentialRefreshError,
  isGitCredentialRefusal,
  isGitPushCommand,
  type SandboxCredentialSource,
} from "./sandboxCredentials.js";
import { SANDBOX_CREDENTIAL_WRITE_TIMEOUT_MS } from "../core/budgets.js";
import { systemClock } from "../core/trace/clock.js";

// Remote execution in an E2B micro-VM. One sandbox per thread: the repo
// checkout and GH_TOKEN live inside the sandbox, never on the bot host.
// threadKey -> sandboxId is persisted so follow-ups in a thread reconnect to
// the same sandbox; if it has expired we create a fresh one (repos re-clone —
// same graceful degradation as losing the local workspace dir).

const WORKDIR = "/home/user/workspace";

/** Where the credential store file lands in the micro-VM: beside the
 *  workspace, outside every repository — the e2b twin of the sandbox's
 *  `/workspace/.git-credentials` (sandboxCredentials.ts). */
export const E2B_CREDENTIAL_FILE = "/home/user/.git-credentials";

// The shared agent-trailer hook (deploy/hooks/prepare-commit-msg): the E2B
// sandbox has no image build to COPY it in, so setup writes this copy — held
// byte-identical to the canonical file by a test — and points core.hooksPath
// at it, the same wiring as the images'.
export const PREPARE_COMMIT_MSG_HOOK = `#!/bin/sh
# The agent trailer (docs/reference/specs/execution.md): every commit made in a
# Switchboard image carries \`Co-Authored-By: <bot pair>\`, so the agent's hand
# stays visible even when the author is the requester. The pair is read from
# GIT_COMMITTER_NAME/GIT_COMMITTER_EMAIL at commit time — the bot fills them
# per exec — so the image stays installation-agnostic; without them the
# image's own git identity stands (its fallback address is off the GitHub
# domain, so it never renders as a GitHub account). Idempotent: a message that
# already carries this exact trailer is left unchanged; a foreign
# Co-Authored-By does not stop it (the identity rewrite scrubs those).
set -e
msg="$1"
name="\${GIT_COMMITTER_NAME:-$(git config user.name || true)}"
email="\${GIT_COMMITTER_EMAIL:-$(git config user.email || true)}"
[ -n "$name" ] && [ -n "$email" ] || exit 0
git interpret-trailers --in-place --if-exists addIfDifferent \\
  --trailer "Co-Authored-By: $name <$email>" "$msg"
`;

const HOOKS_DIR = "/home/user/.switchboard-hooks";

// Best-effort per-sandbox setup: gh CLI + git identity + credential helper +
// the agent-trailer hook. GH_TOKEN is provided via sandbox env, so `gh` and
// (through the credential helper) `git` are authenticated without the token
// ever appearing on disk. The fallback user.email stays OFF the GitHub domain
// (a noreply-shaped address would render as a GitHub account it is not); the
// real pairs ride the per-command env. The global core.hooksPath replaces
// repo-local .git/hooks entirely — deliberate: an untrusted checkout's own
// hooks never run here (a repo-local core.hooksPath still wins) —
// docs/reference/specs/execution.md item 5.
const SETUP = [
  `mkdir -p ${WORKDIR}`,
  `command -v gh >/dev/null 2>&1 || (curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg | sudo dd of=/usr/share/keyrings/githubcli-archive-keyring.gpg && echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" | sudo tee /etc/apt/sources.list.d/github-cli.list >/dev/null && sudo apt-get update -qq && sudo apt-get install -y -qq gh)`,
  `git config --global credential.helper '!gh auth git-credential' || true`,
  `git config --global user.name "switchboard-bot" || true`,
  `git config --global user.email "switchboard-bot@switchboard.invalid" || true`,
  `mkdir -p ${HOOKS_DIR}`,
  `printf '%s' '${Buffer.from(PREPARE_COMMIT_MSG_HOOK).toString("base64")}' | base64 -d > ${HOOKS_DIR}/prepare-commit-msg`,
  `chmod +x ${HOOKS_DIR}/prepare-commit-msg`,
  `git config --global core.hooksPath ${HOOKS_DIR} || true`,
].join(" && ");

export interface E2BOptions {
  apiKey?: string;
  threadKey: string;
  /** sandbox idle lifetime; each request extends it */
  timeoutMs: number;
  /** JSON file persisting threadKey -> sandboxId */
  statePath: string;
  /** Env vars for the sandbox (e.g. GH_TOKEN), resolved on EVERY command: the
   *  micro-VM's creation-time env would otherwise carry the token minted for
   *  the thread's first command for the sandbox's whole (reusable) life. */
  resolveEnvs: () => Promise<Record<string, string>>;
  /** The run's GitHub credential with its expiry, for the executor-side
   *  per-exec credential-file refresh (src/execution/sandboxCredentials.ts —
   *  the same refresher the Cloudflare sandbox executor runs, so a pi child's
   *  push late in the run never dies on the token inherited at its start);
   *  absent for a run that holds none. */
  credential?: SandboxCredentialSource;
  /** resident repo/ref context — reserved for resident environments (not yet used) */
  repo?: string;
  ref?: string;
}

export class E2BExecutor implements Executor {
  /** The one refresher for this executor's thread (null without a source). */
  private refresher: SandboxCredentialRefresher | null = null;

  private constructor(
    private sbx: Sandbox,
    private resolveEnvs: () => Promise<Record<string, string>>,
    private credential?: SandboxCredentialSource,
  ) {}

  static async open(opts: E2BOptions): Promise<E2BExecutor> {
    const state = readState(opts.statePath);
    const existing = state[opts.threadKey];

    if (existing) {
      try {
        const sbx = await Sandbox.connect(existing, { apiKey: opts.apiKey });
        await sbx.setTimeout(opts.timeoutMs);
        return new E2BExecutor(sbx, opts.resolveEnvs, opts.credential);
      } catch {
        // expired or gone — fall through and create a fresh one
        delete state[opts.threadKey];
      }
    }

    const sbx = await Sandbox.create({
      apiKey: opts.apiKey,
      timeoutMs: opts.timeoutMs,
      envs: await opts.resolveEnvs(),
    });
    await sbx.commands.run(SETUP, { timeoutMs: 3 * 60_000 }).catch(() => {
      // gh install is best-effort; agents report failures via tool output
    });
    state[opts.threadKey] = sbx.sandboxId;
    writeState(opts.statePath, state);
    return new E2BExecutor(sbx, opts.resolveEnvs, opts.credential);
  }

  /** Land the credential file in the micro-VM when the refresher says a write
   *  is due (before every exec; `fresh` on the 401-retry path) — the same
   *  contract as the Cloudflare sandbox executor's (sandboxCredentials.ts):
   *  the credential line rides the write's own `envs`, never command text; the
   *  write's global-helper reset displaces the setup's `!gh auth
   *  git-credential`, so git stops answering with the token pi's children
   *  inherited at their one start; a due refresh that cannot mint (or land)
   *  ends the run `ExecInfraError`/`refused` for the post-step's report. */
  private async refreshCredential(opts?: { fresh?: boolean }): Promise<boolean> {
    const source = this.credential;
    if (source === undefined) return false;
    this.refresher ??= new SandboxCredentialRefresher(source, systemClock, E2B_CREDENTIAL_FILE);
    let write;
    try {
      write = await this.refresher.dueWrite(opts?.fresh ? { fresh: true } : undefined);
    } catch (err) {
      if (err instanceof SandboxCredentialRefreshError) throw new ExecInfraError(err.message, "refused");
      throw err;
    }
    if (write === null) return false;
    // The write is its own command — never through exec(), which would
    // re-enter this refresh. The SDK throws on a non-zero exit.
    try {
      await this.sbx.commands.run(write.script, { timeoutMs: SANDBOX_CREDENTIAL_WRITE_TIMEOUT_MS, envs: write.env });
    } catch (err) {
      const e = err as { stderr?: string; message?: string };
      throw new ExecInfraError(
        `sandbox git credential write failed: ${String(e.stderr ?? e.message ?? err).slice(0, 200)}`,
        "refused",
      );
    }
    // Recorded only now: a failed write is re-planned on the next exec.
    write.confirm();
    return true;
  }

  /** The e2b command API takes no AbortSignal, so a hard run stop
   *  degrades safely here: the runner stops waiting on this call, and the
   *  dispatcher's `release("always")` then kills the whole sandbox below.
   *  `opts.timeoutMs` (the bash tool's per-call budget, re-clamped here) IS
   *  honored — it maps onto the SDK's own command timeout. */
  async exec(command: string, opts?: ExecOptions): Promise<string> {
    // The credential file first, when the token it holds nears expiry — so this
    // exec (and the harness children that outlive the env they inherited) never
    // runs against a dying token (execution.md item 5).
    await this.refreshCredential();
    let out = await this.run(command, opts);
    // A push the remote refused for its credential is a credential fault, not
    // the command's: ONE fresh mint + rewrite, ONE re-send (a push is
    // idempotent at the same tip) — never a backoff loop.
    if (isGitPushCommand(command) && isGitCredentialRefusal(out)) {
      const rewrote = await this.refreshCredential({ fresh: true });
      if (rewrote) out = await this.run(command, opts);
    }
    return truncate(out);
  }

  private async run(command: string, opts?: ExecOptions): Promise<string> {
    const timeoutMs = clampBashTimeout(opts?.timeoutMs);
    const envs = await this.resolveEnvs();
    const result = await this.sbx.commands.run(command, { cwd: WORKDIR, timeoutMs, envs }).catch((err: unknown) => {
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
      return `exit ${result.exitCode}:\n${parts}`;
    }
    return parts || "(no output)";
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
   *  the thread creates a fresh sandbox (repos re-clone). "if-idle" keeps the
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
