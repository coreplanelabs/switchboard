import { describe, expect, it, vi } from "vitest";
import {
  SANDBOX_CREDENTIAL_ENV,
  SANDBOX_CREDENTIAL_FILE,
  SandboxCredentialRefreshError,
  SandboxCredentialRefresher,
  credentialLine,
  credentialWriteScript,
  isGitCredentialRefusal,
  isGitPushCommand,
} from "./sandboxCredentials.js";
import { CREDENTIAL_EXPIRY_MARGIN_MS } from "./residentCredentials.js";

// Feature: docs/reference/specs/execution.md item 5 — the sandbox half of the
// one credential refresher the execution layer owns (issue 1915): the
// executor lands the run's GitHub credential in a store file before the first
// exec and re-lands it when the token nears expiry, so a push late in the run
// never dies on the token the harness process inherited at its start.

const HOUR = 60 * 60_000;

describe("credentialWriteScript", () => {
  it("writes the file 0600 from the env variable — never a token in command text — and resets the global helper list to the store file", () => {
    const script = credentialWriteScript();
    expect(script).toContain(`umask 077 && printf '%s\\n' "$${SANDBOX_CREDENTIAL_ENV}" > ${SANDBOX_CREDENTIAL_FILE}`);
    // The empty entry drops the image's `!gh auth git-credential`, which would
    // otherwise answer first with the stale inherited token.
    expect(script).toContain("git config --global --replace-all credential.helper ''");
    expect(script).toContain(`git config --global --add credential.helper 'store --file=${SANDBOX_CREDENTIAL_FILE}'`);
    expect(script).not.toMatch(/ghs_|x-access-token:[^$]/);
  });

  it("the credential line is the store helper's shape", () => {
    expect(credentialLine("ghs_abc")).toBe("https://x-access-token:ghs_abc@github.com");
  });
});

describe("the credential-refusal and push recognizers", () => {
  it("recognizes GitHub's dead-token wording and git's 401 summary; an ordinary failure is not a refusal", () => {
    expect(isGitCredentialRefusal("remote: Invalid username or token. Password authentication is not supported")).toBe(
      true,
    );
    expect(isGitCredentialRefusal("fatal: Authentication failed for 'https://github.com/o/r.git/'")).toBe(true);
    expect(isGitCredentialRefusal("error: failed to push some refs (non-fast-forward)")).toBe(false);
    expect(isGitCredentialRefusal("")).toBe(false);
  });

  it("recognizes a git push however it is framed, and nothing else", () => {
    expect(isGitPushCommand("git push -u origin fix-x")).toBe(true);
    expect(isGitPushCommand("cd /workspace/checkout && git push origin HEAD")).toBe(true);
    expect(isGitPushCommand("git -C /workspace/checkout push")).toBe(true);
    expect(isGitPushCommand("git status && git push --force-with-lease")).toBe(true);
    expect(isGitPushCommand("git -c http.lowSpeedLimit=0 push origin HEAD")).toBe(true);
    expect(isGitPushCommand("git pull --rebase")).toBe(false);
    expect(isGitPushCommand("git fetch origin main")).toBe(false);
    expect(isGitPushCommand("grep push src/a.ts")).toBe(false);
    // A local subcommand's own `push` is not a remote write: never re-sent.
    expect(isGitPushCommand("git stash push -m wip")).toBe(false);
    expect(isGitPushCommand("git notes push")).toBe(false);
  });
});

describe("SandboxCredentialRefresher", () => {
  const cred = (token: string, expiresAtMs: number | null) => ({ token, expiresAtMs });

  it("plans a write before the first exec (nothing written yet) with the credential line on the env channel", async () => {
    let now = 1_000_000;
    const source = vi.fn(async () => cred("ghs_one", now + HOUR));
    const r = new SandboxCredentialRefresher(source, () => now);
    const write = await r.dueWrite();
    expect(write).not.toBeNull();
    expect(write?.env).toEqual({ [SANDBOX_CREDENTIAL_ENV]: credentialLine("ghs_one") });
    expect(write?.script).toBe(credentialWriteScript());
    write?.confirm();
    // Freshly written: the next exec plans nothing.
    now += 60_000;
    expect(await r.dueWrite()).toBeNull();
    expect(source).toHaveBeenCalledTimes(1);
  });

  it("an unconfirmed write — the write exec failed — is re-planned on the next exec, never believed fresh", async () => {
    const now = 1_000_000;
    const source = vi.fn(async () => cred("ghs_one", now + HOUR));
    const r = new SandboxCredentialRefresher(source, () => now);
    const first = await r.dueWrite();
    expect(first).not.toBeNull(); // planned, but never confirmed
    const second = await r.dueWrite();
    expect(second).not.toBeNull();
    second?.confirm();
    expect(await r.dueWrite()).toBeNull();
  });

  it("a refresher built with its own file path writes there", async () => {
    const r = new SandboxCredentialRefresher(
      async () => cred("ghs_one", 2_000_000 + HOUR),
      () => 2_000_000,
      "/home/user/.git-credentials",
    );
    const write = await r.dueWrite();
    expect(write?.script).toBe(credentialWriteScript("/home/user/.git-credentials"));
  });

  it("a token inside its expiry margin is refreshed before the exec; one outside it is not", async () => {
    let now = 1_000_000;
    const tokens = ["ghs_one", "ghs_two"];
    const source = vi.fn(async () => cred(tokens.shift() ?? "ghs_x", now + HOUR));
    const r = new SandboxCredentialRefresher(source, () => now);
    (await r.dueWrite())?.confirm();
    now += HOUR - CREDENTIAL_EXPIRY_MARGIN_MS - 60_000; // one minute outside the margin
    expect(await r.dueWrite()).toBeNull();
    now += 2 * 60_000; // now inside the margin
    const write = await r.dueWrite();
    expect(write?.env[SANDBOX_CREDENTIAL_ENV]).toBe(credentialLine("ghs_two"));
  });

  it("a run without a GitHub credential (source answers null) disables itself after one ask", async () => {
    const source = vi.fn(async () => null);
    const r = new SandboxCredentialRefresher(source, () => 1);
    expect(await r.dueWrite()).toBeNull();
    expect(await r.dueWrite()).toBeNull();
    expect(source).toHaveBeenCalledTimes(1);
  });

  it("a mint failure while the written token still lives is left for the next exec, never a throw", async () => {
    let now = 1_000_000;
    let fail = false;
    const source = vi.fn(async () => {
      if (fail) throw new Error("GitHub App token mint failed: HTTP 502");
      return cred("ghs_one", now + HOUR);
    });
    const r = new SandboxCredentialRefresher(source, () => now);
    (await r.dueWrite())?.confirm();
    fail = true;
    now += HOUR - 60_000; // inside the margin but before the expiry
    expect(await r.dueWrite()).toBeNull();
  });

  it("a mint failure the exec cannot outrun — nothing written, or the written token past its expiry — throws by name", async () => {
    let now = 1_000_000;
    const failing = vi.fn(async () => {
      throw new Error("GitHub App token mint failed: HTTP 502");
    });
    const first = new SandboxCredentialRefresher(failing, () => now);
    await expect(first.dueWrite()).rejects.toThrow(SandboxCredentialRefreshError);

    let fail = false;
    const source = vi.fn(async () => {
      if (fail) throw new Error("mint down");
      return cred("ghs_one", now + HOUR);
    });
    const r = new SandboxCredentialRefresher(source, () => now);
    (await r.dueWrite())?.confirm();
    fail = true;
    now += HOUR + 1; // the written token is dead
    await expect(r.dueWrite()).rejects.toThrow(/credential refresh failed/);
  });

  it("`fresh` plans a write even outside the margin, asking the source to skip its cache; its mint failure throws", async () => {
    const now = 1_000_000;
    const source = vi.fn(async (o?: { fresh?: boolean }) =>
      o?.fresh ? cred("ghs_fresh", now + HOUR) : cred("ghs_cached", now + HOUR),
    );
    const r = new SandboxCredentialRefresher(source, () => now);
    (await r.dueWrite())?.confirm();
    const write = await r.dueWrite({ fresh: true });
    expect(write?.env[SANDBOX_CREDENTIAL_ENV]).toBe(credentialLine("ghs_fresh"));
    expect(source).toHaveBeenLastCalledWith({ fresh: true });

    const failing = new SandboxCredentialRefresher(
      vi.fn(async () => {
        throw new Error("mint down");
      }),
      () => now,
    );
    await expect(failing.dueWrite({ fresh: true })).rejects.toThrow(SandboxCredentialRefreshError);
  });
});
