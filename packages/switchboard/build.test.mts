import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { build } from "esbuild";
import { describe, expect, it } from "vitest";
import { WORKER_SPECS } from "../../src/deploy/plan.js";
import { ROOT_ASSETS, shippedAssets, shippedDeployAssets, webDistAssets, workerSourceFiles } from "./build.mts";

// Feature: docs/reference/specs/packaging.md items 1–2, 7 and 8 — what the
// package ships and what it depends on are both derived: the assets from what
// the repository tracks under deploy/, the sources the Workers import and the
// dashboard's build, the dependencies from what the bundled CLI actually
// imports — the bot's entry included, since `start` runs it.

const PACKAGE_DIR = import.meta.dirname;
const REPO_ROOT = resolve(PACKAGE_DIR, "..", "..");
const read = (rel: string) => readFileSync(join(REPO_ROOT, rel), "utf8");
const readTree = async (rel: string) => (existsSync(join(REPO_ROOT, rel)) ? read(rel) : undefined);

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

  it("ignores paths outside deploy/ — the root assets are a separate, explicit list, and the Worker sources come after them, each once", () => {
    expect(shippedDeployAssets(["src/cli.ts", "deploy/profile.example.json"])).toEqual(["deploy/profile.example.json"]);
    expect(shippedAssets(["deploy/profile.example.json"])).toEqual([...ROOT_ASSETS, "deploy/profile.example.json"]);
    expect(
      shippedAssets(
        ["deploy/profile.example.json", "deploy/cloudflare-memory/worker.ts"],
        ["src/core/runRecord.ts", "deploy/cloudflare-memory/worker.ts", "package.json"],
      ),
    ).toEqual([
      ...ROOT_ASSETS,
      "deploy/cloudflare-memory/worker.ts",
      "deploy/profile.example.json",
      "src/core/runRecord.ts",
    ]);
    // The dashboard's build rides in the same sorted tail, at its tree path.
    expect(
      shippedAssets(["deploy/profile.example.json"], [], ["web/dist/.vite/manifest.json", "web/dist/assets/main-A.js"]),
    ).toEqual([
      ...ROOT_ASSETS,
      "deploy/profile.example.json",
      "web/dist/.vite/manifest.json",
      "web/dist/assets/main-A.js",
    ]);
  });

  it("the dashboard's files ship under web/dist, every one, sorted; a listing without the Vite manifest is not a build and is refused naming the command that makes one", () => {
    expect(webDistAssets(["assets/main-A.js", ".vite/manifest.json", "assets/main-B.css"])).toEqual([
      "web/dist/.vite/manifest.json",
      "web/dist/assets/main-A.js",
      "web/dist/assets/main-B.css",
    ]);
    expect(() => webDistAssets(["assets/main-A.js"])).toThrow(
      "web/dist has no .vite/manifest.json — it is not a build (npm run build -w web makes one)",
    );
    expect(() => webDistAssets([])).toThrow("not a build");
  });

  it("the root assets are the files init derives from, the marker the resolver looks for, the bot image's own files, and the manifest + lockfile a materialised Worker directory installs against", () => {
    expect(ROOT_ASSETS).toEqual([
      ".env.example",
      "config/config.example.yaml",
      "project.json",
      "Dockerfile",
      "docker-entrypoint.sh",
      ".dockerignore",
      "package.json",
      "package-lock.json",
    ]);
  });
});

describe("workerSourceFiles", () => {
  it("is the union of the Worker entries' relative-import closures under src/, sorted — the real four resolve completely and reach into src/", async () => {
    const files = await workerSourceFiles(readTree);
    expect(files.length).toBeGreaterThan(0);
    expect(files).toEqual([...files].sort());
    for (const f of files) expect(f).toMatch(/^src\//);
    // The memory Worker's engine and the bot shim's schedule registry are the canonical shared imports.
    expect(files).toContain("src/core/runRecord.ts");
    expect(files).toContain("src/core/schedules.ts");
    // Nothing under deploy/ is in the list: those ship as tracked deploy assets.
    expect(files.some((f) => f.startsWith("deploy/"))).toBe(false);
    expect(WORKER_SPECS.map((w) => w.entry).every((e) => e.startsWith("deploy/"))).toBe(true);
  });

  it("an entry whose import resolves to no file is an error naming the specifier — never a package shipped without a source", async () => {
    const tree = new Map([["deploy/x/worker.ts", 'import { a } from "../../src/nowhere.js";\n']]);
    await expect(workerSourceFiles(async (p) => tree.get(p), ["deploy/x/worker.ts"])).rejects.toThrow(
      "deploy/x/worker.ts: imports that resolve to no file — ../../src/nowhere.js from deploy/x/worker.ts",
    );
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

  const bundled = build({
    entryPoints: [join(REPO_ROOT, "src/cli.ts")],
    bundle: true,
    platform: "node",
    format: "esm",
    packages: "external",
    write: false,
    metafile: true,
    logLevel: "silent",
  });

  it("the bundle carries the bot process: the CLI's closure reaches src/index.ts and the Slack adapter, so `start` is the same process the image runs", async () => {
    // The metafile keys inputs relative to esbuild's working directory (this package's).
    const inputs = Object.keys((await bundled).metafile.inputs).map((p) => p.replace(/^(\.\.\/)+/, ""));
    expect(inputs).toContain("src/index.ts");
    expect(inputs).toContain("src/channels/slack.ts");
    expect(inputs).toContain("src/channels/webAssets.ts");
  });

  it("depends on exactly the npm packages the bundled CLI imports, at the root's ranges — nothing more, nothing missing", async () => {
    const result = await bundled;
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
    // Public by config; provenance is the workflow's call (only while the repository is public), not the manifest's.
    expect(pkg.publishConfig).toEqual({ access: "public" });
  });

  it("is publishable: no `private` flag — publishing is gated by the release workflow's switch and npm's trusted-publisher settings, not by the manifest", () => {
    expect(pkg.private).toBeUndefined();
  });
});
