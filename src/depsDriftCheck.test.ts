import { describe, expect, it } from "vitest";
import {
  evaluateDepsDrift,
  expectedPackagePaths,
  extraneousEntries,
  nodeModulesRoots,
} from "../scripts/deps-drift-check.mjs";

// The drift gate's pure halves. The shape that forced it: a resident tree
// carried the top-level node_modules but not the nested
// deploy/cloudflare-memory/node_modules the lockfile mandates, so the
// miniflare hoisted for its dependent read as extraneous and `npm ls
// --omit=dev` attributed its LGPL sharp subtree to production — a
// licenses:check failure a clean `npm ci` of the same commit passed. This
// check names the drift itself: missing lockfile paths and entries the
// lockfile does not know.

describe("deps-drift expectedPackagePaths", () => {
  it("keeps every installed package path, skips the project and workspace roots, skips optional (platform-gated) packages", () => {
    const packages = {
      "": {},
      web: {},
      "node_modules/vue": {},
      "node_modules/@img/sharp-libvips-linux-x64": { optional: true },
      "node_modules/fsevents": { devOptional: true },
      "deploy/cloudflare-memory/node_modules/@cloudflare/vitest-pool-workers": {},
      "node_modules/wrangler/node_modules/miniflare": {},
    };
    expect(expectedPackagePaths(packages)).toEqual([
      "deploy/cloudflare-memory/node_modules/@cloudflare/vitest-pool-workers",
      "node_modules/vue",
      "node_modules/wrangler/node_modules/miniflare",
    ]);
  });
});

describe("deps-drift nodeModulesRoots", () => {
  it("derives every node_modules directory the lockfile speaks for: the root's, each nested one on a key, and one per workspace dir (a stale workspace tree is still judged)", () => {
    const packages = {
      "": {},
      web: {},
      "deploy/cloudflare-memory": {},
      "node_modules/vue": {},
      "deploy/cloudflare-memory/node_modules/@cloudflare/vitest-pool-workers": {},
      "node_modules/wrangler/node_modules/miniflare": {},
    };
    expect(nodeModulesRoots(packages)).toEqual([
      "deploy/cloudflare-memory/node_modules",
      "node_modules",
      "node_modules/wrangler/node_modules",
      "web/node_modules",
    ]);
  });
});

describe("deps-drift extraneousEntries", () => {
  it("an entry the lockfile does not know is extraneous; dot entries (tool-managed: .bin, .package-lock.json, .cache) never are; scoped entries are judged by their full name", () => {
    const packages = {
      "node_modules/vue": {},
      "node_modules/@vue/shared": {},
    };
    expect(
      extraneousEntries(
        "node_modules",
        ["vue", "@vue/shared", "@vue/.cache", ".bin", ".package-lock.json", "miniflare"],
        packages,
      ),
    ).toEqual(["node_modules/miniflare"]);
  });
});

describe("deps-drift evaluateDepsDrift", () => {
  const packages = {
    "": {},
    "deploy/cloudflare-memory": {},
    "node_modules/miniflare": {},
    "node_modules/@img/sharp-libvips-darwin-arm64": { optional: true },
    "deploy/cloudflare-memory/node_modules/@cloudflare/vitest-pool-workers": {},
  };

  it("a clean tree passes: every non-optional path present, every entry known", () => {
    const disk = {
      exists: () => true,
      list: (root: string) =>
        root === "node_modules"
          ? ["miniflare"]
          : root === "deploy/cloudflare-memory/node_modules"
            ? ["@cloudflare/vitest-pool-workers"]
            : null,
    };
    expect(evaluateDepsDrift(packages, disk)).toEqual({ missing: [], extraneous: [], checked: 2 });
  });

  it("the incident's shape is named: the nested workspace node_modules is missing while its hoisted dependent sits at the root", () => {
    const disk = {
      exists: (path: string) => path === "node_modules/miniflare",
      list: (root: string) => (root === "node_modules" ? ["miniflare"] : null),
    };
    expect(evaluateDepsDrift(packages, disk).missing).toEqual([
      "deploy/cloudflare-memory/node_modules/@cloudflare/vitest-pool-workers",
    ]);
  });

  it("a stale store entry surviving a lockfile change is named as extraneous", () => {
    const disk = {
      exists: () => true,
      list: (root: string) => (root === "node_modules" ? ["miniflare", "left-behind"] : null),
    };
    expect(evaluateDepsDrift(packages, disk).extraneous).toEqual(["node_modules/left-behind"]);
  });

  it("an absent optional (platform-gated) package is never missing", () => {
    const disk = {
      exists: (path: string) => !path.includes("darwin"),
      list: () => null,
    };
    expect(evaluateDepsDrift(packages, disk).missing).toEqual([]);
  });
});
