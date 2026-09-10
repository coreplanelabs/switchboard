import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { PACKAGE_ROOT, PACKAGE_SOURCE_FILE, packageVersion } from "../packageRoot.js";
import { cliVersionOnHost, OPERATOR_ROOT } from "./host.js";
import { resolveOperatorRoot } from "./operatorRoot.js";

// Feature: docs/reference/specs/release-and-deploy.md item 25 — one version source
// for what the CLI copies and references: `cliVersionOnHost` is the root
// `package.json`'s in a checkout and `source.json`'s from the published package,
// and the command catalogue hands the deploy commands exactly that function.

const temps: string[] = [];
afterAll(() => {
  for (const t of temps) rmSync(t, { recursive: true, force: true });
});

describe("cliVersionOnHost", () => {
  it("in a checkout is the root package.json's version — the same number packageVersion() reads", () => {
    expect(OPERATOR_ROOT.mode).toBe("checkout");
    const root = JSON.parse(readFileSync(join(PACKAGE_ROOT, "package.json"), "utf8")) as { version: string };
    expect(cliVersionOnHost()).toBe(packageVersion());
    expect(cliVersionOnHost()).toBe(root.version);
  });

  it("from the package is source.json's version, and a package without one throws naming the file", () => {
    const assets = mkdtempSync(join(tmpdir(), "switchboard-assets-"));
    temps.push(assets);
    const at = resolveOperatorRoot({ packageRoot: assets, published: true, cwd: join(assets, "op") });
    expect(() => cliVersionOnHost(at)).toThrow(`${PACKAGE_SOURCE_FILE}: no such file in the package's assets`);
    writeFileSync(
      join(assets, PACKAGE_SOURCE_FILE),
      JSON.stringify({ version: "9.9.9", commit: "c".repeat(40), builtAt: "2000-01-01T00:00:00.000Z" }),
    );
    expect(cliVersionOnHost(at)).toBe("9.9.9");
    expect(cliVersionOnHost(at)).not.toBe(packageVersion());
  });

  it("is what the command catalogue binds as deps.deploy.cliVersion — not packageVersion, which from the package would be the manifest's, not the stamp's", () => {
    const catalogue = readFileSync(join(PACKAGE_ROOT, "src/core/commandCatalogue.ts"), "utf8");
    expect(catalogue).toMatch(/cliVersion: cliVersionOnHost,/);
    expect(catalogue).not.toMatch(/cliVersion: packageVersion/);
  });
});
