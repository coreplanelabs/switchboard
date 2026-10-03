import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { CloudflareSandboxExecutor } from "./cloudflareSandbox.js";
import { parsePreservationOwner } from "./sandboxCheckpoint.js";
import { CheckoutFence, installRepairCommand } from "./installRepairEffect.js";

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

  it("routes only a parsed owner to a native no-wake effect; ordinary checkout routes share the fence", () => {
    const worker = readFileSync("deploy/cloudflare-sandbox/worker.ts", "utf8");
    const start = worker.indexOf('if (url.pathname === "/install-repair")');
    const route = worker.slice(start, worker.indexOf("const modelIdentity", start));
    expect(route).toContain("parsePreservationOwner");
    expect(route).toContain("env.Sandbox.get(env.Sandbox.idFromName(threadKey))");
    expect(route).not.toContain("getSandbox(");
    const effect = worker.slice(
      worker.indexOf("async repairDependencies("),
      worker.indexOf("/** The start gate's view", worker.indexOf("async repairDependencies(")),
    );
    expect(effect).toContain("this.ctx.container?.running !== true");
    expect(effect).toContain("this.ctx.container.exec(");
    expect(effect).toContain("this.checkoutFence.exclusive(");
    expect(effect).not.toContain("createExtensionProcessSandbox");
  });
});
