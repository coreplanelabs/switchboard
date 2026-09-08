import { describe, expect, it } from "vitest";
import { NO_OP_COMMAND, NPM_FALLBACK_COMMANDS, detectCommands } from "./repoToolchain.js";

// Feature: features/resident-repos.md item 52 — the onboard command table is
// derived from the repo root, never assumed. The two shapes the npm-only
// defaults broke on (a pnpm workspace and a repo with no package.json) are pinned.

describe("detectCommands", () => {
  it("a pnpm workspace (pnpm-lock.yaml, no root build script) installs with pnpm and skips the build", () => {
    const d = detectCommands({
      entries: ["package.json", "pnpm-lock.yaml", "pnpm-workspace.yaml", "turbo.json"],
      packageJson: { scripts: { test: "turbo test -- run" } },
    });
    expect(d.toolchain).toBe("pnpm");
    expect(d.commands).toEqual({ install: "pnpm install --frozen-lockfile", build: NO_OP_COMMAND, test: "pnpm test" });
    expect(d.notes).toEqual(["package manager from pnpm-lock.yaml", "no build script — build is a no-op"]);
  });

  it("a repo with no root package.json (Terraform, Taskfile) gets no install and no-op build/test — never npm", () => {
    const d = detectCommands({ entries: [".github", "Taskfile.yaml", "infra", "README.md"] });
    expect(d.toolchain).toBe("none");
    expect(d.commands).toEqual({ build: NO_OP_COMMAND, test: NO_OP_COMMAND });
    expect(d.commands).not.toHaveProperty("install");
    expect(d.notes[0]).toMatch(/^no package.json at the repo root — nothing to install or build; pass --test\/--build/);
  });

  it("a lockfile without a root package.json is still `none`, and the note says why", () => {
    const d = detectCommands({ entries: ["pnpm-lock.yaml"] });
    expect(d.toolchain).toBe("none");
    expect(d.notes[0]).toContain("a pnpm-lock.yaml without one is not a root package");
  });

  it("the packageManager field wins over the lockfile", () => {
    const d = detectCommands({
      entries: ["package.json", "package-lock.json"],
      packageJson: { packageManager: "pnpm@10.10.0", scripts: { build: "tsc", test: "vitest run" } },
    });
    expect(d.toolchain).toBe("pnpm");
    expect(d.commands).toEqual({
      install: "pnpm install --frozen-lockfile",
      build: "pnpm run build",
      test: "pnpm test",
    });
    expect(d.notes[0]).toBe("package manager from package.json packageManager (pnpm@10.10.0)");
  });

  it("an unknown packageManager falls through to the lockfile", () => {
    expect(
      detectCommands({ entries: ["package.json", "yarn.lock"], packageJson: { packageManager: "volta@1" } }).toolchain,
    ).toBe("yarn");
  });

  it("npm with a lockfile keeps the proven npm install; scripts decide build/test", () => {
    const d = detectCommands({
      entries: ["package.json", "package-lock.json"],
      packageJson: { scripts: { build: "tsc", test: "vitest run" } },
    });
    expect(d).toEqual({
      toolchain: "npm",
      commands: { install: NPM_FALLBACK_COMMANDS.install, build: "npm run build", test: "npm test" },
      notes: ["package manager from package-lock.json"],
    });
  });

  it("package.json with no lockfile assumes npm and says so", () => {
    const d = detectCommands({ entries: ["package.json"], packageJson: { scripts: {} } });
    expect(d.toolchain).toBe("npm");
    expect(d.notes).toEqual([
      "no lockfile at the repo root — assuming npm",
      "no build script — build is a no-op",
      "no test script — test is a no-op; pass --test to set one",
    ]);
    expect(d.commands).toEqual({ install: NPM_FALLBACK_COMMANDS.install, build: NO_OP_COMMAND, test: NO_OP_COMMAND });
  });

  it("yarn classic vs berry: .yarnrc.yml selects --immutable", () => {
    expect(detectCommands({ entries: ["package.json", "yarn.lock"], packageJson: {} }).commands.install).toBe(
      "yarn install --frozen-lockfile",
    );
    expect(
      detectCommands({ entries: ["package.json", "yarn.lock", ".yarnrc.yml"], packageJson: {} }).commands.install,
    ).toBe("yarn install --immutable");
  });

  it("bun: either lockfile name", () => {
    for (const lock of ["bun.lock", "bun.lockb"]) {
      const d = detectCommands({ entries: ["package.json", lock], packageJson: { scripts: { test: "bun test" } } });
      expect(d.commands).toEqual({ install: "bun install --frozen-lockfile", build: NO_OP_COMMAND, test: "bun test" });
    }
  });

  it("an unparseable package.json (null) is treated as one with no scripts", () => {
    const d = detectCommands({ entries: ["package.json", "pnpm-lock.yaml"], packageJson: null });
    expect(d.commands).toEqual({
      install: "pnpm install --frozen-lockfile",
      build: NO_OP_COMMAND,
      test: NO_OP_COMMAND,
    });
  });
});
