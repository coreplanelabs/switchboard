import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { REQUIRED_VARIANTS, missingVariants } from "../scripts/check-lockfile.mjs";

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

describe("the repository's package-lock.json", () => {
  it("records every required platform variant", () => {
    const root = fileURLToPath(new URL("..", import.meta.url));
    const lock = JSON.parse(readFileSync(new URL("package-lock.json", `file://${root}`), "utf8")) as {
      packages: Record<string, unknown>;
    };
    expect(missingVariants(Object.keys(lock.packages))).toEqual([]);
  });
});
