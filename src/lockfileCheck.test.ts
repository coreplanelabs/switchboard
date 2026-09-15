import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  MIRRORED_FIELDS,
  REQUIRED_VARIANTS,
  manifestDrift,
  missingVariants,
  recordsToMirror,
  resolutionProblems,
  resolveDependency,
} from "../scripts/check-lockfile.mjs";

// The lockfile gate's decision, and the repository's own lockfile against it.
// npm records only the current machine's optional platform package when
// `npm install` runs with node_modules present; the first workspace lockfile
// was cut that way on a macOS laptop and every Linux consumer (CI, the Docker
// image) failed at rollup and lightningcss with MODULE_NOT_FOUND. The gate
// turns that into a local, deterministic failure with the fix in its message.

describe("check-lockfile missingVariants", () => {
  it("passes when every native family present records the required variants", () => {
    const paths = [
      "node_modules/rollup",
      "node_modules/@rollup/rollup-linux-x64-gnu",
      "node_modules/@rollup/rollup-darwin-arm64",
      "node_modules/@rollup/rollup-win32-x64-msvc",
      "node_modules/zod",
    ];
    expect(missingVariants(paths)).toEqual([]);
  });

  it("names each missing variant of a family that is present", () => {
    const paths = ["node_modules/rollup", "node_modules/@rollup/rollup-darwin-arm64"];
    expect(missingVariants(paths)).toEqual([{ family: "@rollup/rollup-", variant: "@rollup/rollup-linux-x64-gnu" }]);
  });

  it("ignores families that are not in the tree at all", () => {
    expect(missingVariants(["node_modules/zod", "node_modules/yaml"])).toEqual([]);
  });

  it("handles nested workspace paths", () => {
    const paths = ["web/node_modules/lightningcss-darwin-arm64", "node_modules/lightningcss-linux-x64-gnu"];
    expect(missingVariants(paths)).toEqual([]);
  });

  it("requires Linux x64 (CI and the image) and macOS arm64 (the laptops) for every family", () => {
    for (const variants of Object.values(REQUIRED_VARIANTS)) {
      expect(variants.some((v) => v.startsWith("linux-x64"))).toBe(true);
      expect(variants).toContain("darwin-arm64");
    }
  });
});

// The second gate: a lockfile whose package record no longer mirrors its
// manifest. npm then rebuilds the tree from the ranges instead of trusting the
// lock, and the day a dependency publishes inside a declared range, `npm ci`
// fails on every branch at once. The first time it happened a `bin` had been
// added to package.json without regenerating the lockfile.
describe("check-lockfile manifestDrift", () => {
  const manifest = {
    name: "switchboard",
    version: "1.13.0",
    license: "Apache-2.0",
    bin: { switchboard: "dist/cli.js" },
    workspaces: ["web", "docs"],
    dependencies: { zod: "^4.5.4", yaml: "^2.7.0" },
    devDependencies: { vitest: "^5.0.0" },
    engines: { node: ">=22" },
  };

  it("passes when the record mirrors the manifest", () => {
    expect(manifestDrift(manifest, { ...manifest })).toEqual([]);
  });

  it("names a bin the manifest declares and the record lacks", () => {
    const { bin: _bin, ...record } = manifest;
    expect(manifestDrift(manifest, record)).toEqual([
      { field: "bin", manifest: { switchboard: "dist/cli.js" }, lockfile: undefined },
    ]);
  });

  it("names a dependency range that moved in the manifest but not in the record", () => {
    const record = { ...manifest, dependencies: { zod: "^4.5.0", yaml: "^2.7.0" } };
    expect(manifestDrift(manifest, record)).toEqual([
      { field: "dependencies", manifest: manifest.dependencies, lockfile: record.dependencies },
    ]);
  });

  it("names a workspace added to the manifest and not to the record", () => {
    const record = { ...manifest, workspaces: ["web"] };
    expect(manifestDrift(manifest, record).map((d) => d.field)).toEqual(["workspaces"]);
  });

  it("compares the fields npm mirrors and ignores the ones it does not", () => {
    expect(MIRRORED_FIELDS).toEqual([
      "name",
      "version",
      "bin",
      "workspaces",
      "dependencies",
      "devDependencies",
      "optionalDependencies",
      "peerDependencies",
    ]);
    const record = { ...manifest, license: "MIT", engines: { node: ">=20" }, extra: true };
    expect(manifestDrift(manifest, record)).toEqual([]);
  });

  it("reads a manifest's shorthand the way npm records it: a bin string, a workspaces object, an absent map", () => {
    const shorthand = {
      name: "tool",
      version: "1.0.0",
      bin: "dist/cli.js",
      workspaces: { packages: ["web"] },
      dependencies: {},
    };
    const record = { name: "tool", version: "1.0.0", bin: { tool: "dist/cli.js" }, workspaces: ["web"] };
    expect(manifestDrift(shorthand, record)).toEqual([]);
  });

  it("treats a missing record as drift in every mirrored field the manifest has", () => {
    const drift = manifestDrift({ name: "web", version: "0.0.0", dependencies: { vue: "^3" } }, undefined);
    expect(drift.map((d) => d.field)).toEqual(["name", "version", "dependencies"]);
  });
});

describe("check-lockfile recordsToMirror", () => {
  it("pairs the root manifest and each workspace manifest with its lockfile record", () => {
    const root = { name: "r", version: "1.0.0", workspaces: ["web", "deploy/x"] };
    const lock = { packages: { "": { name: "r" }, web: { name: "web" }, "node_modules/zod": {} } };
    const manifests = new Map([
      ["web", { name: "web", version: "0.0.0" }],
      ["deploy/x", { name: "x", version: "0.0.0" }],
    ]);
    expect(recordsToMirror(root, lock, (dir) => manifests.get(dir))).toEqual([
      { path: "package.json", manifest: root, record: lock.packages[""] },
      { path: "web/package.json", manifest: manifests.get("web"), record: lock.packages.web },
      { path: "deploy/x/package.json", manifest: manifests.get("deploy/x"), record: undefined },
    ]);
  });
});

// The third gate: every edge the lock declares must be satisfied by the record
// npm resolves for it, and every fetched record must be pinned. The lock had
// carried `web/node_modules/@types/node` at 26.5.0 — against `web`'s own
// `^24.0.0`, with no `resolved`/`integrity` — since the scaffold. npm treated
// the edge as invalid and re-resolved the range against the registry on every
// install; the day `@types/node` published a new 24.x, `npm ci` on every cold
// runner refused the lock. `npm ls --omit=dev` never looked at it: the entry
// was a devDependency of a workspace.
describe("check-lockfile resolutionProblems", () => {
  const pinned = (version: string, more: Record<string, unknown> = {}) => ({
    version,
    resolved: `https://registry.npmjs.org/x/-/x-${version}.tgz`,
    integrity: `sha512-${version}`,
    ...more,
  });
  const valid = {
    packages: {
      "": {
        name: "r",
        version: "1.0.0",
        workspaces: ["web"],
        dependencies: { a: "^1.0.0", aliased: "npm:b@^3.0.0", "git-dep": "github:o/r#main" },
        devDependencies: { "@types/node": "^24.0.0", web: "^0.0.0" },
      },
      web: { name: "web", version: "0.0.0", devDependencies: { "@types/node": "^24.0.0", vitest: "^4.1.11" } },
      "node_modules/web": { resolved: "web", link: true },
      "node_modules/a": pinned("1.2.0", {
        dependencies: { b: "^2.0.0", c: "^1.0.0", bundled: "^1.0.0" },
        optionalDependencies: { c: "^1.0.0" },
        peerDependencies: { p: "^9.0.0" },
        bundleDependencies: ["bundled"],
      }),
      "node_modules/a/node_modules/b": pinned("2.5.0"),
      "node_modules/b": pinned("3.0.0"),
      "node_modules/aliased": pinned("3.1.0", { name: "b" }),
      "node_modules/git-dep": { version: "0.1.0", resolved: "git+ssh://git@github.com/o/r.git#abc" },
      "node_modules/@types/node": pinned("24.13.4", { dependencies: { "undici-types": "~7.18.0" } }),
      "node_modules/undici-types": pinned("7.18.2"),
      "node_modules/vitest": pinned("5.0.0"),
      "web/node_modules/vitest": pinned("4.1.11"),
    },
  };

  it("resolves nested before hoisted, walking up from the dependant, and follows a workspace link", () => {
    expect(resolveDependency(valid.packages, "node_modules/a", "b")).toEqual({
      path: "node_modules/a/node_modules/b",
      record: valid.packages["node_modules/a/node_modules/b"],
    });
    expect(resolveDependency(valid.packages, "node_modules/a/node_modules/b", "undici-types")).toEqual({
      path: "node_modules/undici-types",
      record: valid.packages["node_modules/undici-types"],
    });
    expect(resolveDependency(valid.packages, "web", "vitest")?.path).toBe("web/node_modules/vitest");
    expect(resolveDependency(valid.packages, "web", "@types/node")?.path).toBe("node_modules/@types/node");
    expect(resolveDependency(valid.packages, "", "web")).toEqual({ path: "web", record: valid.packages.web });
    expect(resolveDependency(valid.packages, "node_modules/a", "nope")).toBeUndefined();
  });

  it("passes a lock whose every edge is satisfied by what npm resolves — bundled, optional-missing, peer-missing, alias and non-semver specs included", () => {
    expect(resolutionProblems(valid)).toEqual([]);
  });

  it("names the defect that motivated the gate: a nested copy that violates its dependant's range, and the unpinned records beside it", () => {
    const broken = {
      packages: {
        ...valid.packages,
        "web/node_modules/@types/node": { version: "26.5.0", dev: true, dependencies: { "undici-types": "~8.9.0" } },
        "web/node_modules/undici-types": { version: "8.9.0", dev: true },
      },
    };
    expect(resolutionProblems(broken)).toEqual([
      {
        kind: "unsatisfied",
        from: "web",
        field: "devDependencies",
        name: "@types/node",
        spec: "^24.0.0",
        at: "web/node_modules/@types/node",
        version: "26.5.0",
      },
      { kind: "unpinned", at: "web/node_modules/@types/node", version: "26.5.0" },
      { kind: "unpinned", at: "web/node_modules/undici-types", version: "8.9.0" },
    ]);
  });

  it("names a hoisted record that drifted out of the root's range, a required dependency nothing resolves, and an alias whose target misses its range", () => {
    const drifted = {
      packages: {
        ...valid.packages,
        "node_modules/a": {
          ...valid.packages["node_modules/a"],
          version: "2.0.0",
          dependencies: { b: "^2.0.0", d: "^1.0.0" },
        },
        "node_modules/aliased": pinned("2.9.0", { name: "b" }),
      },
    };
    expect(resolutionProblems(drifted)).toEqual([
      {
        kind: "unsatisfied",
        from: "",
        field: "dependencies",
        name: "a",
        spec: "^1.0.0",
        at: "node_modules/a",
        version: "2.0.0",
      },
      {
        kind: "unsatisfied",
        from: "",
        field: "dependencies",
        name: "aliased",
        spec: "npm:b@^3.0.0",
        at: "node_modules/aliased",
        version: "2.9.0",
      },
      { kind: "missing", from: "node_modules/a", field: "dependencies", name: "d", spec: "^1.0.0" },
    ]);
  });

  it("does not report a workspace record, a link or a bundled copy as unpinned — only a fetched package without resolved and integrity", () => {
    const withBundled = {
      packages: {
        ...valid.packages,
        "node_modules/a/node_modules/bundled": { version: "1.0.0", inBundle: true },
      },
    };
    expect(resolutionProblems(withBundled)).toEqual([]);
  });

  it("a record bundling everything (`bundleDependencies: true`) has no edges to judge; a record with a resolved URL and no integrity passes, a record with neither is unpinned", () => {
    const bundlesAll = {
      packages: {
        ...valid.packages,
        "node_modules/a": {
          ...valid.packages["node_modules/a"],
          bundleDependencies: true,
          dependencies: { b: "^2.0.0", zz: "^1.0.0" },
        },
      },
    };
    expect(resolutionProblems(bundlesAll)).toEqual([]);
    // npm's own shape for a nested duplicate of a package it already fetched: the URL, no integrity of its own.
    const urlOnly = {
      packages: {
        ...valid.packages,
        "node_modules/b": { version: "3.0.0", resolved: "https://registry.npmjs.org/b/-/b-3.0.0.tgz" },
      },
    };
    expect(resolutionProblems(urlOnly)).toEqual([]);
    const versionOnly = {
      packages: { ...valid.packages, "node_modules/b": { version: "3.0.0", integrity: "sha512-3.0.0" } },
    };
    expect(resolutionProblems(versionOnly)).toEqual([{ kind: "unpinned", at: "node_modules/b", version: "3.0.0" }]);
  });
});

describe("the repository's package-lock.json", () => {
  const root = fileURLToPath(new URL("..", import.meta.url));
  const readJson = (rel: string) => JSON.parse(readFileSync(new URL(rel, `file://${root}`), "utf8"));
  const lock = readJson("package-lock.json") as { packages: Record<string, Record<string, unknown>> };

  it("records every required platform variant", () => {
    expect(missingVariants(Object.keys(lock.packages))).toEqual([]);
  });

  it("has every declared edge satisfied by the record npm resolves for it, and every fetched record pinned", () => {
    expect(resolutionProblems(lock)).toEqual([]);
  });

  it("mirrors package.json and every workspace's package.json in its records", () => {
    const manifest = readJson("package.json") as Record<string, unknown>;
    for (const pair of recordsToMirror(manifest, lock, (dir) => readJson(`${dir}/package.json`))) {
      expect(manifestDrift(pair.manifest, pair.record), pair.path).toEqual([]);
    }
  });
});
