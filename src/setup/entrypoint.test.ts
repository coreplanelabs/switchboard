import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { importSpecifiers, resolveImportCandidates } from "../deploy/affected.js";
import { PACKAGE_ROOT } from "../packageRoot.js";

// Feature: docs/reference/specs/init.md — the published image installs too:
// `docker-entrypoint.sh` runs the bot with no arguments and the CLI with any,
// and the Dockerfile carries the examples the installer derives from. The
// script is run for real under `sh` with a stub `node` on PATH that prints
// what it was asked to run.

let dir: string | undefined;
afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = undefined;
});

/** Run the entrypoint with `args`; the stub `node` echoes its argv, so stdout is what would have run. */
function entrypoint(...args: string[]): string {
  dir = mkdtempSync(join(tmpdir(), "swb-entry-"));
  const stub = join(dir, "node");
  writeFileSync(stub, '#!/bin/sh\necho "node $*"\n');
  chmodSync(stub, 0o755);
  const r = spawnSync("sh", [join(PACKAGE_ROOT, "docker-entrypoint.sh"), ...args], {
    encoding: "utf8",
    env: { PATH: `${dir}:/usr/bin:/bin` },
  });
  expect(r.status, r.stderr).toBe(0);
  return r.stdout.trim();
}

describe("docker-entrypoint.sh", () => {
  it("no arguments → the bot; `init …`, `ask …` or `<group> <verb> …` → the CLI with the arguments as given", () => {
    expect(entrypoint()).toBe("node /app/dist/index.js");
    expect(entrypoint("init", "--dry-run", "--organization", "acme")).toBe(
      "node /app/dist/cli.js init --dry-run --organization acme",
    );
    expect(entrypoint("ask", "what can you do?")).toBe("node /app/dist/cli.js ask what can you do?");
    expect(entrypoint("deploy", "plan")).toBe("node /app/dist/cli.js deploy plan");
  });

  it("an explicit `node …` runs as given — an operator's own command is never rewritten", () => {
    expect(entrypoint("node", "dist/index.js")).toBe("node dist/index.js");
  });
});

describe("Dockerfile", () => {
  const dockerfile = readFileSync(join(PACKAGE_ROOT, "Dockerfile"), "utf8");

  it("copies src/ alone for the bot's build, so no production module under src/ imports a file outside it — deploy/, packages/ and scripts/ are not in the image and `npm run build` there would fail on the missing file", () => {
    expect(dockerfile).toMatch(/^COPY src \.\/src$/m);
    const escaping: string[] = [];
    for (const rel of readdirSync(join(PACKAGE_ROOT, "src"), { recursive: true, encoding: "utf8" })) {
      if (!rel.endsWith(".ts") || rel.endsWith(".test.ts") || rel.split(sep).includes("testing")) continue;
      const file = join("src", rel);
      for (const spec of importSpecifiers(readFileSync(join(PACKAGE_ROOT, file), "utf8"))) {
        const first = resolveImportCandidates(file, spec)[0];
        if (first !== undefined && !first.startsWith("src/")) escaping.push(`${file} → ${spec}`);
      }
    }
    expect(escaping).toEqual([]);
  });

  it("installs the entrypoint as `switchboard` and has no CMD of its own — the entrypoint decides", () => {
    expect(dockerfile).toMatch(/^COPY --chmod=755 docker-entrypoint\.sh \/usr\/local\/bin\/switchboard$/m);
    expect(dockerfile).toMatch(/^ENTRYPOINT \["switchboard"\]$/m);
    expect(dockerfile).not.toMatch(/^CMD /m);
  });

  it("carries the three examples the installer derives from, and project.json for the image fact — under the paths the host half reads", () => {
    expect(dockerfile).toMatch(/^COPY \.env\.example \.\/$/m);
    expect(dockerfile).toMatch(/^COPY config\/config\.example\.yaml \.\/config\/$/m);
    expect(dockerfile).toMatch(/^COPY deploy\/profile\.example\.json \.\/deploy\/$/m);
    expect(dockerfile).toMatch(/^COPY package\.json project\.json build\.jso\[n\] \.\/$/m);
  });
});

describe("package.json", () => {
  it("names the CLI as the `switchboard` bin, and the CLI's source starts with the shebang a bin needs", () => {
    const pkg = JSON.parse(readFileSync(join(PACKAGE_ROOT, "package.json"), "utf8")) as { bin?: unknown };
    expect(pkg.bin).toEqual({ switchboard: "dist/cli.js" });
    expect(readFileSync(join(PACKAGE_ROOT, "src/cli.ts"), "utf8").startsWith("#!/usr/bin/env node\n")).toBe(true);
  });
});
