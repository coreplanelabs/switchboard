import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  classifyPath,
  computeAffected,
  formatAffectedMarkdown,
  importClosure,
  importSpecifiers,
  packageJsonChangeKind,
  prodDepsDiff,
  resolveImportCandidates,
  workspaceDependencies,
  type AffectedProbe,
  type AffectedReport,
} from "./affected.js";
import { WORKER_SPECS as WORKERS, type WorkerName } from "./plan.js";

// Feature: docs/reference/specs/release-and-deploy.md items 4–7 — which Workers a release
// deploys is DERIVED from the tree: each Worker's base is the commit it serves,
// its inputs are its bundle's import closure + its directory + its production
// dependencies (+ the bot's image sources), inert paths are an explicit list,
// and anything else makes the whole fleet unsure. Everything here is pure; the
// probe (git + /healthz) is faked, except the one test that crawls the real
// checkout to prove the four entries resolve.

const REPO_ROOT = join(import.meta.dirname, "..", "..");
const sha = (c: string) => c.repeat(40);
const HEAD = sha("f");
const LIVE = sha("a");
const OLDER = sha("b");
const TAG = sha("c");

type Tree = Record<string, string>;

type LockPkg = {
  version?: string;
  dev?: boolean;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  peerDependenciesMeta?: Record<string, { optional?: boolean }>;
  bundleDependencies?: string[];
};

/** The one root lockfile of an npm workspace, shaped like ours: the root package
 *  and web install their toolchain, the resident hoists the current sandbox SDK,
 *  the sandbox Worker keeps its own older SDK nested (a different major), and
 *  the containers package is nested there too because the versions clash. */
const ROOT_LOCK_PACKAGES: Record<string, LockPkg> = {
  "": { dependencies: { zod: "^4.0.0" }, devDependencies: { vitest: "^5.0.0", typescript: "^7.0.2" } },
  web: { dependencies: { vue: "^3.5.0" }, devDependencies: { vite: "^7.0.0" } },
  "deploy/cloudflare": {
    dependencies: { "@cloudflare/containers": "^0.3.7" },
    devDependencies: { wrangler: "^4.120.1" },
  },
  "deploy/cloudflare-memory": { devDependencies: { wrangler: "^4.120.1" } },
  "deploy/cloudflare-resident": {
    dependencies: { "@cloudflare/sandbox": "0.13.0" },
    devDependencies: { wrangler: "^4.120.1" },
  },
  "deploy/cloudflare-sandbox": {
    dependencies: { "@cloudflare/sandbox": "0.3.7" },
    devDependencies: { wrangler: "^4.120.1" },
  },
  "deploy/cloudflare-sandbox/node_modules/@cloudflare/sandbox": {
    version: "0.3.7",
    dependencies: { "@cloudflare/containers": "^0.0.28" },
  },
  "deploy/cloudflare-sandbox/node_modules/@cloudflare/containers": { version: "0.0.28" },
  "node_modules/@cloudflare/sandbox": { version: "0.13.0", dependencies: { "@cloudflare/containers": "^0.3.7" } },
  "node_modules/@cloudflare/containers": { version: "0.3.7" },
  "node_modules/zod": { version: "4.0.0" },
  // vue declares a peer the lockfile installs (npm ≥7) and an optional peer nobody installed.
  "node_modules/vue": {
    version: "3.5.0",
    peerDependencies: { "@vue/compiler-sfc": "3.5.0", typescript: "*" },
    peerDependenciesMeta: { typescript: { optional: true } },
  },
  "node_modules/@vue/compiler-sfc": { version: "3.5.0" },
  // vite ships a dependency INSIDE its tarball: no lockfile entry of its own.
  "node_modules/vite": {
    version: "7.0.0",
    dev: true,
    bundleDependencies: ["rollup"],
    dependencies: { rollup: "^4.0.0" },
  },
  "node_modules/vitest": { version: "5.0.0", dev: true },
  "node_modules/typescript": { version: "7.0.2", dev: true },
  "node_modules/wrangler": { version: "4.120.1", dev: true },
};

function lock(packages: Record<string, LockPkg>): string {
  return JSON.stringify({ name: "x", lockfileVersion: 3, packages: { "": { name: "x" }, ...packages } });
}

/** The root lockfile with some packages' versions moved. */
function lockWith(changes: Record<string, LockPkg>): string {
  return lock({ ...ROOT_LOCK_PACKAGES, ...changes });
}

/** The smallest repo shaped like ours: four Worker entries importing a few src/ modules. */
const BASE_TREE: Tree = {
  "deploy/cloudflare-memory/worker.ts":
    'import { rank } from "../../src/core/memory/engine.js";\nexport default { rank };\n',
  "deploy/cloudflare/worker.ts":
    'import { parseHealthz } from "../../src/deploy/liveGate.js";\nexport { parseHealthz };\n',
  "deploy/cloudflare-resident/worker.ts":
    'import { df } from "../../src/execution/residentDisk.js";\nimport type { S } from "../../src/core/schedules.js";\nexport { df };\n',
  "deploy/cloudflare-sandbox/worker.ts":
    'import { shellQuote } from "../../src/execution/shellQuote.js";\nexport { shellQuote };\n',
  "src/core/memory/engine.ts": 'import { tokenize } from "./scorer.js";\nexport const rank = tokenize;\n',
  "src/core/memory/scorer.ts": "export const tokenize = (s: string) => s.split(' ');\n",
  "src/deploy/liveGate.ts": 'import { DRAIN } from "../core/drain.js";\nexport const parseHealthz = DRAIN;\n',
  "src/core/drain.ts": "export const DRAIN = 1;\n",
  "src/execution/residentDisk.ts": "export const df = 1;\n",
  "src/core/schedules.ts": "export type S = 1;\n",
  "src/execution/shellQuote.ts": "export const shellQuote = (s: string) => s;\n",
  "src/index.ts": "export const bot = 1;\n",
  "package.json": JSON.stringify({ name: "switchboard", version: "0.1.0", dependencies: { zod: "^4.0.0" } }),
  "package-lock.json": lock(ROOT_LOCK_PACKAGES),
  "web/package.json": JSON.stringify({ name: "web", version: "0.1.0" }),
  "deploy/cloudflare-resident/package.json": JSON.stringify({
    name: "resident",
    dependencies: { "@cloudflare/sandbox": "0.13.0" },
  }),
  "deploy/cloudflare-resident/wrangler.jsonc": '{ "name": "switchboard-resident" }',
  "deploy/cloudflare-resident/Dockerfile": "FROM docker.io/cloudflare/sandbox:0.13.0\n",
  "docs/how-to/x.md": "# x\n",
  "docs/reference/specs/execution.md": "# spec\n",
  "src/core/drain.test.ts": "test\n",
};

interface FakeRepo {
  /** Every commit's full tree; `HEAD` is always present. */
  trees: Record<string, Tree>;
  /** What each Worker's /healthz says. Absent → an error. */
  live?: Partial<Record<WorkerName, { commit: string } | { error: string }>>;
  /** Commits that are ancestors of HEAD (HEAD itself always is). */
  ancestors?: string[];
  lastRelease?: { tag: string; commit: string };
}

function fakeProbe(repo: FakeRepo) {
  const probed: WorkerName[] = [];
  const probe: AffectedProbe = {
    head: async () => HEAD,
    liveCommit: async (w) => {
      probed.push(w);
      return repo.live?.[w] ?? { error: `GET /healthz → HTTP 401` };
    },
    isAncestor: async (commit, head) => commit === head || (repo.ancestors ?? []).includes(commit),
    lastRelease: async () => repo.lastRelease,
    changedPaths: async (base, head) => {
      const a = repo.trees[base];
      const b = repo.trees[head];
      if (!a || !b) throw new Error(`fake repo has no tree for ${!a ? base : head}`);
      return [...new Set([...Object.keys(a), ...Object.keys(b)])].filter((p) => a[p] !== b[p]).sort();
    },
    fileAt: async (ref, path) => repo.trees[ref]?.[path],
  };
  return { probe, probed };
}

const allLive = (commit: string): FakeRepo["live"] => ({
  memory: { commit },
  bot: { commit },
  resident: { commit },
  sandbox: { commit },
});
const withChanges = (changes: Tree, base: Tree = BASE_TREE): Tree => ({ ...base, ...changes });
const decisions = (r: AffectedReport) => Object.fromEntries(r.workers.map((w) => [w.name, w.decision]));

describe("classifyPath", () => {
  it("tests, docs, specs, CI, scripts, the deploy tooling and repo metadata are inert — they change no deployed artifact", () => {
    for (const p of [
      "src/core/drain.test.ts",
      "deploy/cloudflare/preflight.test.mjs",
      "deploy/cloudflare-memory/runs.test.ts",
      "deploy/cloudflare-memory/vitest.config.ts",
      "deploy/cloudflare-memory/test-env.d.ts",
      "src/core/testing/commandConformance.ts",
      "web/src/testing/fakeEventSource.ts",
      "web/src/lib/runPageModel.test.ts",
      "vitest.config.ts",
      "docs/how-to/x.md",
      "docs/.vitepress/config.ts",
      "docs/reference/specs/execution.md",
      "README.md",
      "deploy/cloudflare-resident/README.md",
      ".github/workflows/ci.yml",
      ".github/CODEOWNERS",
      "scripts/docs-gen.ts",
      "deploy/bin/build-stamp.mjs",
      "deploy/bin/put-secrets.mjs",
      "deploy/cloudflare/preflight.mjs",
      "deploy/cloudflare-resident/preflight.mjs",
      "deploy/cloudflare/write-build.mjs",
      "deploy/cloudflare-docs/wrangler.jsonc",
      "deploy/secrets.manifest.json",
      "deploy/agent-env.jsonc",
      "deploy/agent-env-bootstrap.sh",
      "deploy/profile.json",
      "deploy/profile.example.json",
      ".gitignore",
      ".nvmrc",
      ".env.example",
      "LICENSE",
      "NOTICE",
      "docker-compose.yml",
      "fly.toml",
      "tsconfig.scripts.json",
      "release-please-config.json",
      ".release-please-manifest.json",
      "CHANGELOG.md",
      "switchboard.png",
      ".prettierrc.json",
      ".prettierignore",
      "eslint.config.mjs",
      // One root lockfile: a per-workspace one in a diff is the retired file disappearing.
      "deploy/cloudflare-resident/package-lock.json",
      "web/package-lock.json",
      "docs/package-lock.json",
    ]) {
      expect(classifyPath(p), p).toMatchObject({ kind: "inert" });
    }
    // The root lockfile is nobody's whole-file input: it is judged per Worker by workspace.
    expect(classifyPath("package-lock.json")).toEqual({ kind: "unclassified" });
  });

  it("a Worker's own directory, its wrangler config and Dockerfile are its inputs; the bot's image inputs are the root Dockerfile, .dockerignore, package files, tsconfigs, src/, web/ and skills/ — never config/, which the bot reads from the state Worker", () => {
    expect(classifyPath("deploy/cloudflare-resident/worker.ts")).toEqual({ kind: "input", workers: ["resident"] });
    expect(classifyPath("deploy/cloudflare-resident/wrangler.jsonc")).toEqual({ kind: "input", workers: ["resident"] });
    expect(classifyPath("deploy/cloudflare-resident/Dockerfile")).toEqual({ kind: "input", workers: ["resident"] });
    expect(classifyPath("deploy/cloudflare-resident/gc.ts")).toEqual({ kind: "input", workers: ["resident"] });
    expect(classifyPath("deploy/cloudflare-resident/tsconfig.json")).toEqual({ kind: "input", workers: ["resident"] });
    expect(classifyPath("deploy/cloudflare-memory/worker.ts")).toEqual({ kind: "input", workers: ["memory"] });
    expect(classifyPath("deploy/cloudflare-sandbox/Dockerfile")).toEqual({ kind: "input", workers: ["sandbox"] });
    expect(classifyPath("deploy/cloudflare/worker.ts")).toEqual({ kind: "input", workers: ["bot"] });
    for (const p of [
      "Dockerfile",
      ".dockerignore",
      "package.json",
      "tsconfig.json",
      "tsconfig.build.json",
      "src/index.ts",
      "src/core/dispatcher.ts",
      "web/package.json",
      "web/src/App.vue",
      "skills/pr-tour/SKILL.md",
    ]) {
      expect(classifyPath(p), p).toEqual({ kind: "input", workers: ["bot"] });
    }
    // The bot's config is pushed to the state Worker (`deploy config`), never built into the image.
    expect(classifyPath("config/config.production.yaml")).toEqual({
      kind: "inert",
      rule: "bot runtime config (pushed to the state Worker, never built into the image)",
    });
    expect(classifyPath("config/config.example.yaml")).toMatchObject({ kind: "inert" });
    // A test under src/ is inert even though src/ is a bot input: the image never carries it.
    expect(classifyPath("src/core/dispatcher.test.ts")).toMatchObject({ kind: "inert" });
    // But a skill's markdown IS shipped (COPY skills; loaded at startup) — the markdown rule stops at skills/.
    expect(classifyPath("skills/manifest.yaml")).toEqual({ kind: "input", workers: ["bot"] });
    expect(classifyPath("skills/README.md")).toEqual({ kind: "input", workers: ["bot"] });
  });

  it("a path nobody claims is unclassified — never silently inert", () => {
    expect(classifyPath("terraform/main.tf")).toEqual({ kind: "unclassified" });
    expect(classifyPath("deploy/cloudflare-queue/worker.ts")).toEqual({ kind: "unclassified" });
    expect(classifyPath("Makefile")).toEqual({ kind: "unclassified" });
    expect(classifyPath("bin/switchboard")).toEqual({ kind: "unclassified" });
  });
});

describe("importClosure", () => {
  const read = (tree: Tree) => async (p: string) => tree[p];

  it("reads every static and dynamic import specifier from a source, ignoring bare package names", () => {
    const src = [
      'import { a } from "./a.js";',
      "import type { B } from '../b.js';",
      'import "./side-effect.js";',
      'export { c } from "./c.js";',
      'export * from "./d.js";',
      'const e = await import("./e.js");',
      'import { z } from "zod";',
      'import { w } from "cloudflare:workers";',
      'import { fs } from "node:fs";',
    ].join("\n");
    expect(importSpecifiers(src)).toEqual(["./a.js", "../b.js", "./side-effect.js", "./c.js", "./d.js", "./e.js"]);
  });

  it("resolves a specifier against the importing file's directory: .js → .ts first, then the literal, then an index file", () => {
    expect(resolveImportCandidates("deploy/cloudflare-memory/worker.ts", "../../src/core/memory/engine.js")).toEqual([
      "src/core/memory/engine.ts",
      "src/core/memory/engine.js",
      "src/core/memory/engine.js/index.ts",
    ]);
    expect(resolveImportCandidates("src/deploy/liveGate.ts", "../core/drain.js")).toEqual([
      "src/core/drain.ts",
      "src/core/drain.js",
      "src/core/drain.js/index.ts",
    ]);
    expect(resolveImportCandidates("src/a/b.ts", "./util")).toEqual([
      "src/a/util.ts",
      "src/a/util",
      "src/a/util/index.ts",
    ]);
    expect(resolveImportCandidates("src/a/b.ts", "./styles.css")).toEqual([
      "src/a/styles.css",
      "src/a/styles.css/index.ts",
    ]);
  });

  it("follows relative imports transitively from the Worker entry, once per file even through cycles, and lists the closure sorted", async () => {
    const tree = withChanges({
      "src/core/drain.ts": 'import { parseHealthz } from "../deploy/liveGate.js";\nexport const DRAIN = 1;\n', // a cycle back to liveGate
    });
    const memory = await importClosure("deploy/cloudflare-memory/worker.ts", read(tree));
    expect(memory).toEqual({
      files: ["deploy/cloudflare-memory/worker.ts", "src/core/memory/engine.ts", "src/core/memory/scorer.ts"],
      unresolved: [],
    });
    const bot = await importClosure("deploy/cloudflare/worker.ts", read(tree));
    expect(bot.files).toEqual(["deploy/cloudflare/worker.ts", "src/core/drain.ts", "src/deploy/liveGate.ts"]);
    // A type-only import is still an input (the file is part of the program; over-inclusion is the safe direction).
    const resident = await importClosure("deploy/cloudflare-resident/worker.ts", read(tree));
    expect(resident.files).toContain("src/core/schedules.ts");
  });

  it("an import that resolves to no file is reported, not dropped — the Worker is then deployed as unsure", async () => {
    const tree = withChanges({
      "src/core/memory/engine.ts": 'import { gone } from "./vanished.js";\nexport const rank = gone;\n',
    });
    const r = await importClosure("deploy/cloudflare-memory/worker.ts", read(tree));
    expect(r.unresolved).toEqual([{ from: "src/core/memory/engine.ts", specifier: "./vanished.js" }]);
    expect(r.files).toContain("src/core/memory/engine.ts");
    const missingEntry = await importClosure("deploy/cloudflare-queue/worker.ts", read(tree));
    expect(missingEntry).toEqual({
      files: [],
      unresolved: [{ from: "", specifier: "deploy/cloudflare-queue/worker.ts" }],
    });
  });

  it("the closures of the four real Worker entries resolve completely against the checkout and stay inside src/ and the Worker's own dir", async () => {
    const readReal = async (p: string) =>
      existsSync(join(REPO_ROOT, p)) ? readFileSync(join(REPO_ROOT, p), "utf8") : undefined;
    for (const w of WORKERS) {
      const r = await importClosure(w.entry, readReal);
      expect(r.unresolved, w.name).toEqual([]);
      expect(r.files.length, w.name).toBeGreaterThan(1);
      for (const f of r.files) expect(f.startsWith("src/") || f.startsWith(`${w.dir}/`), `${w.name}: ${f}`).toBe(true);
    }
    // The state Worker shares the run-record contract with the bot (AGENTS.md): a change there deploys both.
    expect((await importClosure(WORKERS.find((w) => w.name === "memory")!.entry, readReal)).files).toContain(
      "src/core/runRecord.ts",
    );
  });
});

describe("lockfile workspace dependencies", () => {
  const rootLock = BASE_TREE["package-lock.json"];

  it("resolves a workspace's closure the way npm does — nested before hoisted, transitively, production edges only inside — and production-only leaves the toolchain out", () => {
    expect([
      ...workspaceDependencies(rootLock, "deploy/cloudflare-resident", { includeDev: false })!.entries(),
    ]).toEqual([
      ["node_modules/@cloudflare/sandbox", "0.13.0"],
      ["node_modules/@cloudflare/containers", "0.3.7"],
    ]);
    // The sandbox Worker's own SDK is nested (a different major), and so is its containers dep.
    expect([...workspaceDependencies(rootLock, "deploy/cloudflare-sandbox", { includeDev: false })!.entries()]).toEqual(
      [
        ["deploy/cloudflare-sandbox/node_modules/@cloudflare/sandbox", "0.3.7"],
        ["deploy/cloudflare-sandbox/node_modules/@cloudflare/containers", "0.0.28"],
      ],
    );
    expect([...workspaceDependencies(rootLock, "deploy/cloudflare-memory", { includeDev: false })!.keys()]).toEqual([]);
    // The bot image installs the root package's toolchain too.
    expect([...workspaceDependencies(rootLock, "", { includeDev: true })!.keys()]).toEqual([
      "node_modules/zod",
      "node_modules/vitest",
      "node_modules/typescript",
    ]);
    expect([...workspaceDependencies(rootLock, "", { includeDev: false })!.keys()]).toEqual(["node_modules/zod"]);
    // web: vue's installed peer is followed, its optional peer nobody installed is not; vite's bundled
    // rollup has no entry of its own and is NOT recorded as unresolved — vite's version tracks it.
    expect([...workspaceDependencies(rootLock, "web", { includeDev: true })!.entries()]).toEqual([
      ["node_modules/vue", "3.5.0"],
      ["node_modules/vite", "7.0.0"],
      ["node_modules/@vue/compiler-sfc", "3.5.0"],
    ]);
  });

  it("a devDependency bump is no production change; a production dependency moving, appearing or disappearing is a named change", () => {
    const before = workspaceDependencies(rootLock, "deploy/cloudflare-resident", { includeDev: false })!;
    const devBump = workspaceDependencies(
      lockWith({ "node_modules/wrangler": { version: "4.121.0", dev: true } }),
      "deploy/cloudflare-resident",
      { includeDev: false },
    )!;
    expect(prodDepsDiff(before, devBump)).toEqual([]);
    const moved = workspaceDependencies(
      lockWith({
        "deploy/cloudflare-resident": { dependencies: { "@cloudflare/sandbox": "0.14.0", "left-pad": "^1.0.0" } },
        "node_modules/@cloudflare/sandbox": { version: "0.14.0", dependencies: { "@cloudflare/containers": "^0.3.7" } },
        "node_modules/left-pad": { version: "1.0.0" },
      }),
      "deploy/cloudflare-resident",
      { includeDev: false },
    )!;
    expect(prodDepsDiff(before, moved)).toEqual(["@cloudflare/sandbox 0.13.0 → 0.14.0", "+ left-pad 1.0.0"]);
    expect(prodDepsDiff(moved, before)).toEqual(["@cloudflare/sandbox 0.14.0 → 0.13.0", "− left-pad"]);
    // A dependency named but absent from the lockfile is recorded as unresolved, never dropped.
    const dangling = workspaceDependencies(
      lockWith({ "deploy/cloudflare-memory": { dependencies: { ghost: "^1.0.0" } } }),
      "deploy/cloudflare-memory",
      { includeDev: false },
    )!;
    expect([...dangling.entries()]).toEqual([["deploy/cloudflare-memory/node_modules/ghost", "unresolved"]]);
  });

  it("an unreadable lockfile or an unknown workspace is not a dependency set — the caller treats it as a change (fail open)", () => {
    expect(workspaceDependencies(undefined, "", { includeDev: false })).toBeUndefined();
    expect(workspaceDependencies("not json", "", { includeDev: false })).toBeUndefined();
    expect(workspaceDependencies(JSON.stringify({ lockfileVersion: 3 }), "", { includeDev: false })).toBeUndefined();
    expect(workspaceDependencies(rootLock, "deploy/cloudflare-queue", { includeDev: false })).toBeUndefined();
  });

  it("the real root lockfile: every Worker's workspace resolves with nothing unresolved, and the resident's and the sandbox's closures each carry that Worker's own pinned SDK", () => {
    const real = readFileSync(join(REPO_ROOT, "package-lock.json"), "utf8");
    for (const w of WORKERS) {
      for (const { workspace, includeDev } of w.inputs.lockfile) {
        const closure = workspaceDependencies(real, workspace, { includeDev });
        // Bundled deps (tailwind's wasm runtime) and optional peers must not read as missing.
        expect(
          [...(closure ?? new Map()).entries()].filter(([, v]) => v === "unresolved"),
          `${w.name}: ${workspace || "root"} unresolved`,
        ).toEqual([]);
        expect(closure, `${w.name}: ${workspace || "root"}`).toBeDefined();
      }
    }
    for (const dir of ["deploy/cloudflare-resident", "deploy/cloudflare-sandbox"]) {
      const pinned = (
        JSON.parse(readFileSync(join(REPO_ROOT, dir, "package.json"), "utf8")) as {
          dependencies: Record<string, string>;
        }
      ).dependencies["@cloudflare/sandbox"];
      const closure = workspaceDependencies(real, dir, { includeDev: false })!;
      const sdk = [...closure.entries()].filter(([k]) => k.endsWith("node_modules/@cloudflare/sandbox"));
      expect(sdk, dir).toHaveLength(1);
      // An exact pin in package.json (no range operator) is the version the lockfile resolves.
      if (/^\d/.test(pinned)) expect(sdk[0][1], dir).toBe(pinned);
    }
  });
});

describe("package.json version bumps", () => {
  it("a diff that changes only `version` is inert — release-please bumps it on every release; any other field is a change", () => {
    const base = JSON.stringify({
      name: "switchboard",
      version: "0.1.0",
      dependencies: { zod: "^4.0.0" },
      devDependencies: { vitest: "^5.0.0" },
    });
    expect(
      packageJsonChangeKind(
        base,
        JSON.stringify({
          name: "switchboard",
          version: "0.2.0",
          dependencies: { zod: "^4.0.0" },
          devDependencies: { vitest: "^5.0.0" },
        }),
      ),
    ).toBe("inert-only");
    expect(
      packageJsonChangeKind(
        base,
        JSON.stringify({
          name: "switchboard",
          version: "0.2.0",
          dependencies: { zod: "^4.1.0" },
          devDependencies: { vitest: "^5.0.0" },
        }),
      ),
    ).toBe("changed");
    expect(
      packageJsonChangeKind(
        base,
        JSON.stringify({
          name: "switchboard",
          version: "0.1.0",
          scripts: { x: "y" },
          dependencies: { zod: "^4.0.0" },
          devDependencies: { vitest: "^5.0.0" },
        }),
      ),
    ).toBe("changed");
    // The root package.json: a devDependency IS the toolchain that builds the image's artifact — a change.
    expect(
      packageJsonChangeKind(
        base,
        JSON.stringify({
          name: "switchboard",
          version: "0.1.0",
          dependencies: { zod: "^4.0.0" },
          devDependencies: { vitest: "^5.1.0" },
        }),
      ),
    ).toBe("changed");
    expect(packageJsonChangeKind(base, base)).toBe("unchanged");
    expect(packageJsonChangeKind(undefined, base)).toBe("changed"); // a new file
    expect(packageJsonChangeKind(base, "{ broken")).toBe("changed"); // unparsable: fail open
  });

  it("a Worker's own package.json ignores devDependencies too — wrangler bundles production dependencies, the toolchain never enters the bundle", () => {
    const base = JSON.stringify({
      name: "resident",
      dependencies: { "@cloudflare/sandbox": "0.13.0" },
      devDependencies: { typescript: "^5.9.3", vitest: "^4.1.11" },
    });
    const toolchainBump = JSON.stringify({
      name: "resident",
      dependencies: { "@cloudflare/sandbox": "0.13.0" },
      devDependencies: { typescript: "^7.0.2", vitest: "^5.0.0" },
    });
    expect(packageJsonChangeKind(base, toolchainBump, { ignoreDevDependencies: true })).toBe("inert-only");
    expect(packageJsonChangeKind(base, toolchainBump)).toBe("changed");
    const prodBump = JSON.stringify({
      name: "resident",
      dependencies: { "@cloudflare/sandbox": "0.14.0" },
      devDependencies: { typescript: "^5.9.3", vitest: "^4.1.11" },
    });
    expect(packageJsonChangeKind(base, prodBump, { ignoreDevDependencies: true })).toBe("changed");
    const scriptChange = JSON.stringify({
      name: "resident",
      scripts: { deploy: "x" },
      dependencies: { "@cloudflare/sandbox": "0.13.0" },
      devDependencies: { typescript: "^5.9.3", vitest: "^4.1.11" },
    });
    expect(packageJsonChangeKind(base, scriptChange, { ignoreDevDependencies: true })).toBe("changed");
  });
});

describe("computeAffected", () => {
  it("nothing changed since what each Worker serves → every Worker is skipped, nothing selected", async () => {
    const { probe } = fakeProbe({
      trees: { [HEAD]: BASE_TREE, [LIVE]: BASE_TREE },
      live: allLive(LIVE),
      ancestors: [LIVE],
    });
    const r = await computeAffected(probe);
    expect(r.head).toBe(HEAD);
    expect(decisions(r)).toEqual({ memory: "skip", bot: "skip", resident: "skip", sandbox: "skip" });
    expect(r.selected).toEqual([]);
    expect(r.deployAll).toBe(false);
    expect(r.unclassified).toEqual([]);
    expect(r.workers[0]).toMatchObject({ name: "memory", base: { kind: "live", commit: LIVE }, reasons: [] });
    // A Worker already serving HEAD is trivially up to date — no diff is even taken.
    const atHead = fakeProbe({ trees: { [HEAD]: BASE_TREE }, live: allLive(HEAD) });
    expect(decisions(await computeAffected(atHead.probe))).toEqual({
      memory: "skip",
      bot: "skip",
      resident: "skip",
      sandbox: "skip",
    });
  });

  it("a shared src module changes only the Workers that import it, plus the bot whose image carries all of src/", async () => {
    const head = withChanges({
      "src/core/memory/scorer.ts": "export const tokenize = (s: string) => s.split(/\\s+/);\n",
    });
    const { probe } = fakeProbe({ trees: { [HEAD]: head, [LIVE]: BASE_TREE }, live: allLive(LIVE), ancestors: [LIVE] });
    const r = await computeAffected(probe);
    expect(decisions(r)).toEqual({ memory: "deploy", bot: "deploy", resident: "skip", sandbox: "skip" });
    expect(r.selected).toEqual(["memory", "bot"]);
    expect(r.workers.find((w) => w.name === "memory")!.reasons).toEqual([
      "src/core/memory/scorer.ts (imported by deploy/cloudflare-memory/worker.ts)",
    ]);
    expect(r.workers.find((w) => w.name === "bot")!.reasons).toEqual(["src/core/memory/scorer.ts"]);
    const disk = fakeProbe({
      trees: { [HEAD]: withChanges({ "src/execution/residentDisk.ts": "export const df = 2;\n" }), [LIVE]: BASE_TREE },
      live: allLive(LIVE),
      ancestors: [LIVE],
    });
    expect((await computeAffected(disk.probe)).selected).toEqual(["bot", "resident"]);
  });

  it("docs, specs and tests alone deploy nothing", async () => {
    const head = withChanges({
      "docs/how-to/x.md": "# y\n",
      "docs/reference/specs/execution.md": "# spec 2\n",
      "src/core/drain.test.ts": "test 2\n",
      ".github/workflows/ci.yml": "name: ci\n",
      "CHANGELOG.md": "## 0.2.0\n",
    });
    const { probe } = fakeProbe({ trees: { [HEAD]: head, [LIVE]: BASE_TREE }, live: allLive(LIVE), ancestors: [LIVE] });
    const r = await computeAffected(probe);
    expect(r.selected).toEqual([]);
    expect(r.deployAll).toBe(false);
    expect(r.workers.every((w) => w.reasons.length === 0)).toBe(true);
  });

  it("an unclassified path makes every Worker unsure → the whole fleet deploys, saying why", async () => {
    const head = withChanges({ "terraform/main.tf": "resource {}\n" });
    const { probe } = fakeProbe({ trees: { [HEAD]: head, [LIVE]: BASE_TREE }, live: allLive(LIVE), ancestors: [LIVE] });
    const r = await computeAffected(probe);
    expect(r.deployAll).toBe(true);
    expect(r.unclassified).toEqual(["terraform/main.tf"]);
    expect(r.selected).toEqual(["memory", "bot", "resident", "sandbox"]);
    for (const w of r.workers)
      expect(w.reasons, w.name).toEqual([
        "unsure: unclassified path terraform/main.tf — no rule claims it (src/deploy/affected.ts)",
      ]);
    expect(r.markdown).toContain("terraform/main.tf");
  });

  it("a Worker whose live commit cannot be read falls back to the last release tag; with no tag either it is deployed as unsure", async () => {
    const head = withChanges({ "deploy/cloudflare-sandbox/Dockerfile": "FROM docker.io/cloudflare/sandbox:0.3.8\n" });
    const { probe, probed } = fakeProbe({
      trees: { [HEAD]: head, [LIVE]: BASE_TREE, [TAG]: BASE_TREE },
      live: { memory: { commit: LIVE }, bot: { commit: LIVE }, resident: { commit: LIVE } }, // sandbox: 401 without its bearer
      ancestors: [LIVE, TAG],
      lastRelease: { tag: "v0.1.0", commit: TAG },
    });
    const r = await computeAffected(probe);
    expect(probed).toEqual(["memory", "bot", "resident", "sandbox"]);
    expect(r.workers.find((w) => w.name === "sandbox")).toMatchObject({
      decision: "deploy",
      base: { kind: "release", tag: "v0.1.0", commit: TAG },
      reasons: ["deploy/cloudflare-sandbox/Dockerfile"],
    });
    expect(r.selected).toEqual(["sandbox"]);
    // No tag either: unsure, and the reason carries both facts.
    const noTag = fakeProbe({
      trees: { [HEAD]: BASE_TREE, [LIVE]: BASE_TREE },
      live: { memory: { commit: LIVE }, bot: { commit: LIVE }, resident: { commit: LIVE } },
      ancestors: [LIVE],
    });
    const r2 = await computeAffected(noTag.probe);
    expect(r2.workers.find((w) => w.name === "sandbox")).toMatchObject({
      decision: "deploy",
      base: { kind: "none" },
      reasons: ["unsure: no base — /healthz: GET /healthz → HTTP 401; no release tag before HEAD"],
    });
    expect(r2.selected).toEqual(["sandbox"]);
    expect(r2.deployAll).toBe(false);
  });

  it("a live commit that is dirty, `unknown`, or not an ancestor of HEAD is never a base — the Worker is unsure (or falls back to the tag)", async () => {
    const stranger = sha("9");
    const { probe } = fakeProbe({
      trees: { [HEAD]: BASE_TREE, [LIVE]: BASE_TREE, [TAG]: BASE_TREE },
      live: {
        memory: { commit: `${LIVE}-dirty` },
        bot: { commit: "unknown" },
        resident: { commit: stranger },
        sandbox: { commit: LIVE },
      },
      ancestors: [LIVE, TAG],
    });
    const r = await computeAffected(probe);
    expect(r.workers.find((w) => w.name === "memory")).toMatchObject({
      decision: "deploy",
      base: { kind: "none", reason: `serving ${LIVE.slice(0, 7)}-dirty — a dirty build is not a commit` },
    });
    expect(r.workers.find((w) => w.name === "bot")).toMatchObject({
      decision: "deploy",
      base: { kind: "none", reason: 'serving commit "unknown" — the image was built without a stamp' },
    });
    expect(r.workers.find((w) => w.name === "resident")).toMatchObject({
      decision: "deploy",
      base: {
        kind: "none",
        reason: `live commit ${stranger.slice(0, 7)} is not an ancestor of HEAD ${HEAD.slice(0, 7)}`,
      },
    });
    expect(r.workers.find((w) => w.name === "sandbox")).toMatchObject({
      decision: "skip",
      base: { kind: "live", commit: LIVE },
    });
    expect(r.selected).toEqual(["memory", "bot", "resident"]);
    expect(r.deployAll).toBe(false);
    // With a release tag the same three fall back to it instead of guessing.
    const tagged = fakeProbe({
      trees: { [HEAD]: BASE_TREE, [LIVE]: BASE_TREE, [TAG]: BASE_TREE },
      live: { memory: { commit: "unknown" } },
      ancestors: [LIVE, TAG],
      lastRelease: { tag: "v0.1.0", commit: TAG },
    });
    expect((await computeAffected(tagged.probe)).workers.find((w) => w.name === "memory")).toMatchObject({
      decision: "skip",
      base: { kind: "release", tag: "v0.1.0" },
    });
  });

  it("the resident Dockerfile, wrangler config and its SDK moving in the root lockfile reach only the resident — not the bot, not the sandbox's nested copy; a devDependency bump in its workspace reaches nothing", async () => {
    const prodBump = withChanges({
      "deploy/cloudflare-resident/package.json": JSON.stringify({
        name: "resident",
        dependencies: { "@cloudflare/sandbox": "0.14.0" },
      }),
      "package-lock.json": lockWith({
        "deploy/cloudflare-resident": {
          dependencies: { "@cloudflare/sandbox": "0.14.0" },
          devDependencies: { wrangler: "^4.120.1" },
        },
        "node_modules/@cloudflare/sandbox": { version: "0.14.0", dependencies: { "@cloudflare/containers": "^0.3.7" } },
      }),
    });
    const a = await computeAffected(
      fakeProbe({ trees: { [HEAD]: prodBump, [LIVE]: BASE_TREE }, live: allLive(LIVE), ancestors: [LIVE] }).probe,
    );
    expect(a.selected).toEqual(["resident"]);
    expect(a.workers.find((w) => w.name === "resident")!.reasons).toEqual([
      "deploy/cloudflare-resident/package.json",
      "package-lock.json: production dependencies of deploy/cloudflare-resident changed — @cloudflare/sandbox 0.13.0 → 0.14.0",
    ]);

    // The resident workspace's wrangler (a devDependency) moves: no bundle changes anywhere.
    const devBump = withChanges({
      "deploy/cloudflare-resident/package.json": JSON.stringify({
        name: "resident",
        dependencies: { "@cloudflare/sandbox": "0.13.0" },
        devDependencies: { wrangler: "^4.121.0" },
      }),
      "package-lock.json": lockWith({
        "deploy/cloudflare-resident": {
          dependencies: { "@cloudflare/sandbox": "0.13.0" },
          devDependencies: { wrangler: "^4.121.0" },
        },
        "node_modules/wrangler": { version: "4.121.0", dev: true },
      }),
    });
    const b = await computeAffected(
      fakeProbe({ trees: { [HEAD]: devBump, [LIVE]: BASE_TREE }, live: allLive(LIVE), ancestors: [LIVE] }).probe,
    );
    expect(b.selected).toEqual([]);
    expect(b.unclassified).toEqual([]);

    const image = withChanges({
      "deploy/cloudflare-resident/Dockerfile": "FROM docker.io/cloudflare/sandbox:0.13.1\n",
      "deploy/cloudflare-resident/wrangler.jsonc": '{ "name": "switchboard-resident", "x": 1 }',
    });
    const c = await computeAffected(
      fakeProbe({ trees: { [HEAD]: image, [LIVE]: BASE_TREE }, live: allLive(LIVE), ancestors: [LIVE] }).probe,
    );
    expect(c.selected).toEqual(["resident"]);
    expect(c.workers.find((w) => w.name === "resident")!.reasons).toEqual([
      "deploy/cloudflare-resident/Dockerfile",
      "deploy/cloudflare-resident/wrangler.jsonc",
    ]);
  });

  it("the bot's own version-only package.json bump (release-please) is inert; a dependency change or a root lockfile change is a bot input", async () => {
    const release = withChanges({
      "package.json": JSON.stringify({ name: "switchboard", version: "0.2.0", dependencies: { zod: "^4.0.0" } }),
      "web/package.json": JSON.stringify({ name: "web", version: "0.2.0" }),
      "CHANGELOG.md": "## 0.2.0\n",
      ".release-please-manifest.json": '{".": "0.2.0"}',
    });
    const a = await computeAffected(
      fakeProbe({ trees: { [HEAD]: release, [LIVE]: BASE_TREE }, live: allLive(LIVE), ancestors: [LIVE] }).probe,
    );
    expect(a.selected).toEqual([]);
    expect(a.deployAll).toBe(false);

    const dep = withChanges({
      "package.json": JSON.stringify({ name: "switchboard", version: "0.2.0", dependencies: { zod: "^4.1.0" } }),
    });
    const b = await computeAffected(
      fakeProbe({ trees: { [HEAD]: dep, [LIVE]: BASE_TREE }, live: allLive(LIVE), ancestors: [LIVE] }).probe,
    );
    expect(b.selected).toEqual(["bot"]);
    expect(b.workers.find((w) => w.name === "bot")!.reasons).toEqual(["package.json"]);
    // The root package's toolchain (tsc, vite, vitest) is installed into the image build: a bump is a bot input.
    const toolchain = withChanges({
      "package-lock.json": lockWith({ "node_modules/vitest": { version: "5.1.0", dev: true } }),
    });
    const c = await computeAffected(
      fakeProbe({ trees: { [HEAD]: toolchain, [LIVE]: BASE_TREE }, live: allLive(LIVE), ancestors: [LIVE] }).probe,
    );
    expect(c.selected).toEqual(["bot"]);
    expect(c.workers.find((w) => w.name === "bot")!.reasons).toEqual([
      "package-lock.json: dependencies of the root package changed — vitest 5.0.0 → 5.1.0",
    ]);
    // web's build tool moves: the image rebuilds web/dist with it.
    const vite = withChanges({
      "package-lock.json": lockWith({ "node_modules/vite": { version: "7.1.0", dev: true } }),
    });
    const d = await computeAffected(
      fakeProbe({ trees: { [HEAD]: vite, [LIVE]: BASE_TREE }, live: allLive(LIVE), ancestors: [LIVE] }).probe,
    );
    expect(d.workers.find((w) => w.name === "bot")!.reasons).toEqual([
      "package-lock.json: dependencies of web changed — vite 7.0.0 → 7.1.0",
    ]);
    // The shim's wrangler (a devDependency of deploy/cloudflare) moving is nobody's input.
    const shimTool = withChanges({
      "package-lock.json": lockWith({ "node_modules/wrangler": { version: "4.121.0", dev: true } }),
    });
    const e = await computeAffected(
      fakeProbe({ trees: { [HEAD]: shimTool, [LIVE]: BASE_TREE }, live: allLive(LIVE), ancestors: [LIVE] }).probe,
    );
    expect(e.selected).toEqual([]);
  });

  it("an unresolvable import in a Worker's closure makes that Worker unsure, whatever changed", async () => {
    const head = withChanges({
      "src/core/memory/engine.ts": 'import { gone } from "./vanished.js";\nexport const rank = gone;\n',
    });
    const r = await computeAffected(
      fakeProbe({ trees: { [HEAD]: head, [LIVE]: BASE_TREE }, live: allLive(LIVE), ancestors: [LIVE] }).probe,
    );
    expect(r.workers.find((w) => w.name === "memory")!.reasons).toContain(
      "unsure: import ./vanished.js from src/core/memory/engine.ts resolves to no file",
    );
    expect(r.selected).toEqual(["memory", "bot"]); // the bot: src/ changed
  });

  it("a failed diff is unsure, never an empty diff — a base that is not in the checkout deploys, and says so", async () => {
    const { probe } = fakeProbe({
      trees: { [HEAD]: BASE_TREE, [LIVE]: BASE_TREE },
      live: allLive(LIVE),
      ancestors: [LIVE],
    });
    const failing: AffectedProbe = { ...probe, changedPaths: async () => undefined };
    const r = await computeAffected(failing, { base: "v9.9.9" });
    expect(r.selected).toEqual(["memory", "bot", "resident", "sandbox"]);
    for (const w of r.workers)
      expect(w.reasons, w.name).toEqual(["unsure: git diff v9.9.9..HEAD failed — is the base in this checkout?"]);
    // A 40-char base is shortened in the reason; a live base that cannot be diffed is unsure too.
    const live = await computeAffected({ ...probe, changedPaths: async () => undefined });
    expect(live.workers[0].reasons).toEqual([
      `unsure: git diff ${LIVE.slice(0, 7)}..HEAD failed — is the base in this checkout?`,
    ]);
    expect(live.deployAll).toBe(false); // unsure per Worker, not an unclassified path
  });

  it("no readable HEAD (not a git checkout) makes every Worker unsure before anything is probed or diffed", async () => {
    const { probe, probed } = fakeProbe({ trees: { [HEAD]: BASE_TREE }, live: allLive(HEAD) });
    const r = await computeAffected({ ...probe, head: async () => "" });
    expect(probed).toEqual([]);
    expect(r.selected).toEqual(["memory", "bot", "resident", "sandbox"]);
    expect(r.workers[0]).toMatchObject({
      base: { kind: "none", reason: 'HEAD could not be read ("") — not a git checkout?' },
      reasons: ['unsure: HEAD could not be read ("") — not a git checkout?'],
    });
  });

  it("--base overrides every Worker's base and probes no Worker", async () => {
    const head = withChanges({ "src/execution/shellQuote.ts": "export const shellQuote = (s: string) => `'${s}'`;\n" });
    const { probe, probed } = fakeProbe({
      trees: { [HEAD]: head, [OLDER]: BASE_TREE },
      live: allLive(HEAD),
      ancestors: [OLDER],
    });
    const r = await computeAffected(probe, { base: OLDER });
    expect(probed).toEqual([]);
    expect(r.workers.every((w) => w.base.kind === "ref" && w.base.ref === OLDER)).toBe(true);
    expect(r.selected).toEqual(["bot", "sandbox"]);
    expect(r.workers.find((w) => w.name === "sandbox")!.reasons).toEqual([
      "src/execution/shellQuote.ts (imported by deploy/cloudflare-sandbox/worker.ts)",
    ]);
  });

  it("the markdown summary names each Worker's decision, base and reasons, and the selection in deploy order", async () => {
    const head = withChanges({
      "src/core/memory/scorer.ts": "export const tokenize = (s: string) => s.split(/\\s+/);\n",
      "deploy/cloudflare-sandbox/Dockerfile": "FROM x\n",
    });
    const { probe } = fakeProbe({
      trees: { [HEAD]: head, [LIVE]: BASE_TREE, [TAG]: BASE_TREE },
      live: { memory: { commit: LIVE }, bot: { commit: LIVE }, resident: { commit: LIVE } },
      ancestors: [LIVE, TAG],
      lastRelease: { tag: "v0.1.0", commit: TAG },
    });
    const r = await computeAffected(probe);
    const md = formatAffectedMarkdown(r);
    expect(r.markdown).toBe(md);
    expect(md).toContain(`Deploy targets for ${HEAD.slice(0, 7)}: **3 of 4 Workers** — memory, bot, sandbox`);
    expect(md).toContain("| Worker | Decision | Judged against | Why |");
    expect(md).toContain(
      `| memory | **deploy** | live \`${LIVE.slice(0, 7)}\` | \`src/core/memory/scorer.ts\` (imported by \`deploy/cloudflare-memory/worker.ts\`) |`,
    );
    expect(md).toContain(`| bot | **deploy** | live \`${LIVE.slice(0, 7)}\` | \`src/core/memory/scorer.ts\` |`);
    expect(md).toContain(`| resident | skip | live \`${LIVE.slice(0, 7)}\` | no input changed |`);
    expect(md).toContain("| sandbox | **deploy** | release `v0.1.0` | `deploy/cloudflare-sandbox/Dockerfile` |");
    expect(md).toContain("Unclassified paths: none");
    expect(md.indexOf("| memory |")).toBeLessThan(md.indexOf("| bot |"));
    // Many reasons are capped, with the count.
    const many = Object.fromEntries(
      Array.from({ length: 12 }, (_, i) => [`src/m${i}.ts`, `export const m${i} = ${i};\n`]),
    );
    const big = await computeAffected(
      fakeProbe({ trees: { [HEAD]: withChanges(many), [LIVE]: BASE_TREE }, live: allLive(LIVE), ancestors: [LIVE] })
        .probe,
    );
    expect(big.workers.find((w) => w.name === "bot")!.reasons).toHaveLength(12);
    expect(big.markdown).toContain("… +4 more");
    const none = await computeAffected(
      fakeProbe({ trees: { [HEAD]: BASE_TREE, [LIVE]: BASE_TREE }, live: allLive(LIVE), ancestors: [LIVE] }).probe,
    );
    expect(none.markdown).toContain("**nothing to deploy** — every Worker already serves this tree's inputs");
  });
});
