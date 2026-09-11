import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { invokedAsScript } from "../../src/invokedAsScript.js";

// Feature: docs/reference/specs/packaging.md item 1 — the bin is a committed
// file that hands the process to dist/cli.js. npm links a bin only when its
// target exists at install time, and the gitignored dist/ does not until the
// build runs: with dist/cli.js as the bin, `npx <the package>` inside the
// checkout — where npx prefers the workspace over the registry — died with
// `sh: switchboard: command not found`. Now the link always exists, and an
// unbuilt workspace says what to run.

const SHIM = join(import.meta.dirname, "bin", "switchboard.js");

/** A package directory holding a copy of the bin and, when given, a `dist/cli.js` with `bundle` as its text. */
function packageDir(bundle?: string): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "swb-bin-")));
  mkdirSync(join(dir, "bin"));
  copyFileSync(SHIM, join(dir, "bin", "switchboard.js"));
  if (bundle !== undefined) {
    mkdirSync(join(dir, "dist"));
    writeFileSync(join(dir, "dist", "cli.js"), bundle);
  }
  return dir;
}

/** Run `entry` under this Node with `args`; never throws — the caller reads the status. */
function run(entry: string, ...args: string[]) {
  const r = spawnSync(process.execPath, [entry, ...args], { encoding: "utf8", env: { ...process.env, NO_COLOR: "1" } });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}

/** What a stand-in bundle reports: the script Node believes it started, its own url, the arguments after it. */
const REPORTING_BUNDLE = [
  "console.log(JSON.stringify({ argv1: process.argv[1], url: import.meta.url, args: process.argv.slice(2) }));",
  "process.exitCode = 7;",
].join("\n");

interface Report {
  argv1: string;
  url: string;
  args: string[];
}

describe("the bin", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });
  const pkg = (bundle?: string) => {
    const dir = packageDir(bundle);
    dirs.push(dir);
    return dir;
  };

  it("with no dist/cli.js beside it refuses on stderr — the build command and the checkout's `npm run cli` — exit 1, nothing on stdout", () => {
    const r = run(join(pkg(), "bin", "switchboard.js"), "ask", "what can you do?");
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("dist/cli.js");
    expect(r.stderr).toContain("npm run build -w packages/switchboard");
    expect(r.stderr).toContain("npm run cli");
    expect(r.stdout).toBe("");
  });

  it("with dist/cli.js beside it hands the process over: the bundle is the script (its entry claim holds), the arguments pass through unchanged, its exit code is the process's", () => {
    const r = run(join(pkg(REPORTING_BUNDLE), "bin", "switchboard.js"), "ask", "what can you do?", "--json");
    expect(r.status, r.stderr).toBe(7);
    expect(r.stderr).toBe("");
    const report = JSON.parse(r.stdout) as Report;
    expect(invokedAsScript(report.url, report.argv1)).toBe(true);
    expect(report.args).toEqual(["ask", "what can you do?", "--json"]);
  });

  it("through a symlink — the shape npm links under node_modules/.bin — the bundle is still the script", () => {
    const dir = pkg(REPORTING_BUNDLE);
    mkdirSync(join(dir, "node_modules", ".bin"), { recursive: true });
    const link = join(dir, "node_modules", ".bin", "switchboard");
    symlinkSync(join("..", "..", "bin", "switchboard.js"), link);
    const r = run(link, "--help");
    expect(r.status, r.stderr).toBe(7);
    const report = JSON.parse(r.stdout) as Report;
    expect(invokedAsScript(report.url, report.argv1)).toBe(true);
    expect(report.url).toBe(`file://${join(dir, "dist", "cli.js")}`);
    expect(report.args).toEqual(["--help"]);
  });
});
