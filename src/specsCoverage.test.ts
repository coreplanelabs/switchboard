import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const root = fileURLToPath(new URL("..", import.meta.url));
const owner = "docs/reference/specs/owner.md";
const testFile = "src/proof.test.ts";
const originalSpec = "- **Tests**: `src/proof.test.ts`\n";
const originalTest = 'it("keeper", () => { expect(true).toBe(true); });\nit("lost", () => { expect(1).toBe(1); });\n';
const keeper = 'it("keeper", () => { expect(true).toBe(true); });\n';

// Swap exactly at the filesystem boundary, not with a timing-dependent race.
// The old implementation checks lstat then reads a pathname; the safe reader
// opens without following links. Exercise either boundary against real files.
const raceHook = `
const fs = require("node:fs");
const { syncBuiltinESMExports } = require("node:module");
const file = process.env.SWAP_PATH;
const occurrence = Number(process.env.SWAP_OCCURRENCE || 1);
const action = process.env.SWAP_ACTION;
let swapped = false;
let stats = 0;
let opens = 0;
function swap() {
  if (swapped) return;
  swapped = true;
  fs.unlinkSync(file);
  fs.symlinkSync(process.env.SWAP_TARGET, file);
  process.stderr.write("race injected\\n");
}
const stat = fs.lstatSync;
fs.lstatSync = function(path, ...args) {
  const result = stat.call(this, path, ...args);
  if (path === file && ++stats === occurrence) swap();
  return result;
};
const open = fs.openSync;
fs.openSync = function(path, ...args) {
  const selected = path === file && ++opens === occurrence;
  if (selected && action !== "after-open" && action !== "unlink-before-readlink") swap();
  const fd = open.call(this, path, ...args);
  if (selected && action === "after-open") swap();
  return fd;
};
const readlink = fs.readlinkSync;
fs.readlinkSync = function(path, ...args) {
  if (path === file && action === "unlink-before-readlink") {
    fs.unlinkSync(file);
    process.stderr.write("link removed\\n");
  }
  return readlink.call(this, path, ...args);
};
syncBuiltinESMExports();
`;

let fixture: string;
const write = (path: string, content: string) => {
  mkdirSync(dirname(join(fixture, path)), { recursive: true });
  writeFileSync(join(fixture, path), content);
};
const git = (...args: string[]) => {
  const result = spawnSync("git", args, { cwd: fixture, encoding: "utf8" });
  expect(result.status, result.stderr).toBe(0);
  return result.stdout.trim();
};
const guard = (range = "base", race?: { path: string; target: string; occurrence?: number; action?: string }) =>
  spawnSync(
    process.execPath,
    ["--require", "./race.cjs", "--import", "tsx", "scripts/specs-coverage.ts", "--changed", range, "--test-guard"],
    {
      cwd: fixture,
      encoding: "utf8",
      timeout: 10_000,
      env: {
        ...process.env,
        SWAP_PATH: race ? join(fixture, race.path) : "",
        SWAP_TARGET: race?.target ?? "",
        SWAP_OCCURRENCE: String(race?.occurrence ?? 1),
        SWAP_ACTION: race?.action ?? "",
      },
    },
  );

beforeEach(() => {
  fixture = realpathSync(mkdtempSync(join(tmpdir(), "specs-coverage-")));
  for (const path of [
    "scripts/specs-coverage.ts",
    "scripts/specs-check.mjs",
    "scripts/spec-boundaries.mjs",
    "src/docs/specCoverage.ts",
    "src/docs/testGuard.ts",
  ]) {
    mkdirSync(dirname(join(fixture, path)), { recursive: true });
    copyFileSync(join(root, path), join(fixture, path));
  }
  symlinkSync(join(root, "node_modules"), join(fixture, "node_modules"), "dir");
  write("package.json", '{"type":"module"}');
  write("race.cjs", raceHook);
  write(owner, originalSpec);
  write(testFile, originalTest);
  git("init", "-q");
  git("config", "user.email", "fixture@example.invalid");
  git("config", "user.name", "Fixture");
  git("config", "core.autocrlf", "false");
  git("add", ".");
  git("commit", "-qm", "base");
  git("tag", "base");
});
afterEach(() => rmSync(fixture, { recursive: true, force: true }));

describe("specs:coverage working-tree blobs", () => {
  it("checks large committed test snapshots without losing the proof-removal guard", () => {
    const padding = `/* ${"x".repeat(1024 * 1024)} */\n`;
    write(testFile, originalTest + padding);
    git("add", testFile);
    git("commit", "-qm", "large base");
    git("tag", "-f", "base");
    write(testFile, keeper + padding);
    git("add", testFile);
    git("commit", "-qm", "remove proof");
    const unchangedOwner = guard("base..HEAD");
    expect(unchangedOwner.status, unchangedOwner.stderr).toBe(1);
    expect(unchangedOwner.stdout).toContain('removed: test "lost"');
    expect(unchangedOwner.stdout).toContain("test-guard FAILED");
    write(owner, `${originalSpec}\n`);
    git("add", owner);
    git("commit", "-qm", "revise contract");
    const revisedOwner = guard("base...HEAD");
    expect(revisedOwner.status, revisedOwner.stderr).toBe(0);
    expect(revisedOwner.stdout).toContain(`allowed by ${owner}`);
  });

  it("does not follow a test replaced by a symlink between checking and reading", () => {
    write(testFile, keeper);
    write("attacker-target", originalTest);
    const result = guard("base", { path: testFile, target: "../attacker-target" });
    expect(result.stderr).toContain("race injected");
    expect(result.status, result.stderr).toBe(1);
    expect(result.stdout).toContain('removed: test "lost"');
    expect(result.stdout).toContain("test-guard FAILED");
  });

  it("hashes link bytes when an owner becomes a symlink at the blob-hash boundary", () => {
    write(testFile, keeper);
    write(owner, `${originalSpec}\n`);
    write("attacker-target", originalSpec);
    const result = guard("base", { path: owner, target: "../../../attacker-target", occurrence: 2 });
    expect(result.stderr).toContain("race injected");
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain(`allowed by ${owner}`);
  });

  it("reads the opened inode if the test path is replaced after opening", () => {
    write(testFile, keeper);
    write("attacker-target", originalTest);
    const result = guard("base", { path: testFile, target: "../attacker-target", action: "after-open" });
    expect(result.stderr).toContain("race injected");
    expect(result.status, result.stderr).toBe(1);
    expect(result.stdout).toContain('removed: test "lost"');
    expect(result.stdout).not.toContain('removed: test "keeper"');
  });

  it("fails closed if a symlink disappears before its link bytes are read", () => {
    rmSync(join(fixture, testFile));
    symlinkSync("../attacker-target", join(fixture, testFile));
    const result = guard("base", { path: testFile, target: "../attacker-target", action: "unlink-before-readlink" });
    expect(result.stderr).toContain("link removed");
    expect(result.stderr).toContain("ENOENT");
    expect(result.status).toBe(1);
    expect(result.stdout).not.toContain("test-guard ok");
  });

  it("still rejects proof loss with an unchanged regular owner", () => {
    write(testFile, keeper);
    const result = guard();
    expect(result.status, result.stderr).toBe(1);
    expect(result.stdout).toContain(`covered by ${owner}`);
  });

  it("uses clean-filtered regular content rather than raw working-tree bytes", () => {
    write(".gitattributes", "*.md text eol=lf\n");
    git("add", ".gitattributes");
    git("commit", "-qm", "attributes");
    git("tag", "-f", "base");
    write(testFile, keeper);
    write(owner, originalSpec.replaceAll("\n", "\r\n"));
    const result = guard();
    expect(result.status, result.stderr).toBe(1);
    expect(result.stdout).toContain(`covered by ${owner}`);
  });

  it("applies a configured clean filter to regular owner bytes supplied on stdin", () => {
    write(".gitattributes", "*.md filter=contract\n");
    git("config", "filter.contract.clean", "sed s/WORKING/CANONICAL/g");
    write(owner, `${originalSpec}# CANONICAL\n`);
    git("add", ".");
    git("commit", "-qm", "filter");
    git("tag", "-f", "base");
    write(testFile, keeper);
    write(owner, `${originalSpec}# WORKING\n`);
    const result = guard();
    expect(result.status, result.stderr).toBe(1);
    expect(result.stdout).toContain(`covered by ${owner}`);
  });

  it("compares identical symlink bytes without following a dangling owner", () => {
    rmSync(join(fixture, owner));
    symlinkSync(originalSpec, join(fixture, owner));
    write(testFile, keeper);
    const result = guard();
    expect(result.status, result.stderr).toBe(1);
    expect(result.stdout).toContain(`covered by ${owner}`);
  });

  it("does not let a symlinked test borrow proofs from its target", () => {
    write("attacker-target", originalTest);
    rmSync(join(fixture, testFile));
    symlinkSync("../attacker-target", join(fixture, testFile));
    const result = guard();
    expect(result.status, result.stderr).toBe(1);
    expect(result.stdout).toContain('removed: test "lost"');
  });

  it.each(["base..HEAD", "base...HEAD"])("keeps committed link snapshots independent of targets in %s", (range) => {
    write("attacker-target", originalTest);
    rmSync(join(fixture, testFile));
    symlinkSync("../attacker-target", join(fixture, testFile));
    git("add", ".");
    git("commit", "-qm", "link");
    const result = guard(range);
    expect(result.status, result.stderr).toBe(1);
    expect(result.stdout).toContain('removed: test "lost"');
  });
});
