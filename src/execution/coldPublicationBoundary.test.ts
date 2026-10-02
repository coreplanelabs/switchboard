import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { modelSandboxIdentity, newControllerIdentity, disposeColdController } from "./coldPublicationBoundary.js";

// The Worker imports these same decisions before getSandbox. A thread header is
// never a way to address the fresh controller DO, even if the caller knows its name.
describe("cold publication controller identity", () => {
  it("allocates an unselectable controller name under the actual named-Sandbox mapping", () => {
    const controller = newControllerIdentity();
    expect(controller).toMatch(/^controller-[0-9a-f-]{36}$/);
    expect(newControllerIdentity()).not.toBe(controller);
    for (const route of ["/exec", "/read", "/write", "/seed", "/publish"]) {
      expect(modelSandboxIdentity(route, controller)).toBeNull();
      expect(modelSandboxIdentity(route, controller.toUpperCase())).toBeNull();
      expect(modelSandboxIdentity(route, ` ${controller}`)).toBeNull();
    }
    expect(modelSandboxIdentity("/exec", "slack:CX:1.0")).toBe("slack:CX:1.0");
    // The pinned SDK's getSandbox passes its effective name to
    // @cloudflare/containers getContainer, which calls idFromName unchanged.
    // Source-level evidence of the actual mapping; runtime workerd admission
    // still needs an independent release receipt.
    const sdkDir = resolve("node_modules/@cloudflare/sandbox/dist");
    const sdkFile = readdirSync(sdkDir).find((name) => /^sandbox-.*\.js$/.test(name));
    expect(sdkFile).toBeDefined();
    const sdk = readFileSync(resolve(sdkDir, sdkFile!), "utf8");
    expect(sdk).toMatch(
      /const sanitizedId = sanitizeSandboxId\(id\);[\s\S]*?const effectiveId = options\?\.normalizeId \? sanitizedId\.toLowerCase\(\) : sanitizedId;[\s\S]*?const stub = getContainer\(ns, effectiveId\);/,
    );
    const containerSdk = readFileSync("node_modules/@cloudflare/containers/dist/lib/utils.js", "utf8");
    expect(containerSdk).toMatch(/function getContainer\(binding, name[\s\S]*?binding\.idFromName\(name\)/);
    const worker = readFileSync("deploy/cloudflare-sandbox/worker.ts", "utf8");
    expect(worker).toContain("modelSandboxIdentity(url.pathname, threadKey)");
    expect(worker).toContain("if (!modelIdentity) return json(");
    expect(worker.indexOf("if (!modelIdentity) return json(")).toBeLessThan(
      worker.indexOf("getSandbox(env.Sandbox, modelIdentity"),
    );
    expect(worker).toContain("getSandbox(env.Sandbox, newControllerIdentity()");
    expect(worker).toMatch(/disposeColdController\(\s*\(\) => controller\.destroy\(\)/);
    expect(worker).not.toContain("sandbox.runCommand(input.bearer");
  });
  it("tears down one-use controllers on both success and failure without depending on model code", async () => {
    const kept: Promise<void>[] = [];
    const keepAlive = (p: Promise<void>) => {
      kept.push(p);
    };
    expect(await disposeColdController(async () => {}, keepAlive, 20)).toBe(true);
    expect(
      await disposeColdController(
        async () => {
          throw new Error("synthetic-private-failure");
        },
        keepAlive,
        20,
      ),
    ).toBe(false);
    expect(kept).toHaveLength(2);
    await Promise.all(kept);
  });
});
