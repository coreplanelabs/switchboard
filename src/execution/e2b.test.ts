import { describe, expect, it, vi } from "vitest";
import { E2BExecutor, E2B_CREDENTIAL_FILE } from "./e2b.js";
import {
  SANDBOX_CREDENTIAL_ENV,
  credentialLine,
  credentialWriteScript,
  type SandboxCredentialSource,
} from "./sandboxCredentials.js";

// Feature: docs/reference/specs/execution.md item 11 — per-call bash timeout on the E2B
// path: ExecOptions.timeoutMs (already clamped by the tool layer, re-clamped
// here defensively) is passed to the SDK's commands.run, and the SDK's
// TimeoutError renders as exit 124 naming the limit and the timeoutMs knob.
// The SDK constructor is private and network-bound, so the executor is built
// on its prototype with a stubbed `sbx` — the same seam the class itself uses.

type RunFn = (
  cmd: string,
  opts: { cwd: string; timeoutMs: number },
) => Promise<{ stdout: string; stderr: string; exitCode: number }>;

function e2bWith(
  run: RunFn,
  resolveEnvs: () => Promise<Record<string, string>> = async () => ({}),
  credential?: SandboxCredentialSource,
): { ex: E2BExecutor; run: ReturnType<typeof vi.fn> } {
  const spy = vi.fn(run);
  const ex = Object.create(E2BExecutor.prototype) as E2BExecutor;
  (ex as unknown as { sbx: unknown }).sbx = { commands: { run: spy } };
  (ex as unknown as { resolveEnvs: unknown }).resolveEnvs = resolveEnvs;
  (ex as unknown as { credential: unknown }).credential = credential;
  return { ex, run: spy };
}

const OK = { stdout: "ok", stderr: "", exitCode: 0 };

// Feature: docs/reference/specs/execution.md item 5 — the credential is resolved per
// command on this path too: the micro-VM's creation-time env would otherwise
// carry the token minted for the thread's FIRST command forever.
describe("E2BExecutor credential freshness", () => {
  it("each command carries the envs resolved at its start", async () => {
    let token = "ghs_first";
    const { ex, run } = e2bWith(
      async () => OK,
      async () => ({ GH_TOKEN: token }),
    );
    await ex.exec("gh pr view 1");
    token = "ghs_second";
    await ex.exec("gh pr diff 1");
    expect(run.mock.calls[0][1]).toMatchObject({ envs: { GH_TOKEN: "ghs_first" } });
    expect(run.mock.calls[1][1]).toMatchObject({ envs: { GH_TOKEN: "ghs_second" } });
  });

  // Feature: docs/reference/specs/execution.md item 5 — the commit identity
  // (record 0062) rides the same shared resolver: the four variables reach
  // the SDK's per-command env option beside the credential.
  it("the four commit identity variables reach each command's envs beside the credential", async () => {
    const FOUR = {
      GIT_AUTHOR_NAME: "ivy-dev",
      GIT_AUTHOR_EMAIL: "4242+ivy-dev@users.noreply.github.com",
      GIT_COMMITTER_NAME: "switchboard-app[bot]",
      GIT_COMMITTER_EMAIL: "111+switchboard-app[bot]@users.noreply.github.com",
    };
    const { ex, run } = e2bWith(
      async () => OK,
      async () => ({ GH_TOKEN: "ghs_write", ...FOUR }),
    );
    await ex.exec("git commit -m x");
    expect(run.mock.calls[0][1]).toMatchObject({ envs: { GH_TOKEN: "ghs_write", ...FOUR } });
  });
});

// Feature: docs/reference/specs/execution.md item 5 — the e2b half of the
// executor-side credential-file refresh (issue 1915): pi's bash children
// inherit the env of pi's one start exec on this backend too, so the store
// file is what keeps a late push authenticated, exactly as on the Cloudflare
// sandbox path.
describe("E2BExecutor credential file refresh", () => {
  const HOUR = 60 * 60_000;

  it("lands the store file at the e2b path before the first exec, the credential line riding the write's own envs — never command text", async () => {
    const { ex, run } = e2bWith(
      async () => OK,
      async () => ({ GH_TOKEN: "ghs_x" }),
      async () => ({ token: "ghs_x", expiresAtMs: Date.now() + HOUR }),
    );
    await ex.exec("git status");
    expect(run).toHaveBeenCalledTimes(2);
    const [writeCmd, writeOpts] = run.mock.calls[0] as [string, { envs?: Record<string, string> }];
    expect(writeCmd).toBe(credentialWriteScript(E2B_CREDENTIAL_FILE));
    expect(writeCmd).not.toContain("ghs_x");
    expect(writeOpts.envs).toEqual({ [SANDBOX_CREDENTIAL_ENV]: credentialLine("ghs_x") });
    expect(run.mock.calls[1][0]).toBe("git status");
    // Freshly written: the next exec runs alone.
    await ex.exec("git log");
    expect(run).toHaveBeenCalledTimes(3);
  });

  it("a push the remote refused for its credential refreshes once (a fresh mint) and re-sends once — never a loop", async () => {
    const credential = vi.fn(async () => ({ token: "ghs_x", expiresAtMs: Date.now() + HOUR }));
    let pushes = 0;
    const { ex, run } = e2bWith(
      async (cmd) => {
        if (cmd.includes("push")) {
          pushes += 1;
          return { stdout: "", stderr: "remote: Invalid username or token", exitCode: 128 };
        }
        return OK;
      },
      async () => ({}),
      credential,
    );
    const out = await ex.exec("git push origin HEAD");
    expect(pushes).toBe(2); // one send, one re-send — a second refusal is the answer
    expect(out).toContain("Invalid username or token");
    expect(credential).toHaveBeenLastCalledWith({ fresh: true });
    expect(run.mock.calls.filter(([c]) => String(c).includes("credential.helper")).length).toBe(2);
  });

  it("an executor without a credential source refreshes nothing — the pre-refresher paths are unchanged", async () => {
    const { ex, run } = e2bWith(async () => OK);
    await ex.exec("git push origin HEAD");
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("a failed write exec ends the exec by name and is re-planned — never believed fresh", async () => {
    const { ex } = e2bWith(
      async (cmd) => {
        if (cmd.includes("credential.helper"))
          throw Object.assign(new Error("exit 1"), { exitCode: 1, stderr: "denied" });
        return OK;
      },
      async () => ({}),
      async () => ({ token: "ghs_x", expiresAtMs: Date.now() + HOUR }),
    );
    await expect(ex.exec("git status")).rejects.toThrow(/credential write failed/);
    // Unconfirmed: the next exec plans the write again (and fails the same way).
    await expect(ex.exec("git status")).rejects.toThrow(/credential write failed/);
  });
});

describe("E2BExecutor per-call timeout", () => {
  // Feature: docs/reference/specs/execution.md item 30 — executor output conformance.
  it("renders a successful empty command as (no output)", async () => {
    const { ex } = e2bWith(async () => ({ stdout: "", stderr: "", exitCode: 0 }));
    await expect(ex.exec("true")).resolves.toBe("(no output)");
  });

  it("runs under the 5-min default when no timeoutMs is passed (today's behavior)", async () => {
    const { ex, run } = e2bWith(async () => OK);
    await expect(ex.exec("ls")).resolves.toBe("ok");
    expect(run.mock.calls[0][1]).toMatchObject({ timeoutMs: 5 * 60_000 });
  });

  it("passes a requested timeoutMs through, clamped to the 20-min ceiling", async () => {
    const { ex, run } = e2bWith(async () => OK);
    await ex.exec("npm test", { timeoutMs: 25 * 60_000 });
    expect(run.mock.calls[0][1]).toMatchObject({ timeoutMs: 20 * 60_000 });
  });

  it("renders the SDK's TimeoutError as exit 124 naming the limit and the timeoutMs knob", async () => {
    const { ex } = e2bWith(async () => {
      throw Object.assign(new Error("command timed out"), { name: "TimeoutError" });
    });
    const text = await ex.exec("sleep 9999", { timeoutMs: 60_000 });
    expect(text).toMatch(/^exit 124:/);
    expect(text).toContain("60s command timeout");
    expect(text).toContain("timeoutMs");
    expect(text).toContain("1200000");
  });

  it("a nonzero exit is still surfaced as output, never the timeout wording", async () => {
    const { ex } = e2bWith(async () => {
      throw Object.assign(new Error("exit 2"), { exitCode: 2, stdout: "", stderr: "boom" });
    });
    const text = await ex.exec("false");
    expect(text).toMatch(/^exit 2:/);
    expect(text).not.toContain("command timeout");
  });
});
