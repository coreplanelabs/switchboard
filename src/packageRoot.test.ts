import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  locatePackageRoot,
  PACKAGE_ROOT,
  PACKAGE_ROOT_MARKER,
  PACKAGE_SOURCE_FILE,
  parsePackageSource,
  locatePackageVersion,
  packageVersion,
  RUNS_FROM_PUBLISHED_PACKAGE,
} from "./packageRoot.js";

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

describe("parsePackageSource (the tree the published package was built from)", () => {
  const source = {
    version: "1.12.0",
    commit: "161930af4597eb8bba9d9b72bd47ed93d6d8cf85",
    builtAt: "2026-09-09T10:00:00.000Z",
  };

  it("reads the version, the commit — a dirty build's `-dirty` kept — and the build time", () => {
    expect(parsePackageSource(JSON.stringify(source))).toEqual({ ok: true, source });
    expect(parsePackageSource(JSON.stringify({ ...source, commit: `${source.commit}-dirty` }))).toMatchObject({
      ok: true,
      source: { commit: `${source.commit}-dirty` },
    });
  });

  it("names a missing file, non-JSON, and a missing or empty field — never a guessed version or commit", () => {
    expect(parsePackageSource(undefined)).toEqual({
      ok: false,
      problem: `${PACKAGE_SOURCE_FILE}: no such file in the package's assets`,
    });
    expect(parsePackageSource("nope")).toEqual({ ok: false, problem: `${PACKAGE_SOURCE_FILE}: not JSON` });
    expect(parsePackageSource(JSON.stringify({ ...source, version: undefined }))).toEqual({
      ok: false,
      problem: `${PACKAGE_SOURCE_FILE}: \`version\` is missing`,
    });
    expect(parsePackageSource(JSON.stringify({ ...source, commit: "" }))).toEqual({
      ok: false,
      problem: `${PACKAGE_SOURCE_FILE}: \`commit\` is missing`,
    });
    expect(parsePackageSource(JSON.stringify({ ...source, builtAt: 1 }))).toEqual({
      ok: false,
      problem: `${PACKAGE_SOURCE_FILE}: \`builtAt\` is missing`,
    });
    expect(parsePackageSource("null")).toEqual({
      ok: false,
      problem: `${PACKAGE_SOURCE_FILE}: \`version\` is missing`,
    });
  });
});

describe("this module's own root", () => {
  it("in the checkout the root is the repository (src/ two levels up) and nothing is published", () => {
    expect(PACKAGE_ROOT).toBe(join(import.meta.dirname, ".."));
    expect(RUNS_FROM_PUBLISHED_PACKAGE).toBe(false);
  });
});

// The version this code runs as — what `deploy images` copies and `registry`
// mode references by default — is the nearest package.json's above the package
// root: the checkout's (and the image's) own, or the published package's
// manifest two levels above dist/assets/.
describe("locatePackageVersion", () => {
  it("reads `version` from the nearest package.json at or above the root: the checkout's own, the package manifest two levels above dist/assets/", () => {
    const repo = tmp();
    marker(repo);
    writeFileSync(join(repo, "package.json"), JSON.stringify({ name: "x", version: "3.4.5" }));
    expect(locatePackageVersion(repo)).toBe("3.4.5");
    const pkg = tmp();
    marker(join(pkg, "dist", "assets"));
    writeFileSync(join(pkg, "package.json"), JSON.stringify({ name: "@acme/x", version: "6.7.8" }));
    expect(locatePackageVersion(join(pkg, "dist", "assets"))).toBe("6.7.8");
  });

  it("skips a manifest without a version (or one that is not JSON) and keeps climbing; nothing above throws naming the start", () => {
    const read = (files: Record<string, string>) => (path: string) => files[path];
    expect(
      locatePackageVersion("/a/b/c", read({ "/a/b/c/package.json": "{}", "/a/package.json": '{"version":"1.0.0"}' })),
    ).toBe("1.0.0");
    expect(
      locatePackageVersion("/a/b", read({ "/a/b/package.json": "{ nope", "/a/package.json": '{"version":"2.0.0"}' })),
    ).toBe("2.0.0");
    expect(() => locatePackageVersion("/a/b", read({}))).toThrow("no package.json with a version at or above /a/b");
  });

  it("this checkout's version is the root package.json's — the number the release moves", () => {
    const root = JSON.parse(readFileSync(join(PACKAGE_ROOT, "package.json"), "utf8")) as { version: string };
    expect(packageVersion()).toBe(root.version);
    expect(packageVersion()).toMatch(/^\d+\.\d+\.\d+/);
  });
});
