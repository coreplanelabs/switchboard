import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ensureFirstTest, type FirstTestReceipt } from "./firstTest.js";
import { ResidentExecutor } from "../execution/resident.js";
import { CloudflareSandboxExecutor } from "../execution/cloudflareSandbox.js";
import type { ExecOptions, ExecResult } from "../execution/executor.js";

const dirs: string[] = [];
afterEach(() => {
  vi.unstubAllGlobals();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
function fixture() {
  const workspace = realpathSync(mkdtempSync(join(tmpdir(), "swb-first-test-")));
  dirs.push(workspace);
  const bin = join(workspace, "bin");
  mkdirSync(bin);
  mkdirSync(join(workspace, "node_modules"));
  // Simulate the Linux boot-id file on every test host; commands otherwise use the real checkout.
  writeFileSync(
    join(bin, "cat"),
    '#!/bin/bash\nif [ "$1" = /proc/sys/kernel/random/boot_id ]; then printf vm1; else /bin/cat "$@"; fi\n',
    { mode: 0o755 },
  );
  const env = { PATH: `${bin}:/usr/bin:/bin:/usr/local/bin`, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" };
  const git = (...args: string[]) =>
    execFileSync("git", args, { cwd: workspace, env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  git("init", "-b", "work");
  git("config", "user.name", "Test");
  git("config", "user.email", "test@example.invalid");
  writeFileSync(join(workspace, ".gitignore"), "bin/\nnode_modules/\nbaseline-runs\n");
  writeFileSync(join(workspace, "package-lock.json"), "{}");
  git("add", ".");
  git("commit", "-m", "fixture");
  const saved: FirstTestReceipt[] = [];
  const input = {
    executor: {
      async execResult(command: string, opts?: ExecOptions): Promise<ExecResult> {
        try {
          const stdout = execFileSync("bash", ["-c", command], {
            cwd: tmpdir(),
            env,
            encoding: "utf8",
            timeout: opts?.timeoutMs,
            stdio: ["ignore", "pipe", "pipe"],
          });
          return { stdout, stderr: "", exitCode: 0, truncated: false };
        } catch (error) {
          const e = error as { status: number; stdout: string; stderr: string };
          return { stdout: e.stdout, stderr: e.stderr, exitCode: e.status, truncated: false };
        }
      },
    },
    owner: { runId: "run", requester: "slack:UX", threadKey: "slack:C1:1", unit: "" },
    checkout: {
      repo: "acme/api",
      ref: "work",
      head: git("rev-parse", "HEAD"),
      workspace,
      backend: "resident",
      container: "vm1",
      dependencyKey: "deps1",
    },
    requirement: {
      testCommand: "bash -c 'pwd; printf x >> baseline-runs; exit 1'",
      dependencyDir: "node_modules",
      requiredTools: ["bash"],
      firstAction: { kind: "baseline_test" as const, timeoutMs: 10_000, policyVersion: "v1" },
    },
    clock: () => 1,
    remainingMs: () => 60_000,
    signal: new AbortController().signal,
    save: async (receipt: FirstTestReceipt) => {
      saved.push(receipt);
      return true;
    },
  };
  return { input, workspace, saved, git };
}
describe("first coding test bound checkout", () => {
  it.each(["resident", "sandbox"])("tests the actual %s checkout without a second execution", async (backend) => {
    const f = fixture();
    f.input.checkout.backend = backend;
    const shell = f.input.executor;
    const requests: string[] = [];
    vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
      const route = new URL(url).pathname;
      requests.push(route);
      expect(route).toBe("/exec");
      const body = JSON.parse(String(init.body));
      if (backend === "resident") expect(body.resource).toBe("repo:acme/api");
      return new Response(JSON.stringify(await shell.execResult(body.command, { timeoutMs: body.timeoutMs })), {
        status: 200,
      });
    });
    f.input.executor =
      backend === "resident"
        ? new ResidentExecutor({
            baseUrl: "https://resident.example",
            token: "test",
            resource: "repo:acme/api",
            threadKey: f.input.owner.threadKey,
          })
        : new CloudflareSandboxExecutor({
            url: "https://sandbox.example",
            token: "test",
            threadKey: f.input.owner.threadKey,
            resolveEnvs: async () => ({}),
          });
    const receipt = await ensureFirstTest({ ...f.input, seedRestored: backend === "sandbox" });
    expect(receipt.outcome).toMatchObject({ kind: "completed", exitCode: 1, stdout: `${f.workspace}\n` });
    if (backend === "resident") await ensureFirstTest({ ...f.input, previous: receipt });
    else
      await expect(ensureFirstTest({ ...f.input, previous: receipt })).rejects.toMatchObject({
        code: "seed_identity_unverifiable",
      });
    expect(readFileSync(join(f.workspace, "baseline-runs"), "utf8")).toBe("x");
    expect(requests).toEqual(backend === "resident" ? ["/exec", "/exec", "/exec"] : ["/exec", "/exec"]);
  });
  it.each(["head", "ref", "container", "dependencies", "tool"])(
    "refuses actual %s mismatch without executing the test",
    async (part) => {
      const f = fixture();
      if (part === "head") f.input.checkout.head = "b".repeat(40);
      if (part === "ref") f.input.checkout.ref = "wrong";
      if (part === "container") f.input.checkout.container = "other-vm";
      if (part === "dependencies") f.input.requirement.dependencyDir = "missing-deps";
      if (part === "tool") f.input.requirement.requiredTools.push("missing-required-tool");
      await expect(ensureFirstTest(f.input)).rejects.toThrow("held");
      expect(() => readFileSync(join(f.workspace, "baseline-runs"))).toThrow();
    },
  );
  it("refuses a changed untracked patch or lockfile on reuse", async () => {
    const f = fixture();
    writeFileSync(join(f.workspace, "new.txt"), "before");
    const receipt = await ensureFirstTest(f.input);
    writeFileSync(join(f.workspace, "new.txt"), "after");
    await expect(ensureFirstTest({ ...f.input, previous: receipt })).rejects.toMatchObject({
      code: "binding_mismatch",
    });
    writeFileSync(join(f.workspace, "new.txt"), "before");
    writeFileSync(join(f.workspace, "package-lock.json"), '{"changed":true}');
    await expect(ensureFirstTest({ ...f.input, previous: receipt })).rejects.toMatchObject({
      code: "binding_mismatch",
    });
  });
  it("refuses a workspace switched between preflight and execution", async () => {
    const f = fixture();
    f.input.save = async (receipt) => {
      f.saved.push(receipt);
      if (receipt.outcome.kind === "unknown") f.git("switch", "-c", "foreign");
      return true;
    };
    await expect(ensureFirstTest(f.input)).rejects.toThrow("held");
    expect(() => readFileSync(join(f.workspace, "baseline-runs"))).toThrow();
  });
});
