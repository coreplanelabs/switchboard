import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { build } from "esbuild";
import { describe, expect, it } from "vitest";
import { ROOT_ASSETS, shippedAssets, shippedDeployAssets } from "./build.mts";

// Feature: docs/reference/specs/packaging.md items 1–2 — what the package
// ships and what it depends on are both derived: the assets from what the
// repository tracks under deploy/, the dependencies from what the bundled CLI
// actually imports.

const PACKAGE_DIR = import.meta.dirname;
const REPO_ROOT = resolve(PACKAGE_DIR, "..", "..");
const read = (rel: string) => readFileSync(join(REPO_ROOT, rel), "utf8");

describe("shippedDeployAssets", () => {
  const tracked = [
    "deploy/agent-env-bootstrap.sh",
    "deploy/agent-env.jsonc",
    "deploy/bin/build-stamp.mjs",
    "deploy/cloudflare/package.json",
    "deploy/cloudflare/preflight.mjs",
    "deploy/cloudflare/preflight.test.mjs",
    "deploy/cloudflare/vitest.config.mjs",
    "deploy/cloudflare/worker.ts",
    "deploy/cloudflare/wrangler.template.jsonc",
    "deploy/cloudflare-memory/test-env.d.ts",
    "deploy/cloudflare-memory/worker.test.ts",
    "deploy/cloudflare-resident/Dockerfile",
    "deploy/profile.example.json",
    "deploy/secrets.manifest.json",
  ];

  it("keeps every tracked deploy path but tests, vitest configs, test typings and the agent-env tooling, sorted", () => {
    expect(shippedDeployAssets(tracked)).toEqual([
      "deploy/bin/build-stamp.mjs",
      "deploy/cloudflare-resident/Dockerfile",
      "deploy/cloudflare/package.json",
      "deploy/cloudflare/preflight.mjs",
      "deploy/cloudflare/worker.ts",
      "deploy/cloudflare/wrangler.template.jsonc",
      "deploy/profile.example.json",
      "deploy/secrets.manifest.json",
    ]);
  });

  it("ignores paths outside deploy/ — the root assets are a separate, explicit list", () => {
    expect(shippedDeployAssets(["src/cli.ts", "deploy/profile.example.json"])).toEqual(["deploy/profile.example.json"]);
    expect(shippedAssets(["deploy/profile.example.json"])).toEqual([...ROOT_ASSETS, "deploy/profile.example.json"]);
  });

  it("the root assets are the files init derives from, the marker the resolver looks for, and the bot image's own files", () => {
    expect(ROOT_ASSETS).toEqual([
      ".env.example",
      "config/config.example.yaml",
      "project.json",
      "Dockerfile",
      "docker-entrypoint.sh",
      ".dockerignore",
    ]);
  });
});

describe("the package manifest", () => {
  const pkg = JSON.parse(read("packages/switchboard/package.json")) as {
    dependencies: Record<string, string>;
    engines: { node: string };
    bin: Record<string, string>;
    files: string[];
    publishConfig: Record<string, unknown>;
    private?: boolean;
  };
  const rootPkg = JSON.parse(read("package.json")) as { dependencies: Record<string, string> };

  it("depends on exactly the npm packages the bundled CLI imports, at the root's ranges — nothing more, nothing missing", async () => {
    const result = await build({
      entryPoints: [join(REPO_ROOT, "src/cli.ts")],
      bundle: true,
      platform: "node",
      format: "esm",
      packages: "external",
      write: false,
      metafile: true,
      logLevel: "silent",
    });
    const externals = new Set<string>();
    for (const input of Object.values(result.metafile.inputs)) {
      for (const imp of input.imports) {
        if (!imp.external || imp.path.startsWith("node:")) continue;
        const [scope, name] = imp.path.split("/");
        externals.add(scope.startsWith("@") ? `${scope}/${name}` : scope);
      }
    }
    expect([...externals].sort()).toEqual(Object.keys(pkg.dependencies).sort());
    for (const [name, range] of Object.entries(pkg.dependencies)) {
      expect(range, `${name} must be at the root's range`).toBe(rootPkg.dependencies[name]);
    }
  });

  it("runs on the Node the tree pins (.nvmrc), names the bundled CLI as the `switchboard` bin, ships only dist/, and would publish public with provenance", () => {
    const pinned = read(".nvmrc").trim();
    expect(pkg.engines.node).toBe(`>=${pinned}`);
    expect(pkg.bin).toEqual({ switchboard: "dist/cli.js" });
    expect(pkg.files).toEqual(["dist"]);
    expect(pkg.publishConfig).toEqual({ access: "public", provenance: true });
  });

  it("is private until publishing is turned on: npm refuses to publish it from anywhere, while `npm pack` still works (the smoke test)", () => {
    // Publishing starts with a reviewed PR that removes this line — the visible record — plus the
    // repository variable and secret the release workflow reads (docs/how-to/ship-a-release.md).
    expect(pkg.private).toBe(true);
  });
});
