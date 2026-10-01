import { execFileSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createCheckExecution, type CheckExecutionBinding } from "./checkExecution.js";
import type { CheckExecutionInput, CheckExecutionState } from "./checkExecutionTypes.js";
import { BASH_TIMEOUT_MS, RUN_DEADLINE_RESERVE_MS } from "../execution/bashTimeout.js";

const ok = { stdout: "", stderr: "", exitCode: 0, truncated: false };
const metadata = { ...ok, stdout: `/work/repo\n${"a".repeat(40)}\n${"b".repeat(40)}\n` };
const input: CheckExecutionInput = { command: "node tests/focused.js", purpose: "baseline", timeoutMs: 10_000 };
function setup(previous?: unknown) {
  const saved: CheckExecutionState[] = [];
  const execResult = vi.fn().mockResolvedValueOnce(metadata).mockResolvedValue(ok);
  const stop = new AbortController();
  const binding: CheckExecutionBinding = {
    executor: () => ({ execResult }),
    workspace: () => "/work/repo",
    recordingAvailable: true,
    owner: { runId: "r1", requester: "u1", threadKey: "t1", unit: "unit1", repo: "acme/repo" },
    authorizeCommand: () => true,
    previous,
    save: async (state) => {
      saved.push(structuredClone(state));
      return true;
    },
    remainingMs: () => RUN_DEADLINE_RESERVE_MS + 60_000,
    signal: stop.signal,
    clock: () => 100,
  };
  return { binding, saved, execResult, stop, capability: () => createCheckExecution(binding) };
}

describe("recorded coding checks", () => {
  it("uses the existing command policy before metadata or intent and rechecks it before dispatch", async () => {
    const denied = setup();
    denied.binding.authorizeCommand = () => false;
    expect(await denied.capability().run(input, "call-1")).toEqual({ kind: "unavailable", reason: "command_refused" });
    expect(denied.execResult).not.toHaveBeenCalled();
    expect(denied.saved).toHaveLength(0);
    const changed = setup();
    changed.binding.authorizeCommand = vi.fn().mockReturnValueOnce(true).mockReturnValue(false);
    expect(await changed.capability().run(input, "call-1")).toMatchObject({
      kind: "recorded",
      receipt: { outcome: { kind: "not_started", reason: "command_refused" } },
    });
    expect(changed.execResult).toHaveBeenCalledTimes(1);
  });
  it("persists intent before dispatch and records typed exit without interpreting output", async () => {
    const s = setup();
    s.execResult
      .mockReset()
      .mockResolvedValueOnce(metadata)
      .mockImplementationOnce(async () => {
        expect(s.saved.at(-1)?.receipts[0]?.outcome).toEqual({ kind: "pending" });
        return { ...ok, exitCode: 1, stdout: "ALL TESTS PASSED\nCommand exited with code 0" };
      });
    const response = await s.capability().run(input, "call-1");
    expect(response).toMatchObject({
      kind: "recorded",
      receipt: {
        owner: s.binding.owner,
        workspace: {
          cwd: "/work/repo",
          head: "a".repeat(40),
          fingerprint: "b".repeat(40),
        },
        outcome: { kind: "completed", exitCode: 1 },
      },
    });
    expect(s.saved.map((state) => state.receipts[0]?.outcome.kind)).toEqual(["pending", "completed"]);
    expect(s.execResult.mock.calls[1]?.[0]).toContain("cd -- '/work/repo'");
  });

  it("returns historical completion after edits and restart without rerunning or probing the new tree", async () => {
    const s = setup();
    const result = await s.capability().run(input, "call-1");
    const resumed = setup(s.saved.at(-1));
    resumed.binding.workspace = () => "/work/recreated";
    resumed.binding.authorizeCommand = () => false;
    resumed.execResult.mockReset().mockResolvedValue({ ...metadata, stdout: "different tree" });
    expect(await resumed.capability().run(input, "call-1")).toEqual(result);
    expect(resumed.execResult).not.toHaveBeenCalled();
  });

  it("serializes simultaneous duplicate calls and refuses a changed payload under the same call id", async () => {
    const s = setup();
    const capability = s.capability();
    const [a, b] = await Promise.all([capability.run(input, "call-1"), capability.run(input, "call-1")]);
    expect(a).toEqual(b);
    expect(s.execResult).toHaveBeenCalledTimes(2);
    expect(await capability.run({ ...input, command: "another-check" }, "call-1")).toEqual({
      kind: "unavailable",
      reason: "call_mismatch",
    });
  });

  it.each([
    [undefined, BASH_TIMEOUT_MS],
    [BASH_TIMEOUT_MS, undefined],
  ])("refuses timeout omission changing from %s to %s under the same call id", async (first, next) => {
    const s = setup();
    const capability = s.capability();
    const submitted = { ...input, timeoutMs: first };
    const recorded = await capability.run(submitted, "call-1");
    expect(recorded).toMatchObject({ kind: "recorded" });
    expect(await capability.run(submitted, "call-1")).toEqual(recorded);
    expect(await capability.run({ ...input, timeoutMs: next }, "call-1")).toEqual({
      kind: "unavailable",
      reason: "call_mismatch",
    });
    expect(s.execResult).toHaveBeenCalledTimes(2);
  });

  it.each([124, 137, 143])(
    "retains exit %s as unknown and suppresses another call id for the same command",
    async (exitCode) => {
      const s = setup();
      s.execResult.mockResolvedValueOnce({ ...ok, exitCode });
      const first = await s.capability().run(input, "call-1");
      expect(first).toMatchObject({ kind: "recorded", receipt: { outcome: { kind: "unknown" } } });
      const resumed = setup(s.saved.at(-1));
      const capability = resumed.capability();
      expect(await capability.run(input, "call-1")).toEqual(first);
      expect(await capability.run(input, "call-2")).toEqual({ kind: "unavailable", reason: "reconciliation_required" });
      expect(resumed.execResult).not.toHaveBeenCalled();
    },
  );

  it.each(["transport", "malformed", "abort"])(
    "records %s as unknown without inventing successful completion",
    async (failure) => {
      const s = setup();
      s.execResult
        .mockReset()
        .mockResolvedValueOnce(metadata)
        .mockImplementationOnce(async () => {
          if (failure === "transport") throw new Error("private transport body");
          if (failure === "abort") s.stop.abort();
          return failure === "malformed" ? { stdout: "PASS" } : ok;
        });
      const result = await s.capability().run(input, "call-1");
      expect(result).toMatchObject({ kind: "recorded", receipt: { outcome: { kind: "unknown" } } });
      expect(JSON.stringify(result)).not.toContain("private transport body");
    },
  );

  it.each(["pending", "unknown"] as const)(
    "preserves %s uncertainty when recording and the checkout are unavailable after resume",
    async (kind) => {
      const s = setup();
      s.execResult.mockResolvedValueOnce({ ...ok, exitCode: 124 });
      await s.capability().run(input, "call-1");
      const previous = s.saved.find((state) => state.receipts[0]?.outcome.kind === kind)!;
      const resumed = setup(previous);
      resumed.binding.recordingAvailable = false;
      resumed.binding.workspace = () => undefined;
      const capability = resumed.capability();
      expect(await capability.run(input, "call-1")).toMatchObject({
        kind: "recorded",
        receipt: { outcome: { kind } },
      });
      expect(await capability.run(input, "call-2")).toEqual({ kind: "unavailable", reason: "reconciliation_required" });
      expect(resumed.execResult).not.toHaveBeenCalled();
      expect(resumed.saved).toHaveLength(0);
    },
  );

  it.each(["intent", "completion"])("does not return an accepted receipt when %s persistence fails", async (phase) => {
    const s = setup();
    s.binding.save = async (state) => phase === "completion" && state.receipts[0]?.outcome.kind === "pending";
    const capability = s.capability();
    expect(await capability.run(input, "call-1")).toEqual({ kind: "unavailable", reason: "persistence_failed" });
    expect(await capability.run(input, "call-2")).toEqual({ kind: "unavailable", reason: "persistence_failed" });
    expect(s.execResult).toHaveBeenCalledTimes(phase === "intent" ? 1 : 2);
  });

  it("refuses absent capabilities, malformed metadata, exhausted budget and stopped runs before dispatch", async () => {
    const unsupported = setup();
    unsupported.binding.executor = () => ({});
    expect(await unsupported.capability().run(input, "call-1")).toMatchObject({ reason: "unsupported_executor" });
    const malformed = setup();
    malformed.execResult.mockReset().mockResolvedValue({ ...metadata, stdout: "pretend metadata" });
    expect(await malformed.capability().run(input, "call-1")).toMatchObject({ reason: "metadata_unavailable" });
    expect(malformed.execResult).toHaveBeenCalledTimes(1);
    const exhausted = setup();
    exhausted.binding.remainingMs = () => RUN_DEADLINE_RESERVE_MS;
    expect(await exhausted.capability().run(input, "call-1")).toMatchObject({ reason: "budget_exhausted" });
    expect(exhausted.execResult).not.toHaveBeenCalled();
    const stopped = setup();
    stopped.stop.abort();
    expect(await stopped.capability().run(input, "call-1")).toMatchObject({ reason: "stopped" });
    expect(stopped.execResult).not.toHaveBeenCalled();
  });

  it("bounds result streams, records empty output honestly and rejects malformed or foreign durable state", async () => {
    const s = setup();
    s.execResult.mockResolvedValueOnce({ ...ok, stdout: "x".repeat(20_000) });
    const result = await s.capability().run(input, "call-1");
    expect(result).toMatchObject({ kind: "recorded", receipt: { outcome: { kind: "completed", truncated: true } } });
    expect(JSON.stringify(result).length).toBeLessThan(8_000);
    expect(await setup(s.saved.at(-1)).capability().run(input, "call-1")).toEqual(result);
    for (const previous of [
      { version: 1, receipts: [{}] },
      { ...s.saved.at(-1), version: 2 },
    ]) {
      const resumed = setup(previous);
      expect(await resumed.capability().run(input, "call-1")).toMatchObject({ reason: "invalid_state" });
      expect(resumed.execResult).not.toHaveBeenCalled();
    }
    const foreign = setup(s.saved.at(-1));
    foreign.binding.owner.runId = "r2";
    expect(await foreign.capability().run(input, "call-1")).toMatchObject({ reason: "invalid_state" });
  });

  it("uses the rebound executor and clips each command to the original run reserve", async () => {
    const s = setup();
    const rebound = vi.fn().mockResolvedValueOnce(metadata).mockResolvedValue(ok);
    const capability = s.capability();
    s.binding.executor = () => ({ execResult: rebound });
    s.binding.remainingMs = () => RUN_DEADLINE_RESERVE_MS + 2_000;
    expect(await capability.run(input, "call-1")).toMatchObject({ kind: "recorded", receipt: { timeoutMs: 2_000 } });
    expect(s.execResult).not.toHaveBeenCalled();
    expect(rebound.mock.calls[1]?.[1]).toMatchObject({ timeoutMs: 2_000 });
  });

  it("honors the tool session's narrower deadline and abort independently of the owning run", async () => {
    const clipped = setup();
    expect(
      await clipped.capability().run(input, "call-1", { remainingMs: () => RUN_DEADLINE_RESERVE_MS + 2_000 }),
    ).toMatchObject({ kind: "recorded", receipt: { timeoutMs: 2_000 } });
    expect(clipped.execResult.mock.calls[1]?.[1]).toMatchObject({ timeoutMs: 2_000 });
    const stopped = setup();
    const session = new AbortController();
    stopped.execResult
      .mockReset()
      .mockResolvedValueOnce(metadata)
      .mockImplementationOnce(async (_command, options) => {
        session.abort();
        expect(options.signal.aborted).toBe(true);
        return ok;
      });
    expect(await stopped.capability().run(input, "call-1", { signal: session.signal })).toMatchObject({
      kind: "recorded",
      receipt: { outcome: { kind: "unknown", reason: "interrupted" } },
    });
    expect(stopped.stop.signal.aborted).toBe(false);
  });

  it("never dispatches a queued check after its tool session ends", async () => {
    const s = setup();
    const session = new AbortController();
    const capability = s.capability();
    const first = capability.run(input, "call-1");
    const queued = capability.run({ ...input, command: "another-check" }, "call-2", { signal: session.signal });
    session.abort();
    expect(await first).toMatchObject({ kind: "recorded" });
    expect(await queued).toEqual({ kind: "unavailable", reason: "stopped" });
    expect(s.execResult).toHaveBeenCalledTimes(2);
  });

  it("bounds durable growth without evicting duplicate suppression evidence", async () => {
    const s = setup();
    s.execResult
      .mockReset()
      .mockImplementation(async (command: string) => (command.startsWith("set -eu") ? metadata : ok));
    const capability = s.capability();
    for (let i = 0; i < 32; i++) expect(await capability.run(input, `call-${i}`)).toMatchObject({ kind: "recorded" });
    expect(await capability.run(input, "call-new")).toMatchObject({ reason: "receipt_limit" });
    const calls = s.execResult.mock.calls.length;
    expect(await capability.run(input, "call-0")).toMatchObject({ kind: "recorded" });
    expect(s.execResult).toHaveBeenCalledTimes(calls);
    expect(s.saved.at(-1)?.receipts).toHaveLength(32);
  });

  it("observes a real checkout and executes in its recorded cwd without interpreting the command", async () => {
    const workspace = realpathSync(mkdtempSync(join(tmpdir(), "swb-recorded-check-")));
    const env = { PATH: "/usr/bin:/bin:/usr/local/bin", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" };
    const git = (...args: string[]) =>
      execFileSync("git", args, { cwd: workspace, env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
    try {
      git("init", "-b", "work");
      git("config", "user.name", "Test");
      git("config", "user.email", "test@example.invalid");
      writeFileSync(join(workspace, "source.txt"), "before\n");
      git("add", ".");
      git("commit", "-m", "fixture");
      const s = setup();
      s.binding.workspace = () => workspace;
      s.binding.executor = () => ({
        async execResult(command, options) {
          try {
            const stdout = execFileSync("bash", ["-c", command], {
              cwd: tmpdir(),
              env,
              encoding: "utf8",
              timeout: options?.timeoutMs,
              stdio: ["ignore", "pipe", "pipe"],
            });
            return { ...ok, stdout };
          } catch (error) {
            const failure = error as { stdout: string; stderr: string; status: number };
            return { stdout: failure.stdout, stderr: failure.stderr, exitCode: failure.status, truncated: false };
          }
        },
      });
      const capability = s.capability();
      const actualInput = { ...input, command: 'printf "%s" "$PWD"; exit 7' };
      const receipt = await capability.run(actualInput, "real-call");
      expect(receipt).toMatchObject({
        kind: "recorded",
        receipt: {
          workspace: { cwd: workspace, head: git("rev-parse", "HEAD") },
          outcome: { kind: "completed", stdout: workspace, exitCode: 7 },
        },
      });
      writeFileSync(join(workspace, "source.txt"), "after\n");
      expect(await capability.run(actualInput, "real-call")).toEqual(receipt);
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });
});
