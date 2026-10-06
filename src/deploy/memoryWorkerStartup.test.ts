import { build } from "esbuild";
import { unstable_dev, unstable_getMiniflareWorkerOptions } from "wrangler";
import { resolve, join } from "node:path";
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { DO_MAX_BOUND_PARAMETERS, RUN_EVENT_INSERT_BATCH } from "../memorySqlLimits.js";
import { baseConfigDocument } from "../configDocument.js";

// Use Wrangler's production options in an independent Workerd process. The
// SQLite test plugin adds Node support and cannot prove this startup boundary.
describe("Memory production runtime", () => {
  it("starts without Node compatibility and preserves conditional config and immutable snapshots", async () => {
    const production = unstable_getMiniflareWorkerOptions(resolve("deploy/cloudflare-memory/wrangler.jsonc"));
    expect(production.workerOptions.compatibilityFlags).not.toContain("nodejs_compat");
    const bundled = await build({
      entryPoints: [production.main!],
      bundle: true,
      format: "esm",
      platform: "browser",
      external: ["cloudflare:*", "node:*"],
      write: false,
      metafile: true,
      define: production.define,
    });
    const nodeImports = Object.values(bundled.metafile!.outputs)
      .flatMap((output) => output.imports)
      .filter((entry) => entry.path.startsWith("node:"));
    expect(nodeImports).toEqual([]);
    expect(DO_MAX_BOUND_PARAMETERS).toBe(100);
    expect(RUN_EVENT_INSERT_BATCH).toBe(Math.floor(DO_MAX_BOUND_PARAMETERS / 3));
    expect(Object.values(bundled.metafile!.outputs).flatMap((output) => output.exports)).not.toContain(
      "RUN_EVENT_INSERT_BATCH",
    );
    expect(Object.keys(bundled.metafile!.inputs)).not.toContain("src/configDocument.ts");
    // Copy the generated production bytes unchanged; keep Wrangler's local
    // build/state files inside this proof's own temporary directory.
    const directory = mkdtempSync(join(tmpdir(), "memory-production-runtime-"));
    const config = join(directory, "wrangler.jsonc");
    const productionConfig = readFileSync(resolve("deploy/cloudflare-memory/wrangler.jsonc"), "utf8");
    writeFileSync(config, productionConfig);
    expect(readFileSync(config, "utf8")).toBe(productionConfig);
    const runtime = await unstable_dev(production.main!, {
      config,
      local: true,
      ip: "127.0.0.1",
      port: 0,
      inspectorPort: 0,
      vars: { MEMORY_TOKEN: "fixture-token" },
      logLevel: "warn",
      experimental: { disableExperimentalWarning: true, watch: false },
    });
    try {
      expect((await runtime.fetch("https://memory.test/healthz")).status).toBe(200);
      const post = async (path: string, body: unknown) => {
        const payload = JSON.stringify(body);
        const response = await runtime.fetch(`https://memory.test${path}`, {
          method: "POST",
          headers: {
            authorization: "Bearer fixture-token",
            "content-type": "application/json",
            "content-length": String(Buffer.byteLength(payload)),
          },
          body: payload,
        });
        return { status: response.status, body: await response.json() };
      };
      const original = baseConfigDocument("# original private bytes\n", "fixture", new Date(0));
      const candidate = baseConfigDocument("# candidate private bytes\n", "fixture", new Date(1));
      const target = `base-${"a".repeat(40)}`;
      const sourcePrecondition = { key: "base", version: 1 };
      expect(await post("/config/put", { key: "base", document: original, expectedVersion: 0 })).toEqual({
        status: 200,
        body: { ok: true, version: 1 },
      });
      expect(
        await post("/config/put", { key: target, document: candidate, expectedVersion: 0, sourcePrecondition }),
      ).toEqual({ status: 200, body: { ok: true, version: 1, sourcePrecondition } });
      expect(await post("/config/put", { key: "base", document: candidate, expectedVersion: 1 })).toEqual({
        status: 200,
        body: { ok: true, version: 2 },
      });
      expect(
        (await post("/config/put", { key: target, document: original, expectedVersion: 1, sourcePrecondition })).status,
      ).toBe(409);
      expect(await post("/config/get", { key: target })).toEqual({
        status: 200,
        body: { document: candidate, version: 1 },
      });
      const snapshot = `deploy-base-${crypto.randomUUID()}`;
      expect(
        (await post("/config/put", { key: snapshot, document: { private: "retained input" }, expectedVersion: 0 }))
          .status,
      ).toBe(200);
      expect(
        (await post("/config/put", { key: snapshot, document: { private: "replacement" }, expectedVersion: 1 })).status,
      ).toBe(409);
      expect(await post("/config/get", { key: snapshot })).toEqual({
        status: 200,
        body: { document: { private: "retained input" }, version: 1 },
      });
    } finally {
      await runtime.stop();
      rmSync(directory, { recursive: true, force: true });
    }
  }, 30_000);
});
