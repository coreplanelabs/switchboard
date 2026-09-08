import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// Feature: docs/reference/specs/packaging.md item 5 — one version for the
// repository and the npm package, moved by one release PR. release-please's one
// component (".") bumps the root manifest and lockfile itself; the package's
// manifest and the lockfile's entry for it ride along as extra files (the
// lockfile records each workspace's version; left behind, the next `npm
// install` rewrites it and dirties the tree), and the three copies are held
// equal here so a release that moved one and not the others fails the suite.

const root = fileURLToPath(new URL("..", import.meta.url));
const read = (p: string) => readFileSync(new URL(p, `file://${root}`), "utf8");

const PACKAGE_DIR = "packages/switchboard";
const MANIFEST = `${PACKAGE_DIR}/package.json`;

describe("the package's version is the repository's", () => {
  const rootVersion = (JSON.parse(read("package.json")) as { version: string }).version;

  it("packages/switchboard/package.json carries the root's version", () => {
    expect((JSON.parse(read(MANIFEST)) as { version: string }).version).toBe(rootVersion);
  });

  it("the lockfile's entry for the workspace carries it too — left behind, the next `npm install` rewrites it", () => {
    const lock = JSON.parse(read("package-lock.json")) as { packages: Record<string, { version?: string }> };
    expect(lock.packages[PACKAGE_DIR]?.version).toBe(rootVersion);
  });

  it("release-please moves all three from its one component: the root by the node strategy, the package manifest and the lockfile entry as extra files", () => {
    const config = JSON.parse(read("release-please-config.json")) as {
      packages: Record<string, { "extra-files"?: unknown[] }>;
      "include-component-in-tag": boolean;
    };
    expect(Object.keys(config.packages)).toEqual(["."]);
    expect(config["include-component-in-tag"]).toBe(false);
    const extras = config.packages["."]["extra-files"] ?? [];
    expect(extras).toContain(MANIFEST);
    expect(extras).toContainEqual({
      type: "json",
      path: "package-lock.json",
      jsonpath: `$.packages['${PACKAGE_DIR}'].version`,
    });
  });
});
