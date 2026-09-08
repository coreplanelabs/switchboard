import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { PACKAGE_ROOT } from "../packageRoot.js";

// Feature: docs/reference/specs/packaging.md item 6 — the curl-to-sh front door
// checks Node against the major the tree pins and hands everything to the
// published installer. Run for real under `sh` with stub `node`/`npx` binaries
// on PATH that report a chosen version and echo what they were asked to run.

const SCRIPT = join(PACKAGE_ROOT, "docs/public/install.sh");
const script = readFileSync(SCRIPT, "utf8");
const facts = JSON.parse(readFileSync(join(PACKAGE_ROOT, "project.json"), "utf8")) as { npmPackage: string };
const pinned = readFileSync(join(PACKAGE_ROOT, ".nvmrc"), "utf8").trim();

let dir: string | undefined;
afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = undefined;
});

/** Run the script with a PATH holding only the stubs: `node` reports `nodeVersion` (absent when undefined), `npx` echoes its argv. */
function run(opts: { nodeVersion?: string; npx?: boolean }, ...args: string[]) {
  dir = mkdtempSync(join(tmpdir(), "swb-install-"));
  const stub = (name: string, body: string) => {
    writeFileSync(join(dir!, name), `#!/bin/sh\n${body}\n`);
    chmodSync(join(dir!, name), 0o755);
  };
  if (opts.nodeVersion !== undefined) {
    const v = opts.nodeVersion;
    // `node -p 'process.versions.node.split(".")[0]'` → the major; `node -v` → the version as node prints it.
    stub("node", `case "$1" in -v) echo "v${v}" ;; -p) echo "${v.split(".")[0]}" ;; esac`);
  }
  // The npx stub also reports whether npm's engine check was turned on for the call.
  if (opts.npx !== false) stub("npx", 'echo "npx $*"; echo "engine-strict=${npm_config_engine_strict-unset}"');
  // PATH is the stub directory alone, so a real node on the machine is never found; the shell is named absolutely.
  const r = spawnSync("/bin/sh", [SCRIPT, ...args], { encoding: "utf8", env: { PATH: dir! } });
  return { status: r.status, stdout: r.stdout.trim(), stderr: r.stderr.trim() };
}

describe("docs/public/install.sh", () => {
  it("parses as POSIX sh and requires the Node major .nvmrc pins", () => {
    expect(spawnSync("sh", ["-n", SCRIPT]).status).toBe(0);
    expect(script).toContain(`REQUIRED_NODE_MAJOR=${pinned}\n`);
    expect(script).toContain(`PACKAGE="${facts.npmPackage}"`);
  });

  it("with Node new enough, execs `npx --yes <package>@latest init` with every argument passed through and npm's engine check on — npx alone does not enforce `engines`", () => {
    const r = run({ nodeVersion: `${pinned}.1.0` }, "--organization", "acme", "--anthropic-key", "sk-test");
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toBe(
      `npx --yes ${facts.npmPackage}@latest init --organization acme --anthropic-key sk-test\nengine-strict=true`,
    );
    expect(run({ nodeVersion: `${Number(pinned) + 2}.0.0` }).stdout).toBe(
      `npx --yes ${facts.npmPackage}@latest init\nengine-strict=true`,
    );
  });

  it("refuses an older Node, naming the version found and how to get a new one — and never installs Node itself", () => {
    const r = run({ nodeVersion: `${Number(pinned) - 2}.19.0` });
    expect(r.status).toBe(1);
    expect(r.stdout).toBe("");
    expect(r.stderr).toContain(`Node.js v${Number(pinned) - 2}.19.0 is too old`);
    expect(r.stderr).toContain(`Node.js ${pinned} or newer is required: https://nodejs.org/en/download`);
    expect(script).not.toMatch(/curl .*nodejs|apt|brew install|nvm install [^$]/);
  });

  it("refuses when node or npx is missing from PATH, with the same pointer", () => {
    const noNode = run({});
    expect(noNode.status).toBe(1);
    expect(noNode.stderr).toContain("node is not on your PATH");
    const noNpx = run({ nodeVersion: `${pinned}.0.0`, npx: false });
    expect(noNpx.status).toBe(1);
    expect(noNpx.stderr).toContain("npx is not on your PATH");
  });
});
