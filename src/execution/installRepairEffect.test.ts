import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { CloudflareSandboxExecutor } from "./cloudflareSandbox.js";
import { parsePreservationOwner } from "./sandboxCheckpoint.js";
import { CheckoutFence, installRepairCommand } from "./installRepairEffect.js";
import { shellQuote } from "./shellQuote.js";

const head = "a".repeat(40);

describe("paused seeded checkout repair", () => {
  it("builds only the fixed npm-ci-v1 command with an exact HEAD and a committed, clean root lockfile", () => {
    const script = installRepairCommand(head);
    expect(script).toContain(`test "$(git rev-parse HEAD)" = '${head}'`);
    expect(script).toContain("git ls-tree HEAD -- package-lock.json npm-shrinkwrap.json");
    expect(script).toContain("git diff --quiet HEAD -- package-lock.json npm-shrinkwrap.json");
    expect(script).toContain("npm ci --ignore-scripts --no-audit --no-fund");
    expect(script).toContain("sha256sum");
    expect(() => installRepairCommand("a; echo hijack")).toThrow();
  });

  it("refuses ignored root npm inputs before invoking the installer", () => {
    const dir = mkdtempSync(join(tmpdir(), "switchboard-install-repair-"));
    const git = (...args: string[]) => execFileSync("git", ["-C", dir, ...args], { encoding: "utf8" }).trim();
    try {
      git("init", "-q");
      writeFileSync(join(dir, "package.json"), "{}\n");
      writeFileSync(join(dir, "package-lock.json"), "{}\n");
      writeFileSync(join(dir, ".gitignore"), ".npmrc\nnpm-shrinkwrap.json\n");
      git("add", "package.json", "package-lock.json", ".gitignore");
      git("-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-qm", "fixture");
      const script = installRepairCommand(git("rev-parse", "HEAD"))
        .replace("cd /workspace/checkout", `cd ${shellQuote(dir)}`)
        .replace("timeout -k 10 900 npm ci --ignore-scripts --no-audit --no-fund >/dev/null 2>&1", "true");
      const run = () => execFileSync("bash", ["-c", script], { encoding: "utf8", stdio: "pipe" });
      expect(run()).toMatch(/^REPAIRED:[0-9a-f]{64}$/);
      for (const name of ["npm-shrinkwrap.json", ".npmrc"]) {
        writeFileSync(join(dir, name), "untracked input\n");
        expect(run, name).toThrow();
        rmSync(join(dir, name));
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("excludes other checkout operations during the entire repair and refuses a repair while a command is in flight", async () => {
    const fence = new CheckoutFence();
    let finish!: () => void;
    const pending = fence.shared(() => new Promise<void>((resolve) => (finish = resolve)));
    expect(fence.exclusive(async () => true)).toBeNull();
    finish();
    await pending;
    let release!: () => void;
    const repair = fence.exclusive(() => new Promise<void>((resolve) => (release = resolve)));
    expect(() => fence.shared(async () => true)).toThrow();
    expect(fence.exclusive(async () => true)).toBeNull();
    release();
    await repair;
    expect(await fence.shared(async () => true)).toBe(true);
  });

  it("sends one owner-bound request with no model environment and refuses an unbound receipt", async () => {
    const owner = parsePreservationOwner({
      run: "11111111-1111-1111-1111-111111111111",
      requester: "slack:U123",
      thread: "slack:C123:1.0",
      repository: "acme/api",
      ref: "feature",
      head,
      seed: "22222222-2222-2222-2222-222222222222",
      container: "33333333-3333-3333-3333-333333333333",
    });
    if (!owner || !("container" in owner)) throw new Error("bad fixture");
    const send = vi.fn(
      async (_url: string, _init: RequestInit) =>
        new Response(
          JSON.stringify({
            version: "install-repair-receipt-v1",
            owner: { ...owner, run: "44444444-4444-4444-4444-444444444444" },
            targetHead: head,
            policyVersion: "npm-ci-v1",
            lockfileKey: "b".repeat(64),
          }),
          { status: 200 },
        ),
    );
    vi.stubGlobal("fetch", send);
    try {
      const client = new CloudflareSandboxExecutor({
        url: "https://sandbox.example",
        token: "trusted",
        threadKey: owner.thread,
        resolveEnvs: async () => {
          throw new Error("model env must not be read");
        },
      });
      expect(await client.repairDependencies(owner, head, { policyVersion: "npm-ci-v1" })).toBeNull();
      expect(send).toHaveBeenCalledOnce();
      expect(JSON.parse(String(send.mock.calls[0]?.[1].body))).toEqual({
        owner,
        targetHead: head,
        policyVersion: "npm-ci-v1",
      });
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("inspects the original durable attempt without sending an install effect", async () => {
    const owner = parsePreservationOwner({
      run: "11111111-1111-1111-1111-111111111111",
      requester: "slack:U123",
      thread: "slack:C123:1.0",
      repository: "acme/api",
      ref: "feature",
      head,
      seed: "22222222-2222-2222-2222-222222222222",
      container: "33333333-3333-3333-3333-333333333333",
    });
    if (!owner || !("container" in owner)) throw new Error("bad fixture");
    const receipt = {
      version: "install-repair-receipt-v1",
      owner,
      targetHead: head,
      policyVersion: "npm-ci-v1",
      lockfileKey: "b".repeat(64),
    };
    const answers = [{ kind: "none" }, { kind: "unknown" }, { kind: "completed", receipt }];
    const send = vi.fn(async (url: string) => {
      expect(new URL(url).pathname).toBe("/install-repair/inspect");
      return new Response(JSON.stringify(answers.shift()), { status: 200 });
    });
    vi.stubGlobal("fetch", send);
    try {
      const client = new CloudflareSandboxExecutor({
        url: "https://sandbox.example",
        token: "trusted",
        threadKey: owner.thread,
        resolveEnvs: async () => {
          throw new Error("model env must not be read");
        },
      });
      expect(await client.inspectRepairDependencies(owner, head, { policyVersion: "npm-ci-v1" })).toEqual({
        kind: "none",
      });
      expect(await client.inspectRepairDependencies(owner, head, { policyVersion: "npm-ci-v1" })).toEqual({
        kind: "unknown",
      });
      expect(await client.inspectRepairDependencies(owner, head, { policyVersion: "npm-ci-v1" })).toEqual({
        kind: "completed",
        receipt,
      });
      expect(send).toHaveBeenCalledTimes(3);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("routes only a parsed owner to a native no-wake effect; ordinary checkout routes share the fence", () => {
    const worker = readFileSync("deploy/cloudflare-sandbox/worker.ts", "utf8");
    const start = worker.indexOf(
      'if (url.pathname === "/install-repair" || url.pathname === "/install-repair/inspect")',
    );
    const route = worker.slice(start, worker.indexOf("const modelIdentity", start));
    expect(route).toContain("parsePreservationOwner");
    expect(route).toContain("env.Sandbox.get(env.Sandbox.idFromName(threadKey))");
    expect(route).not.toContain("getSandbox(");
    expect(route).toContain("stub.inspectRepairDependencies(owner, body.targetHead)");
    const effect = worker.slice(
      worker.indexOf("async repairDependencies("),
      worker.indexOf("/** The start gate's view", worker.indexOf("async repairDependencies(")),
    );
    expect(effect).toContain("this.ctx.container?.running !== true");
    expect(effect).toContain("this.ctx.container.exec(");
    expect(effect).toContain("this.checkoutFence.exclusive(");
    expect(effect).toContain("this.inspectRepairDependencies(owner, targetHead)");
    expect(effect.indexOf("this.ctx.storage.put(attemptKey, { owner, targetHead })")).toBeLessThan(
      effect.indexOf("this.ctx.container.exec("),
    );
    expect(effect).toContain("this.ctx.storage.put(attemptKey, { owner, targetHead, receipt })");
    expect(effect).not.toContain("createExtensionProcessSandbox");
  });
});
