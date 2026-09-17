import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { TEMP_ROOT_PREFIX } from "./tempRoot.js";

// The run's temp root (tempRoot.ts) is proven from inside a worker: what the
// tests' `tmpdir()` answers, what a child process they spawn answers, and
// that the root config is what installs it — so a config edit that drops the
// setup fails here, in the same run, and not as a temp dir filling up again.

const repoRoot = fileURLToPath(new URL("../../..", import.meta.url));

describe("the run's temp root", () => {
  it("`tmpdir()` is a directory of this run's own, named for it, and it exists", () => {
    const dir = tmpdir();
    expect(basename(dir).startsWith(TEMP_ROOT_PREFIX), dir).toBe(true);
    expect(existsSync(dir), dir).toBe(true);
  });

  it("a temp dir a test makes the usual way lands under the root", () => {
    const made = mkdtempSync(join(tmpdir(), "swb-temp-root-probe-"));
    expect(realpathSync(dirname(made))).toBe(realpathSync(tmpdir()));
  });

  it("a child process a test spawns inherits the same root", () => {
    const child = execFileSync(process.execPath, ["-p", "require('node:os').tmpdir()"], { encoding: "utf8" }).trim();
    expect(realpathSync(child)).toBe(realpathSync(tmpdir()));
  });

  it("the root vitest config installs the setup for every project", () => {
    const config = readFileSync(join(repoRoot, "vitest.config.ts"), "utf8");
    expect(config).toMatch(/globalSetup:\s*\[\s*"src\/core\/testing\/tempRoot\.ts"\s*\]/);
  });
});
