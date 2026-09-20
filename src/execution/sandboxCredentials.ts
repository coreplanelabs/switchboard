/** The per-thread sandbox's git credential, kept fresh by the EXECUTOR for the
 *  run's whole life — the sandbox half of the one credential refresher the
 *  execution layer owns (the resident half is the Worker's per-exec refresh,
 *  driven by the same pure decision in ./residentCredentials.ts).
 *
 *  Background: the sandbox's `GH_TOKEN` is a 1-hour GitHub App installation
 *  token, resolved per exec — but the harness process (pi) is started once and
 *  its bash children inherit the environment of that one start exec, so the
 *  token the run's own `git push` authenticated with was the one minted at
 *  attach and nothing ever refreshed it. A push past ~60 minutes answered
 *  `remote: Invalid username or token`, and nothing in the container could
 *  recover. The fix deletes that write-at-attach path as git's credential
 *  source: the executor lands the credential in a store FILE before the first
 *  exec and re-lands it whenever the token nears expiry (the executor's own
 *  execs — the harness polls the container through it every second — are the
 *  refresh cadence), and the write resets the global helper list so the
 *  inherited env token stops being what git asks for.
 *
 *  The decision is the resident's own (`shouldRefreshThreadCredentials`):
 *  refresh when nothing was written yet or the written token is within
 *  `CREDENTIAL_EXPIRY_MARGIN_MS` of its expiry, so an exec never starts on a
 *  token that cannot outlive it. */

import { shouldRefreshThreadCredentials } from "./residentCredentials.js";

/** Where the credential lands in the sandbox: beside `/workspace/checkout`,
 *  outside every repository, one file whatever the run checks out. The name is
 *  one the harness's tool gate already refuses the model access to. */
export const SANDBOX_CREDENTIAL_FILE = "/workspace/.git-credentials";

/** The variable the write script reads the credential line from — the exec
 *  env channel (execution.md item 5), so the token is never in command text. */
export const SANDBOX_CREDENTIAL_ENV = "SWITCHBOARD_GIT_CREDENTIAL";

/** One store-helper line, as git's `store` helper reads it. */
export function credentialLine(token: string): string {
  return `https://x-access-token:${token}@github.com`;
}

/** The exec that lands the credential: the file written 0600 from the env
 *  variable, then git's GLOBAL helper list reset (an empty entry drops the
 *  image's `!gh auth git-credential`, which would otherwise answer first with
 *  the stale token the harness process inherited at its start) and pointed at
 *  the file. Idempotent — a refresh re-runs it whole. */
export function credentialWriteScript(file: string = SANDBOX_CREDENTIAL_FILE): string {
  return [
    `umask 077 && printf '%s\\n' "$${SANDBOX_CREDENTIAL_ENV}" > ${file}`,
    `git config --global --replace-all credential.helper ''`,
    `git config --global --add credential.helper 'store --file=${file}'`,
  ].join(" && ");
}

/** GitHub's refusal of a dead or revoked token, as it reaches a git remote
 *  operation's output — the incident's exact wording, plus git's own summary
 *  line for an HTTP 401 against github.com. */
export function isGitCredentialRefusal(output: string): boolean {
  return /Invalid username or token|Authentication failed for 'https:\/\/github\.com/.test(output);
}

/** Whether a command runs `git push` — the one remote write whose re-send
 *  after a credential refresh is safe (a push is idempotent at the same tip).
 *  Anchored so only option tokens (`-C <dir>`, `-c k=v`, `--git-dir=…`) may sit
 *  between `git` and `push`: a local subcommand's own `push` (`git stash push`,
 *  `git notes … push`) is never a remote write and must not match. */
export function isGitPushCommand(command: string): boolean {
  return /(^|[\s;&|(`])git(\s+(?:-C|-c|--git-dir|--work-tree|--namespace|--exec-path)\s+[^\s;&|`\n]+|\s+-[^\s;&|`\n]*)*\s+push(\s|$)/.test(
    command,
  );
}

/** The credential as the executor's source answers it: the token and when it
 *  expires (null for a static PAT, which never does). */
export interface SandboxCredential {
  token: string;
  expiresAtMs: number | null;
}

/** Where a sandbox executor gets its credential: `resolveGithubCredential` in
 *  production (githubApp.ts), a stub in tests. `fresh` skips the mint cache —
 *  the 401-retry path's ask, where re-serving the refused token buys nothing.
 *  Answers null when the run holds no GitHub credential (then there is nothing
 *  to keep fresh, and the refresher disables itself). */
export type SandboxCredentialSource = (opts?: { fresh?: boolean }) => Promise<SandboxCredential | null>;

/** What the refresher asks the executor to run before the exec: the write
 *  script, with the credential line riding the env channel. `confirm` records
 *  the write on the refresher — called only after the write exec landed, so a
 *  failed write is re-planned on the next exec instead of believed. */
export interface CredentialWrite {
  script: string;
  env: Record<string, string>;
  confirm: () => void;
}

/** A due refresh that could not mint: the run cannot push from here on, so the
 *  executor ends it legibly (the post-step reports the branch state — the
 *  unpushed commits named) instead of letting the model retry into a wall. */
export class SandboxCredentialRefreshError extends Error {
  constructor(cause: string) {
    super(`sandbox git credential refresh failed — pushes cannot authenticate until it succeeds: ${cause}`);
    this.name = "SandboxCredentialRefreshError";
  }
}

/** One refresher per executor: remembers what it last wrote and when it
 *  expires, and answers, before each exec, the write to run first — or null
 *  when the written token still comfortably outlives the exec. */
export class SandboxCredentialRefresher {
  private written: { atMs: number; expiresAtMs: number | null } | null = null;
  /** The run holds no GitHub credential (the source answered null once): never ask again. */
  private disabled = false;

  constructor(
    private readonly source: SandboxCredentialSource,
    private readonly nowMs: () => number,
    /** where the store file lands in this executor's container */
    private readonly file: string = SANDBOX_CREDENTIAL_FILE,
  ) {}

  /** The write due before the next exec, minting when the resident's decision
   *  says so (or unconditionally under `fresh` — the 401-retry path). Throws
   *  `SandboxCredentialRefreshError` when a mint the exec NEEDS fails: a fresh
   *  ask, a first write, or a written token already past its expiry; a mint
   *  failure while the written token still lives is left for the next exec. */
  async dueWrite(opts?: { fresh?: boolean }): Promise<CredentialWrite | null> {
    if (this.disabled) return null;
    const now = this.nowMs();
    if (!opts?.fresh) {
      const decision = shouldRefreshThreadCredentials({
        writtenAtMs: this.written?.atMs ?? null,
        tokenExpiresAtMs: this.written?.expiresAtMs ?? null,
        nowMs: now,
        // The executor cannot stat the container's file; what it wrote stands
        // in. `missing` on the first exec lands the file before anything runs.
        fileBytes: this.written === null ? null : 1,
        readonly: false,
      });
      if (!decision.refresh) return null;
    }
    let credential: SandboxCredential | null;
    try {
      credential = await this.source(opts?.fresh ? { fresh: true } : undefined);
    } catch (err) {
      const written = this.written;
      const stillLives =
        !opts?.fresh && written !== null && (written.expiresAtMs === null || now < written.expiresAtMs);
      // Inside the margin but before the expiry: the written token can still
      // carry this exec; the next exec asks again.
      if (stillLives) return null;
      throw new SandboxCredentialRefreshError(err instanceof Error ? err.message : String(err));
    }
    if (credential === null) {
      this.disabled = true;
      return null;
    }
    const planned = { atMs: now, expiresAtMs: credential.expiresAtMs };
    return {
      script: credentialWriteScript(this.file),
      env: { [SANDBOX_CREDENTIAL_ENV]: credentialLine(credential.token) },
      confirm: () => {
        this.written = planned;
      },
    };
  }
}
