import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  MIRRORED_FIELDS,
  REQUIRED_VARIANTS,
  manifestDrift,
  missingVariants,
  recordsToMirror,
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

describe("the repository's package-lock.json", () => {
  const root = fileURLToPath(new URL("..", import.meta.url));
  const readJson = (rel: string) => JSON.parse(readFileSync(new URL(rel, `file://${root}`), "utf8"));
  const lock = readJson("package-lock.json") as { packages: Record<string, Record<string, unknown>> };

  it("records every required platform variant", () => {
    expect(missingVariants(Object.keys(lock.packages))).toEqual([]);
  });

  it("mirrors package.json and every workspace's package.json in its records", () => {
    const manifest = readJson("package.json") as Record<string, unknown>;
    for (const pair of recordsToMirror(manifest, lock, (dir) => readJson(`${dir}/package.json`))) {
      expect(manifestDrift(pair.manifest, pair.record), pair.path).toEqual([]);
    }
  });
});
