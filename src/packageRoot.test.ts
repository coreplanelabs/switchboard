import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { locatePackageRoot, PACKAGE_ROOT, PACKAGE_ROOT_MARKER, RUNS_FROM_PUBLISHED_PACKAGE } from "./packageRoot.js";

// Feature: docs/reference/specs/packaging.md — one resolver finds the files the
// CLI ships with (the examples, the Worker templates, project.json): the
// published package's `dist/assets/` when it is there, else the tree the module
// runs from — a checkout or the image's /app.

let dir: string | undefined;
afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = undefined;
});
const tmp = () => (dir = realpathSync(mkdtempSync(join(tmpdir(), "swb-root-"))));
const marker = (at: string) => {
  mkdirSync(at, { recursive: true });
  writeFileSync(join(at, PACKAGE_ROOT_MARKER), "{}\n");
};

describe("locatePackageRoot", () => {
  it("prefers `assets/` beside the module when it carries the marker — the published package's dist/cli.js", () => {
    const pkg = tmp();
    marker(join(pkg, "dist", "assets"));
    // The marker above the package (the checkout `npm pack` ran in) must not win over the shipped assets.
    marker(pkg);
    expect(locatePackageRoot(join(pkg, "dist"))).toEqual({ root: join(pkg, "dist", "assets"), kind: "assets" });
  });

  it("falls back to the nearest ancestor carrying the marker — src/setup/ or dist/setup/ two levels under a checkout, or the image's /app", () => {
    const repo = tmp();
    marker(repo);
    mkdirSync(join(repo, "src", "setup"), { recursive: true });
    mkdirSync(join(repo, "dist", "deploy"), { recursive: true });
    expect(locatePackageRoot(join(repo, "src", "setup"))).toEqual({ root: repo, kind: "tree" });
    expect(locatePackageRoot(join(repo, "dist", "deploy"))).toEqual({ root: repo, kind: "tree" });
    expect(locatePackageRoot(repo)).toEqual({ root: repo, kind: "tree" });
  });

  it("an empty `assets/` directory is not the package root — the marker decides, not the name", () => {
    const repo = tmp();
    marker(repo);
    mkdirSync(join(repo, "dist", "assets"), { recursive: true });
    expect(locatePackageRoot(join(repo, "dist"))).toEqual({ root: repo, kind: "tree" });
  });

  it("throws naming the marker and where it looked when no ancestor carries it", () => {
    const nowhere = join(tmp(), "a", "b");
    mkdirSync(nowhere, { recursive: true });
    expect(() => locatePackageRoot(nowhere)).toThrow(
      new RegExp(`${PACKAGE_ROOT_MARKER}.*not found.*${nowhere.replaceAll("/", "\\/")}`),
    );
  });
});

describe("this module's own root", () => {
  it("in the checkout the root is the repository (src/ two levels up) and nothing is published", () => {
    expect(PACKAGE_ROOT).toBe(join(import.meta.dirname, ".."));
    expect(RUNS_FROM_PUBLISHED_PACKAGE).toBe(false);
  });
});
