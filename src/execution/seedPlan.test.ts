import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { depsEntryMaterializeScript, depsStoreCommitScript } from "./residentDepsStore.js";
import {
  isBackupMissing,
  parseSeed,
  SEED_BUDGET_MS,
  SEED_CHECKOUT_DIR,
  SEED_DEPS_STAGING_DIR,
  SEED_FIXUP_TIMEOUT_MS,
  SEED_MARKER,
  SEED_REASONS,
  SEED_RESTORE_MAX_MS,
  SEED_ABANDONED_RESTORE_WAIT_MS,
  seedFixupScript,
  seedDoorRemote,
  seedForThread,
  seedMarkerText,
  seedRetryDecision,
  seededSandboxNote,
  readyEnvironmentCommand,
  readyEnvironmentOutcome,
  type SandboxSeed,
} from "./seedPlan.js";

// The seeded sandbox (docs/reference/specs/execution.md item 25): a cold
// sandbox restores the resident's checkout snapshot — and the deps-store
// entry for its lockfile key — before its first command, then fixes ownership
// and origin and checks the thread's ref out. This module is the plan's pure
// half: the handle's shape, the fix-up script, the classification of a
// restore whose objects are gone. The Worker runs it; the bot forwards it.

const seed: SandboxSeed = {
  slug: "acme/widgets",
  checkoutBackupId: "3f2a9c1e-5b7d-4e8f-9a0b-1c2d3e4f5a6b",
  depsBackupId: "aa11bb22-cc33-dd44-ee55-ff6677889900",
  ref: "main",
  sha: "0123456789abcdef0123456789abcdef01234567",
};

describe("parseSeed", () => {
  it("accepts the resident's handle with the thread's ref and head riding along", () => {
    const parsed = parseSeed({ ...seed, fetchRef: "feat/x", fetchSha: "89abcdef0123456789abcdef0123456789abcdef" });
    expect(parsed).toEqual({
      ok: true,
      seed: { ...seed, fetchRef: "feat/x", fetchSha: "89abcdef0123456789abcdef0123456789abcdef" },
    });
  });

  it("accepts a handle without a deps entry or a thread ref: the checkout alone, on the snapshot's branch", () => {
    const { depsBackupId: _omitted, ...bare } = seed;
    expect(parseSeed(bare)).toEqual({ ok: true, seed: bare });
  });

  it("names what is wrong: a missing or malformed id, slug, ref or sha, or no object at all", () => {
    const bad = (v: unknown) => {
      const r = parseSeed(v);
      return r.ok ? "accepted" : r.error;
    };
    expect(bad(undefined)).toBe("seed: not an object");
    expect(bad({ ...seed, checkoutBackupId: "../etc" })).toBe("seed: checkoutBackupId is not a backup id");
    expect(bad({ ...seed, depsBackupId: "" })).toBe("seed: depsBackupId is not a backup id");
    expect(bad({ ...seed, slug: "acme" })).toBe("seed: slug is not owner/name");
    expect(bad({ ...seed, ref: "-rf" })).toBe("seed: ref is not a branch name");
    expect(bad({ ...seed, fetchRef: "a..b" })).toBe("seed: fetchRef is not a branch name");
    expect(bad({ ...seed, sha: "abc" })).toBe("seed: sha is not a commit sha");
    expect(bad({ ...seed, fetchSha: "ABC" })).toBe("seed: fetchSha is not a commit sha");
  });
});

describe("pilot ready environment check", () => {
  const requirement = { testCommand: "npm test", requiredTools: ["npm", "node"], dependencyDir: "node_modules" };

  it("checks preparation without requiring or inventing a test command", () => {
    const { testCommand: _unused, ...preparation } = requirement;
    const command = readyEnvironmentCommand("/workspace/checkout", preparation);
    expect(command).toContain("test -d 'node_modules'");
    expect(command).toContain("command -v 'node'");
    expect(command).not.toContain("bash -n");
    expect(command).not.toContain("npm test");
    expect(command).toContain("printf READY");
  });

  it("checks the declared command and dependencies without running the test suite", () => {
    const command = readyEnvironmentCommand("/workspace/checkout", requirement);
    expect(command).toContain("cd '/workspace/checkout'");
    expect(command).toContain("test -d 'node_modules'");
    expect(command).toContain("command -v 'npm'");
    expect(command).toContain("command -v 'node'");
    expect(command).toContain("command -v 'bash'");
    expect(command).toContain("bash -n -c 'npm test'");
    expect(command).not.toContain("\nnpm test\n");
  });

  it("checks a seeded snapshot's committed lockfiles against the target checkout", () => {
    const source = "0123456789abcdef0123456789abcdef01234567";
    const command = readyEnvironmentCommand("/workspace/checkout", requirement, source);
    expect(command).toContain(`git diff --quiet '${source}' HEAD --`);
    expect(command).toContain("'package-lock.json'");
    expect(command).toContain("'pnpm-lock.yaml'");
    expect(command).toContain("LOCKFILE_MISMATCH");
    expect(readyEnvironmentOutcome("LOCKFILE_MISMATCH")).toEqual({ ready: false, reason: "dependencies_stale" });
  });

  it("admits unchanged committed lockfiles and refuses a target head with a changed lockfile", () => {
    const checkout = mkdtempSync(join(tmpdir(), "switchboard-ready-lockfiles-"));
    const git = (...args: string[]) => {
      const result = spawnSync("git", args, { cwd: checkout, encoding: "utf8" });
      expect(result.status, result.stderr).toBe(0);
      return result.stdout.trim();
    };
    try {
      git("init", "-q");
      writeFileSync(join(checkout, "package-lock.json"), '{"lockfileVersion":3}\n');
      git("add", "package-lock.json");
      git("-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-qm", "snapshot");
      const source = git("rev-parse", "HEAD");
      mkdirSync(join(checkout, "node_modules"));

      writeFileSync(join(checkout, "README.md"), "same dependencies\n");
      git("add", "README.md");
      git("-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-qm", "other change");
      const command = readyEnvironmentCommand(checkout, requirement, source);
      const unchanged = spawnSync("bash", ["-c", command], { cwd: checkout, encoding: "utf8" });
      expect(unchanged.status, unchanged.stderr).toBe(0);
      expect(readyEnvironmentOutcome(unchanged.stdout)).toEqual({ ready: true });

      writeFileSync(join(checkout, "package-lock.json"), '{"lockfileVersion":3,"changed":true}\n');
      git("add", "package-lock.json");
      git("-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-qm", "dependencies changed");
      const changed = spawnSync("bash", ["-c", command], { cwd: checkout, encoding: "utf8" });
      expect(changed.status, changed.stderr).toBe(0);
      expect(readyEnvironmentOutcome(changed.stdout)).toEqual({ ready: false, reason: "dependencies_stale" });
    } finally {
      rmSync(checkout, { recursive: true, force: true });
    }
  });

  it.each(["wrapper", "missing package", "missing bin", "broken bin"])(
    "refuses %s without changing cached work",
    (failure) => {
      const checkout = mkdtempSync(join(tmpdir(), "switchboard-ready-layout-"));
      try {
        mkdirSync(join(checkout, "node_modules/example-cli"), { recursive: true });
        mkdirSync(join(checkout, "node_modules/.bin"));
        writeFileSync(join(checkout, "package.json"), JSON.stringify({ devDependencies: { "example-cli": "1.0.0" } }));
        writeFileSync(
          join(checkout, "node_modules/example-cli/package.json"),
          JSON.stringify({ name: "example-cli", bin: { example: "run" } }),
        );
        writeFileSync(join(checkout, "node_modules/example-cli/run"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
        symlinkSync("../example-cli/run", join(checkout, "node_modules/.bin/example"));
        if (failure === "wrapper") {
          const old = join(checkout, "old");
          cpSync(join(checkout, "node_modules"), old, { recursive: true, verbatimSymlinks: true });
          rmSync(join(checkout, "node_modules"), { recursive: true });
          cpSync(old, join(checkout, "node_modules/node_modules"), { recursive: true, verbatimSymlinks: true });
        } else if (failure === "missing package")
          rmSync(join(checkout, "node_modules/example-cli"), { recursive: true });
        else if (failure === "missing bin") rmSync(join(checkout, "node_modules/.bin/example"));
        else rmSync(join(checkout, "node_modules/example-cli/run"));
        writeFileSync(join(checkout, "source.ts"), "clean source");
        for (const args of [
          ["init", "-q"],
          ["add", "source.ts"],
          ["-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-qm", "fixture"],
        ]) {
          const git = spawnSync("git", args, { cwd: checkout, encoding: "utf8" });
          expect(git.status, git.stderr).toBe(0);
        }
        writeFileSync(join(checkout, "source.ts"), "dirty source");
        writeFileSync(join(checkout, "untracked"), "keep");
        writeFileSync(join(checkout, ".switchboard-seed"), seedMarkerText(seed));
        const result = spawnSync(
          "bash",
          ["-c", readyEnvironmentCommand(checkout, { requiredTools: ["node"], dependencyDir: "node_modules" })],
          { encoding: "utf8" },
        );
        expect(readyEnvironmentOutcome(result.stdout)).toEqual({ ready: false, reason: "dependencies_invalid" });
        expect(readFileSync(join(checkout, "source.ts"), "utf8")).toBe("dirty source");
        expect(readFileSync(join(checkout, "untracked"), "utf8")).toBe("keep");
        expect(readFileSync(join(checkout, ".switchboard-seed"), "utf8")).toBe(seedMarkerText(seed));
      } finally {
        rmSync(checkout, { recursive: true, force: true });
      }
    },
  );

  it("accepts a dependency-only symlink view and absent optional packages without requiring .bin", () => {
    const checkout = mkdtempSync(join(tmpdir(), "switchboard-ready-valid-"));
    try {
      mkdirSync(join(checkout, "view/library"), { recursive: true });
      symlinkSync("view", join(checkout, "node_modules"));
      writeFileSync(join(checkout, "view/library/package.json"), '{"name":"library"}');
      writeFileSync(
        join(checkout, "package.json"),
        JSON.stringify({ dependencies: { library: "1", optional: "1" }, optionalDependencies: { optional: "1" } }),
      );
      const result = spawnSync(
        "bash",
        ["-c", readyEnvironmentCommand(checkout, { requiredTools: ["node"], dependencyDir: "node_modules" })],
        { encoding: "utf8" },
      );
      expect(result.status, result.stderr).toBe(0);
      expect(readyEnvironmentOutcome(result.stdout)).toEqual({ ready: true });
    } finally {
      rmSync(checkout, { recursive: true, force: true });
    }
  });

  it.each(["alias", "collision", "wrapper"])(
    "accepts a usable %s executable installed by the package manager",
    (layout) => {
      const checkout = mkdtempSync(join(tmpdir(), "switchboard-ready-bins-"));
      try {
        mkdirSync(join(checkout, "node_modules/alias"), { recursive: true });
        mkdirSync(join(checkout, "node_modules/.bin"));
        const dependencies: Record<string, string> = { alias: "npm:real-cli@1" };
        writeFileSync(
          join(checkout, "node_modules/alias/package.json"),
          JSON.stringify({ name: "real-cli", bin: "run.js" }),
        );
        writeFileSync(join(checkout, "node_modules/alias/run.js"), "#!/usr/bin/env node\n", {
          mode: layout === "wrapper" ? 0o644 : 0o755,
        });
        if (layout === "wrapper")
          writeFileSync(
            join(checkout, "node_modules/.bin/real-cli"),
            '#!/bin/sh\nexec node "$(dirname "$0")/../alias/run.js"\n',
            { mode: 0o755 },
          );
        else symlinkSync("../alias/run.js", join(checkout, "node_modules/.bin/real-cli"));
        if (layout === "collision") {
          dependencies.second = "1";
          mkdirSync(join(checkout, "node_modules/second"));
          writeFileSync(
            join(checkout, "node_modules/second/package.json"),
            JSON.stringify({ name: "second", bin: { "real-cli": "run.js" } }),
          );
          writeFileSync(join(checkout, "node_modules/second/run.js"), "#!/usr/bin/env node\n", { mode: 0o755 });
        }
        writeFileSync(join(checkout, "package.json"), JSON.stringify({ dependencies }));
        const result = spawnSync(
          "bash",
          ["-c", readyEnvironmentCommand(checkout, { requiredTools: ["node"], dependencyDir: "node_modules" })],
          { encoding: "utf8" },
        );
        expect(result.status, result.stderr).toBe(0);
        expect(readyEnvironmentOutcome(result.stdout)).toEqual({ ready: true });
      } finally {
        rmSync(checkout, { recursive: true, force: true });
      }
    },
  );

  it("allows workspace source packages whose declared bins are build outputs", () => {
    const checkout = mkdtempSync(join(tmpdir(), "switchboard-ready-workspace-bin-"));
    try {
      mkdirSync(join(checkout, "node_modules"));
      mkdirSync(join(checkout, "packages/cli"), { recursive: true });
      symlinkSync("../packages/cli", join(checkout, "node_modules/local-cli"));
      writeFileSync(
        join(checkout, "package.json"),
        JSON.stringify({ dependencies: { "local-cli": "*" }, workspaces: ["packages/*"] }),
      );
      writeFileSync(
        join(checkout, "packages/cli/package.json"),
        JSON.stringify({ name: "local-cli", bin: "dist/cli.js" }),
      );
      const result = spawnSync(
        "bash",
        ["-c", readyEnvironmentCommand(checkout, { requiredTools: ["node"], dependencyDir: "node_modules" })],
        { encoding: "utf8" },
      );
      expect(readyEnvironmentOutcome(result.stdout)).toEqual({ ready: true });
    } finally {
      rmSync(checkout, { recursive: true, force: true });
    }
  });

  it("checks dependencies declared by package.json workspaces, including hoisted copies", () => {
    const checkout = mkdtempSync(join(tmpdir(), "switchboard-ready-workspace-"));
    try {
      mkdirSync(join(checkout, "node_modules/library"), { recursive: true });
      mkdirSync(join(checkout, "packages/widget"), { recursive: true });
      writeFileSync(join(checkout, "package.json"), JSON.stringify({ workspaces: ["packages/*"] }));
      writeFileSync(join(checkout, "packages/widget/package.json"), JSON.stringify({ dependencies: { library: "1" } }));
      writeFileSync(join(checkout, "node_modules/library/package.json"), '{"name":"library"}');
      const check = () =>
        spawnSync(
          "bash",
          ["-c", readyEnvironmentCommand(checkout, { requiredTools: ["node"], dependencyDir: "node_modules" })],
          { encoding: "utf8" },
        );
      expect(readyEnvironmentOutcome(check().stdout)).toEqual({ ready: true });
      rmSync(join(checkout, "node_modules/library"), { recursive: true });
      expect(readyEnvironmentOutcome(check().stdout)).toEqual({ ready: false, reason: "dependencies_invalid" });
    } finally {
      rmSync(checkout, { recursive: true, force: true });
    }
  });

  it("refuses malformed tool, dependency path and test command before shell construction", () => {
    expect(() =>
      readyEnvironmentCommand("/workspace/checkout", { ...requirement, requiredTools: ["npm; echo x"] }),
    ).toThrow();
    expect(() =>
      readyEnvironmentCommand("/workspace/checkout", { ...requirement, dependencyDir: "../secret" }),
    ).toThrow();
    expect(() => readyEnvironmentCommand("/workspace/checkout", { ...requirement, testCommand: "" })).toThrow();
    expect(() =>
      readyEnvironmentCommand("/workspace/checkout", { ...requirement, testCommand: "FOO=bar npm test" }),
    ).toThrow();
  });

  it("types the fixed check markers and leaves arbitrary output opaque", () => {
    expect(readyEnvironmentOutcome("READY")).toEqual({ ready: true });
    expect(readyEnvironmentOutcome("exit 2:\nMISSING_DEPENDENCIES")).toEqual({
      ready: false,
      reason: "dependencies_missing",
    });
    expect(readyEnvironmentOutcome("exit 2:\nMISSING_TOOL:npm")).toEqual({
      ready: false,
      reason: "tool_missing",
      tool: "npm",
    });
    expect(readyEnvironmentOutcome("exit 2:\nINVALID_TEST_COMMAND")).toEqual({
      ready: false,
      reason: "test_command_invalid",
    });
    expect(readyEnvironmentOutcome("exit 127:\nprivate output")).toEqual({ ready: false, reason: "check_failed" });
  });
});

describe("seedFixupScript", () => {
  const fixup = { ...seed, doorOrigin: "https://door.example" };

  it("uses the exact bound Git door URL and rejects malformed destinations", () => {
    expect(seedDoorRemote("https://door.example/anything", "acme/widgets")).toBe(
      "https://door.example/git/acme/widgets.git",
    );
    expect(() => seedDoorRemote("https://door.example", "acme/widgets.git-tools")).not.toThrow();
    expect(() => seedDoorRemote("https://door.example", "../widgets")).toThrow();
    expect(() => seedDoorRemote("file:///tmp/door", "acme/widgets")).toThrow();
    expect(() => seedDoorRemote("https://user:password@door.example", "acme/widgets")).toThrow();
  });

  it("runs as one failing-fast script: ownership, origin, the deps view moved in, the thread's ref fetched and checked out, the head printed last", () => {
    const script = seedFixupScript({
      ...fixup,
      fetchRef: "feat/x",
      fetchSha: "89abcdef0123456789abcdef0123456789abcdef",
      checkoutDir: SEED_CHECKOUT_DIR,
      depsDir: SEED_DEPS_STAGING_DIR,
    });
    const checkout = "git checkout -q -B 'feat/x' '89abcdef0123456789abcdef0123456789abcdef'";
    expect(script).toContain(checkout);
    expect(script).toContain("git remote set-url origin 'https://door.example/git/acme/widgets.git'");
    expect(script).toContain("git fetch --no-tags origin '+refs/heads/feat/x:refs/remotes/origin/feat/x'");
    expect(script.indexOf("node -e")).toBeGreaterThan(script.indexOf(checkout));
    expect(script.split("\n").at(-1)).toBe("git rev-parse HEAD");
  });

  it("without a thread ref the checkout stays on the snapshot's branch; without a deps entry nothing is moved", () => {
    const script = seedFixupScript({ ...fixup, checkoutDir: SEED_CHECKOUT_DIR });
    expect(script).not.toContain("git fetch");
    expect(script).not.toContain("node_modules");
    expect(script).toContain("git checkout -q -B 'main'");
    expect(script.split("\n").at(-1)).toBe("git rev-parse HEAD");
  });

  it("quotes the values it interpolates: a ref with shell metacharacters never reaches the shell bare", () => {
    const script = seedFixupScript({ ...fixup, fetchRef: "feat/$x", checkoutDir: SEED_CHECKOUT_DIR });
    expect(script).toContain("'feat/$x'");
    expect(script).not.toMatch(/(^|\s)feat\/\$x(\s|$)/m);
  });

  it("carries no credential: the fetch authenticates through the image's credential helper and the exec env", () => {
    const script = seedFixupScript({ ...fixup, fetchRef: "feat/x", checkoutDir: SEED_CHECKOUT_DIR });
    expect(script).not.toMatch(/GH_TOKEN|x-access-token|ghs_/);
  });
});

describe("resident dependency entry consumed by a seeded checkout", () => {
  it("materializes the producer's root executable and workspace dependencies beside tracked fixtures", () => {
    const root = mkdtempSync(join(tmpdir(), "switchboard-seed-entry-"));
    const scratch = join(root, "scratch");
    const entry = join(root, "entry");
    const restored = join(root, "restored");
    const checkout = join(root, "checkout");
    const bin = join(root, "bin");
    const run = (command: string, cwd = root) =>
      spawnSync("bash", ["-c", command], {
        cwd,
        encoding: "utf8",
        env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
      });
    const git = (...args: string[]) => {
      const result = spawnSync("git", args, { cwd: checkout, encoding: "utf8" });
      expect(result.status, result.stderr).toBe(0);
    };
    try {
      mkdirSync(join(scratch, "node_modules/.bin"), { recursive: true });
      mkdirSync(join(scratch, "node_modules/example-cli"));
      writeFileSync(join(scratch, "node_modules/example-cli/run"), "#!/bin/sh\nprintf 'root executable works'\n", {
        mode: 0o755,
      });
      symlinkSync("../example-cli/run", join(scratch, "node_modules/.bin/example-cli"));
      mkdirSync(join(scratch, "packages/widget/node_modules/nested-dependency"), { recursive: true });
      writeFileSync(
        join(scratch, "packages/widget/node_modules/nested-dependency/index.js"),
        "module.exports = 'workspace dependency';\n",
      );
      mkdirSync(join(scratch, "node_modules/nested-dependency"));
      writeFileSync(join(scratch, "node_modules/nested-dependency/index.js"), "module.exports = 'root dependency';\n");
      symlinkSync("../packages/widget", join(scratch, "node_modules/workspace-pkg"));
      for (const modules of ["node_modules", "packages/widget/node_modules"]) {
        mkdirSync(join(scratch, modules, "fixture"), { recursive: true });
        writeFileSync(join(scratch, modules, "fixture/index.js"), "stale archived fixture");
        mkdirSync(join(checkout, modules, "fixture"), { recursive: true });
        writeFileSync(join(checkout, modules, "fixture/index.js"), "tracked fixture");
      }
      mkdirSync(join(checkout, "node_modules/.bin"));
      symlinkSync("../fixture/index.js", join(checkout, "node_modules/.bin/fixture"));
      mkdirSync(bin);
      // Ownership is the container's concern; the actual producer and consumer
      // scripts run unchanged on an unprivileged development machine.
      writeFileSync(join(bin, "chown"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
      const produced = run(
        depsStoreCommitScript({
          scratchDir: scratch,
          stagingDir: join(root, "staging"),
          entryDir: entry,
          completePath: join(entry, ".complete"),
        }),
      );
      expect(produced.status, produced.stderr).toBe(0);
      cpSync(entry, restored, { recursive: true, verbatimSymlinks: true });
      for (const marker of [".complete", ".used"]) rmSync(join(restored, marker));
      mkdirSync(join(checkout, "packages/widget/node_modules/nested-dependency"), { recursive: true });
      writeFileSync(
        join(checkout, "packages/widget/node_modules/nested-dependency/value"),
        "stale checkout dependency\n",
      );
      writeFileSync(join(checkout, "packages/widget/index.js"), "module.exports = require('nested-dependency');\n");
      writeFileSync(join(checkout, "package.json"), '{"name":"fixture","workspaces":["packages/*"]}\n');
      writeFileSync(join(checkout, ".gitignore"), "node_modules/\n");
      git("init", "-q", "-b", "main");
      git("add", "package.json", ".gitignore", "packages/widget/index.js");
      git("add", "-f", "node_modules/fixture/index.js", "packages/widget/node_modules/fixture/index.js");
      git("add", "-f", "node_modules/.bin/fixture");
      git("-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-qm", "fixture");
      git("remote", "add", "origin", "https://example.com/acme/widgets.git");
      const fixed = run(
        seedFixupScript({
          slug: "acme/widgets",
          doorOrigin: "https://door.example",
          ref: "main",
          checkoutDir: checkout,
          depsDir: restored,
        }),
      );
      expect(fixed.status, fixed.stderr).toBe(0);
      const executable = spawnSync(join(checkout, "node_modules/.bin/example-cli"), [], { encoding: "utf8" });
      expect(executable.status, executable.error?.message ?? executable.stderr).toBe(0);
      expect(executable.stdout).toBe("root executable works");
      expect(readFileSync(join(checkout, "node_modules/.bin/fixture"), "utf8")).toBe("tracked fixture");
      const resolved = spawnSync(process.execPath, ["-e", "process.stdout.write(require('workspace-pkg'))"], {
        cwd: checkout,
        encoding: "utf8",
      });
      expect(resolved.status, resolved.stderr).toBe(0);
      expect(resolved.stdout).toBe("workspace dependency");
      expect(existsSync(join(checkout, "packages/widget/node_modules/nested-dependency/value"))).toBe(false);
      for (const modules of ["node_modules", "packages/widget/node_modules"]) {
        expect(readFileSync(join(checkout, modules, "fixture/index.js"), "utf8")).toBe("tracked fixture");
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("dependency entry materialization", () => {
  it.each(["entry symlink", "checkout symlink", "entry file", "checkout file"])(
    "refuses a tracked ancestor conflict (%s) before replacing any dependencies",
    (conflict) => {
      const root = mkdtempSync(join(tmpdir(), "switchboard-deps-source-conflict-"));
      const entry = join(root, "entry");
      const checkout = join(root, "checkout");
      const outside = join(root, "outside");
      try {
        mkdirSync(join(entry, "node_modules"), { recursive: true });
        mkdirSync(join(checkout, "node_modules"), { recursive: true });
        writeFileSync(join(checkout, "node_modules/sentinel"), "original dependencies");
        mkdirSync(join(checkout, "packages/widget/node_modules/fixture"), { recursive: true });
        writeFileSync(join(checkout, "packages/widget/node_modules/fixture/index.js"), "tracked fixture");
        expect(spawnSync("git", ["init", "-q", checkout]).status).toBe(0);
        expect(spawnSync("git", ["-C", checkout, "add", "packages"]).status).toBe(0);
        mkdirSync(join(entry, "packages/widget/node_modules/fixture"), { recursive: true });
        mkdirSync(outside);
        writeFileSync(join(outside, "index.js"), "outside");
        const conflictPath = join(
          conflict.startsWith("entry") ? entry : checkout,
          "packages/widget/node_modules/fixture",
        );
        rmSync(conflictPath, { recursive: true });
        if (conflict.endsWith("symlink")) symlinkSync(outside, conflictPath);
        else writeFileSync(conflictPath, "not a directory");
        const result = spawnSync("bash", ["-c", depsEntryMaterializeScript(entry, checkout)], { encoding: "utf8" });
        expect(result.status).not.toBe(0);
        expect(readFileSync(join(checkout, "node_modules/sentinel"), "utf8")).toBe("original dependencies");
        expect(readFileSync(join(outside, "index.js"), "utf8")).toBe("outside");
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
  );

  it("preserves dirty, deleted and symlinked tracked leaves while restoring siblings in their directories", () => {
    const root = mkdtempSync(join(tmpdir(), "switchboard-deps-source-leaves-"));
    const entry = join(root, "entry");
    const checkout = join(root, "checkout");
    try {
      for (const base of [entry, checkout]) mkdirSync(join(base, "node_modules/fixture"), { recursive: true });
      writeFileSync(join(checkout, "node_modules/fixture/dirty"), "original");
      writeFileSync(join(checkout, "node_modules/fixture/deleted"), "original");
      mkdirSync(join(checkout, "node_modules/fixture/absent"));
      writeFileSync(join(checkout, "node_modules/fixture/absent/index.js"), "original");
      symlinkSync("dirty", join(checkout, "node_modules/fixture/link"));
      expect(spawnSync("git", ["init", "-q", checkout]).status).toBe(0);
      expect(spawnSync("git", ["-C", checkout, "add", "node_modules"]).status).toBe(0);
      writeFileSync(join(checkout, "node_modules/fixture/dirty"), "local edits");
      rmSync(join(checkout, "node_modules/fixture/deleted"));
      rmSync(join(checkout, "node_modules/fixture/absent"), { recursive: true });
      writeFileSync(join(checkout, "node_modules/fixture/stale"), "stale dependency");
      for (const name of ["dirty", "deleted", "link", "dependency"]) {
        writeFileSync(join(entry, "node_modules/fixture", name), "archived content");
      }
      mkdirSync(join(entry, "node_modules/fixture/absent"));
      writeFileSync(join(entry, "node_modules/fixture/absent/index.js"), "stale source");
      writeFileSync(join(entry, "node_modules/fixture/absent/dependency"), "archived dependency");
      const result = spawnSync("bash", ["-c", depsEntryMaterializeScript(entry, checkout)], { encoding: "utf8" });
      expect(result.status, result.stderr).toBe(0);
      expect(readFileSync(join(checkout, "node_modules/fixture/dependency"), "utf8")).toBe("archived content");
      expect(readFileSync(join(checkout, "node_modules/fixture/dirty"), "utf8")).toBe("local edits");
      expect(readFileSync(join(checkout, "node_modules/fixture/link"), "utf8")).toBe("local edits");
      expect(existsSync(join(checkout, "node_modules/fixture/deleted"))).toBe(false);
      expect(existsSync(join(checkout, "node_modules/fixture/absent/index.js"))).toBe(false);
      expect(readFileSync(join(checkout, "node_modules/fixture/absent/dependency"), "utf8")).toBe(
        "archived dependency",
      );
      expect(existsSync(join(checkout, "node_modules/fixture/stale"))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it.each(["missing root", "escaped workspace", "file parent"])(
    "refuses %s before replacing dependencies",
    (failure) => {
      const root = mkdtempSync(join(tmpdir(), "switchboard-deps-invalid-"));
      const entry = join(root, "entry");
      const checkout = join(root, "checkout");
      const outside = join(root, "outside");
      try {
        mkdirSync(join(entry, "packages/widget/node_modules"), { recursive: true });
        mkdirSync(join(checkout, "node_modules"), { recursive: true });
        expect(spawnSync("git", ["init", "-q", checkout]).status).toBe(0);
        writeFileSync(join(checkout, "node_modules/sentinel"), "original dependencies");
        mkdirSync(join(outside, "node_modules"), { recursive: true });
        writeFileSync(join(outside, "node_modules/sentinel"), "outside");
        if (failure !== "missing root") mkdirSync(join(entry, "node_modules"));
        if (failure === "escaped workspace") symlinkSync(outside, join(checkout, "packages"));
        else if (failure === "file parent") writeFileSync(join(checkout, "packages"), "file");
        const result = spawnSync("bash", ["-c", depsEntryMaterializeScript(entry, checkout)], { encoding: "utf8" });
        expect(result.status).not.toBe(0);
        expect(readFileSync(join(checkout, "node_modules/sentinel"), "utf8")).toBe("original dependencies");
        expect(readFileSync(join(outside, "node_modules/sentinel"), "utf8")).toBe("outside");
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
  );

  it("accepts an empty entry, replaces only untracked dependency views, and omits absent workspaces", () => {
    const root = mkdtempSync(join(tmpdir(), "switchboard-deps-empty-"));
    const entry = join(root, "entry with spaces");
    const checkout = join(root, "checkout");
    try {
      mkdirSync(join(entry, "node_modules"), { recursive: true });
      mkdirSync(join(entry, "removed/node_modules"), { recursive: true });
      mkdirSync(join(checkout, "stale/node_modules"), { recursive: true });
      expect(spawnSync("git", ["init", "-q", checkout]).status).toBe(0);
      mkdirSync(join(checkout, "fixtures/node_modules/example"), { recursive: true });
      writeFileSync(join(checkout, "fixtures/node_modules/example/index.js"), "tracked fixture");
      expect(spawnSync("git", ["-C", checkout, "add", "fixtures"]).status).toBe(0);
      mkdirSync(join(entry, "fixtures/node_modules/example"), { recursive: true });
      writeFileSync(join(entry, "fixtures/node_modules/example/index.js"), "stale fixture");
      const result = spawnSync("bash", ["-c", depsEntryMaterializeScript(entry, checkout)], { encoding: "utf8" });
      expect(result.status, result.stderr).toBe(0);
      expect(existsSync(join(checkout, "node_modules"))).toBe(true);
      expect(existsSync(join(checkout, "removed"))).toBe(false);
      expect(existsSync(join(checkout, "stale/node_modules"))).toBe(false);
      expect(readFileSync(join(checkout, "fixtures/node_modules/example/index.js"), "utf8")).toBe("tracked fixture");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("the seed's constants", () => {
  it("everything the seed writes lives under /workspace, where the SDK allows a restore's dir", () => {
    for (const p of [SEED_CHECKOUT_DIR, SEED_DEPS_STAGING_DIR, SEED_MARKER])
      expect(p.startsWith("/workspace/")).toBe(true);
    expect(new Set([SEED_CHECKOUT_DIR, SEED_DEPS_STAGING_DIR, SEED_MARKER]).size).toBe(3);
  });

  it("the client's budget covers both restores' shared cap and the fix-up, with room for the answer", () => {
    expect(SEED_BUDGET_MS).toBeGreaterThan(SEED_RESTORE_MAX_MS + SEED_FIXUP_TIMEOUT_MS);
    // the wait for an abandoned restore fits inside the seed's own caps, so a failed seed still answers in budget
    expect(SEED_ABANDONED_RESTORE_WAIT_MS).toBeLessThan(SEED_RESTORE_MAX_MS);
    expect(SEED_REASONS).toEqual(["seed-missing", "seed-failed", "seed-unconfigured", "seed-incompatible"]);
  });
});

describe("isBackupMissing", () => {
  it("recognizes the SDK's missing-backup error by name across the RPC boundary, and by its two texts", () => {
    expect(isBackupMissing({ name: "BackupNotFoundError", message: "" })).toBe(true);
    expect(isBackupMissing({ message: "Backup not found: 3f2a. Verify the backup ID is correct" })).toBe(true);
    expect(
      isBackupMissing({ message: "Backup archive not found in R2: 3f2a. The archive may have been deleted" }),
    ).toBe(true);
    expect(isBackupMissing({ name: "TimeoutError", message: "restore timed out" })).toBe(false);
    expect(isBackupMissing({ message: "" })).toBe(false);
  });
});

// The sandbox Worker cannot run under vitest (a Durable Object and a
// container); its use of the plan is held statically, as sandboxLifecycle's
// wiring is, together with the image, the template and the secrets manifest.
describe("the seeded sandbox wiring (static)", () => {
  const read = (p: string) => readFileSync(new URL(`../../${p}`, import.meta.url), "utf8");
  const worker = read("deploy/cloudflare-sandbox/worker.ts");

  it("POST /seed parses the handle by field, then runs the seed inside the idle ledger and behind the start gate, streamed", () => {
    const route = worker.slice(worker.indexOf('case "/seed": {'), worker.indexOf('case "/read": {'));
    expect(route).toMatch(
      /const parsed = parseSeed\(body\.seed\);\s*if \(!parsed\.ok\) return json\(\{ error: parsed\.error \}, 400\)/,
    );
    expect(route).toContain("parsePreservationOwner(body.preservation, false)");
    expect(route).toContain(
      'if (claim && claim.thread !== threadKey) return json({ error: "invalid preservation thread" }, 400)',
    );
    expect(route).toMatch(
      /return streamSeed\(\s*\(\) => sandbox\.seed\(parsed\.seed, envVars, claim as OwnerClaim \| undefined\)/,
    );
    const seedRoute = worker.slice(worker.indexOf("async seed(seed:"), worker.indexOf("private claimMatches("));
    expect(seedRoute).toMatch(
      /return this\.idle\.served\(async \(\) => \{[\s\S]*?return this\.gate\.through\(\s*async \(\) => \{/,
    );
    expect(seedRoute).toContain("this.seedNow(seed, envVars, !!prior)");
  });

  it("a prior owner only accepts a cached answer and permits the checkout HEAD to advance", () => {
    const seedRoute = worker.slice(worker.indexOf("async seed(seed:"), worker.indexOf("private claimMatches("));
    expect(seedRoute).toMatch(
      /if \(prior && !answer\.cached\)\s*return \{\s*seeded: false,\s*reason: "seed-incompatible"/,
    );
    expect(seedRoute).toContain("seedClaimHeadMatches(claim.head, answer.sha, !!prior && answer.cached)");
    expect(seedRoute.indexOf("if (prior && !answer.cached)")).toBeLessThan(
      seedRoute.indexOf("seedClaimHeadMatches(claim.head, answer.sha"),
    );
  });

  it("a bound seed refuses a changed or missing second marker before restore, without a destructive sweep", () => {
    const seedNow = worker.slice(worker.indexOf("private async seedNow("), worker.indexOf("private seedSweep("));
    expect(seedNow).toContain("boundSeedMarkerDecision(");
    expect(seedNow).toContain("if (bound) return null;"); // a failed second read also refuses a bound seed
    expect(seedNow).toContain("marker?.exitCode === 0 ? marker.stdout.trim() : null");
    expect(seedNow).toMatch(
      /if \(markerDecision === "refuse"\)\s*return \{\s*seeded: false,\s*reason: "seed-incompatible"/,
    );
    const boundRetry = seedNow.slice(
      seedNow.indexOf('if (markerDecision === "refuse")'),
      seedNow.indexOf("const deadline ="),
    );
    expect(boundRetry).not.toMatch(/seedSweep|restoreSeedInto|rm -rf/);
    expect(seedNow.indexOf('if (markerDecision === "refuse")')).toBeLessThan(seedNow.indexOf("this.seedSweep()"));
  });

  it("presigned only: the transfer mode is read first and a local-mode Worker answers seed-unconfigured", () => {
    const seedNow = worker.slice(worker.indexOf("private async seedNow("), worker.indexOf("private seedSweep("));
    expect(seedNow.indexOf("backupTransferMode(")).toBeLessThan(seedNow.indexOf("SEED_MARKER"));
    expect(seedNow).toContain('reason: "seed-unconfigured"');
  });

  it("an incompatible cached dependency view refuses before origin writes and cannot reach the destructive restore or cleanup", () => {
    const cached = worker.slice(
      worker.indexOf('if (markerDecision === "cached")'),
      worker.indexOf("const deadline = t0 + SEED_RESTORE_MAX_MS"),
    );
    expect(cached).toContain("dependencyLayoutCommand(SEED_CHECKOUT_DIR)");
    expect(cached).toMatch(
      /if \(!layout \|\| layout.exitCode !== 0\)\s*return \{\s*seeded: false,\s*reason: "seed-incompatible"/,
    );
    expect(cached.indexOf('reason: "seed-incompatible"')).toBeLessThan(cached.indexOf("const origin"));
    expect(cached).not.toMatch(/seedSweep|restoreSeedInto|rm -rf|printf %s/);
  });

  it("the marker is read before any restore and written after the fix-up; the same handle answers cached", () => {
    const seedNow = worker.slice(worker.indexOf("private async seedNow("), worker.indexOf("private seedSweep("));
    expect(seedNow).toContain('seedDoorRemote(envVars.GIT_DOOR_ORIGIN ?? "", seed.slug)');
    expect(seedNow.indexOf('["cat", SEED_MARKER]')).toBeLessThan(seedNow.indexOf("restoreSeedInto("));
    expect(seedNow).toContain("marker?.exitCode === 0 ? marker.stdout.trim() : null");
    expect(seedNow).toContain("seedMarkerText(seed),");
    expect(seedNow).toContain('["git", "-C", SEED_CHECKOUT_DIR, "remote", "set-url", "origin", doorRemote]');
    expect(seedNow).toContain("cached: true");
    expect(seedNow.indexOf("printf %s ${shellQuote(seedMarkerText(seed))}")).toBeGreaterThan(
      seedNow.indexOf("seedFixupScript("),
    );
  });

  it("every restore answers its two phases — the download judged by bytes, then the extraction — and the seed carries them as `phases` in its answer and its log line", () => {
    const restore = worker.slice(
      worker.indexOf("private async restoreSeedInto("),
      worker.indexOf("private readonly pendingRestores"),
    );
    expect(restore).toContain("): Promise<RestorePhases> {");
    expect(restore.indexOf("const download = systemClock() - startedMs;")).toBeLessThan(
      restore.indexOf("extractRestoreScript({"),
    );
    expect(restore).toContain("const extract = systemClock() - extractStartedMs;");
    expect(restore).toContain('event: "sandbox.seed-restore"');
    expect(restore).toContain("return { download, extract };");
    const seedNow = worker.slice(worker.indexOf("private async seedNow("), worker.indexOf("private seedSweep("));
    expect(seedNow).toContain("const phases: SeedPhases = { checkout, deps: null };");
    expect(seedNow).toMatch(/event: "sandbox\.seeded",[\s\S]*?phases,/);
    expect(seedNow).toMatch(/return \{\s*seeded: true,\s*cached: false,[\s\S]*?phases,[\s\S]*?\};/);
  });

  it("every restore is judged by bytes against the seed's one deadline and extracted onto the disk; a failure sweeps mounts, tree and marker and is classified missing or failed", () => {
    expect(worker).toMatch(/judgeRestoreProgress\(\{ startedMs, nowMs: systemClock\(\), samples, deadlineMs \}\)/);
    expect(worker).toMatch(
      /extractRestoreScript\(\{ mountDir, backupId: id, archivePath: restoreArchivePath\(id\), targetDir \}\)/,
    );
    expect((worker.match(/unmountAllRestoresScript\(\)/g) ?? []).length).toBeGreaterThanOrEqual(2);
    expect(worker).toContain('isBackupMissing(shape) ? "seed-missing" : "seed-failed"');
  });

  it("the streamed /seed answer has its own root, keeps a start or a full fleet's wait token, and never answers a throw as anything but seed-failed", () => {
    const streamSeed = worker.slice(worker.indexOf("function streamSeed("), worker.indexOf("type WaitAnswer ="));
    expect(streamSeed).toContain('"sandbox.seed"');
    expect(streamSeed).toContain("fleetBusyAnswer(raw)");
    expect(streamSeed).toContain("runtimeUnreachableAnswer(raw)");
    expect(streamSeed).toContain('reason: "seed-failed"');
  });

  it("a restore-progress sample the container could not take is no evidence — never the seed's failure", () => {
    const du = worker.slice(worker.indexOf("private async duKiB("), worker.indexOf("private async runRoot("));
    expect(du).toMatch(
      /try \{\s*r = await this\.runRoot\(\["du", "-sk", \.\.\.paths\], 30_000\);\s*\} catch \{\s*return null;/,
    );
    expect(du).toContain("if (r.exitCode === 124) return null;");
  });

  it("/healthz says which transfer mode is live, so a receipt can tell a seedable Worker from one that is not", () => {
    expect(worker).toMatch(/\/healthz[\s\S]*?backupTransfer: backupTransferMode\(/);
  });

  it("the image carries squashfs-tools and proves unsquashfs at build time, as the resident's does", () => {
    const dockerfile = read("deploy/cloudflare-sandbox/Dockerfile");
    expect(dockerfile).toMatch(/apt-get install -y --no-install-recommends [^\n]*squashfs-tools/);
    expect(dockerfile).toContain("command -v unsquashfs >/dev/null");
  });

  it("gets rg from the image in fresh and seeded sandboxes; seed restore changes disk contents and never downloads the agent's search tool", () => {
    const dockerfile = read("deploy/cloudflare-sandbox/Dockerfile");
    expect(dockerfile).toMatch(/apt-get install -y --no-install-recommends [^\n]*ripgrep/);
    expect(dockerfile).toContain("command -v rg >/dev/null");
    expect(worker).not.toMatch(/(?:curl|wget|npm|pnpm|bun)[^\n]*(?:ripgrep|BurntSushi)/i);
    expect(
      seedFixupScript({ ...seed, doorOrigin: "https://door.example", checkoutDir: SEED_CHECKOUT_DIR }),
    ).not.toMatch(/\brg\b|ripgrep/i);
  });

  it("the template binds the resident's cache bucket and names it, inside a block a profile without a resident drops", () => {
    const template = read("deploy/cloudflare-sandbox/wrangler.template.jsonc");
    const block = template.slice(template.indexOf("// {{#if resident}}"), template.indexOf("// {{/if}}"));
    expect(block).toContain('"BACKUP_BUCKET_NAME": "{{resident.script}}-cache"');
    expect(block).toContain(
      '"r2_buckets": [{ "binding": "BACKUP_BUCKET", "bucket_name": "{{resident.script}}-cache" }]',
    );
    expect(block).toContain('"CLOUDFLARE_ACCOUNT_ID": "{{account}}"');
  });

  it("the R2 token reaches the sandbox Worker too, optional on both", () => {
    const manifest = JSON.parse(read("deploy/secrets.manifest.json")) as {
      secrets: Array<{ name: string; workers: string[]; optional?: unknown }>;
    };
    for (const name of ["R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY"]) {
      const entry = manifest.secrets.find((s) => s.name === name);
      expect(entry?.workers).toEqual(["resident", "sandbox"]);
      expect(entry?.optional).toBe(true);
    }
  });

  it("the resident publishes the snapshot handle — the checkout's id and the deps entry's — on /status, the route the bot probes", () => {
    const resident = read("deploy/cloudflare-resident/worker.ts");
    const handle = resident.slice(
      resident.indexOf("async snapshotHandle("),
      resident.indexOf("async getResidentInfo("),
    );
    expect(handle).toContain("checkoutBackupId: record.checkout.id");
    expect(handle).toContain("depsBackupId: (await this.depsBackupRecord(record.lockfileHash))?.backup.id ?? null");
    const status = resident.slice(resident.indexOf("async function handleStatus("));
    const body = status.slice(0, status.indexOf("\n}\n"));
    expect(body).toContain("stub.snapshotHandle()");
    expect(body).toMatch(/return json\(\{[\s\S]*?\bsnapshot,[\s\S]*?\}\);/);
  });
});

describe("the seeded sandbox wiring (static) — a restore the judge gave up on", () => {
  const worker = readFileSync(new URL("../../deploy/cloudflare-sandbox/worker.ts", import.meta.url), "utf8");
  it("is remembered until it settles, never rejects unhandled, and is waited for (bounded) before the failure sweep", () => {
    expect(worker).toMatch(/this\.pendingRestores\.add\(restore\);\s*restore\.then\(/);
    const catchBlock = worker.slice(worker.indexOf("    } catch (err) {", worker.indexOf("private async seedNow(")));
    expect(catchBlock.indexOf("settlePendingRestores(SEED_ABANDONED_RESTORE_WAIT_MS)")).toBeGreaterThan(-1);
    expect(catchBlock.indexOf("settlePendingRestores(")).toBeLessThan(catchBlock.indexOf("unmountAllRestoresScript()"));
  });
});

describe("seedMarkerText", () => {
  it("names the handle, the ref the tree is on and the head asked for, so a seed on another ref is a new seed", () => {
    expect(seedMarkerText(seed)).toBe(`${seed.checkoutBackupId} ${seed.depsBackupId} main -`);
    expect(seedMarkerText({ ...seed, fetchRef: "feat/x" })).toBe(
      `${seed.checkoutBackupId} ${seed.depsBackupId} feat/x -`,
    );
    expect(seedMarkerText({ ...seed, fetchRef: "feat/x", fetchSha: "89abcdef0123456789abcdef0123456789abcdef" })).toBe(
      `${seed.checkoutBackupId} ${seed.depsBackupId} feat/x 89abcdef0123456789abcdef0123456789abcdef`,
    );
    expect(seedMarkerText({ ...seed, fetchRef: "feat/y" })).not.toBe(seedMarkerText({ ...seed, fetchRef: "feat/x" }));
    expect(seedMarkerText({ ...seed, depsBackupId: "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb" })).not.toBe(
      seedMarkerText(seed),
    );
  });
});

// The bot's half of the plan (docs/reference/specs/execution.md item 26): the
// thread's seed from the resident's handle, the retry-then-cold decision after
// a refusal, the card's line.
describe("seedForThread", () => {
  const handle = {
    checkoutBackupId: seed.checkoutBackupId,
    depsBackupId: seed.depsBackupId!,
    ref: "main",
    sha: seed.sha,
  };
  it("carries the handle and the thread's ref and head; a thread without a ref stays on the snapshot's branch", () => {
    expect(
      seedForThread(handle, {
        slug: "acme/widgets",
        ref: "feat/x",
        headSha: "89abcdef0123456789abcdef0123456789abcdef",
      }),
    ).toEqual({
      ...seed,
      fetchRef: "feat/x",
      fetchSha: "89abcdef0123456789abcdef0123456789abcdef",
    });
    expect(seedForThread(handle, { slug: "acme/widgets" })).toEqual(seed);
    // a head without a ref is nothing to check out
    expect(
      seedForThread(handle, { slug: "acme/widgets", headSha: "89abcdef0123456789abcdef0123456789abcdef" }),
    ).toEqual(seed);
  });
  it("a handle without a deps entry seeds the checkout alone", () => {
    const { depsBackupId: _d, ...bare } = handle;
    expect(seedForThread(bare, { slug: "acme/widgets" })).not.toHaveProperty("depsBackupId");
  });
});

describe("seedRetryDecision", () => {
  const attempted = { ...seed, fetchRef: "feat/x" };
  const missing = {
    seeded: false as const,
    reason: "seed-missing" as const,
    detail: "restore: Backup not found: 3f2a",
  };
  it("the handle's objects gone and a newer handle published → retry once with it, on the same thread ref", () => {
    const fresh = {
      checkoutBackupId: "9999aaaa-bbbb-cccc-dddd-eeeeffff0000",
      ref: "main",
      sha: "89abcdef0123456789abcdef0123456789abcdef",
    };
    expect(seedRetryDecision({ answer: missing, attempted, fresh, alreadyRetried: false })).toEqual({
      action: "retry",
      seed: {
        slug: seed.slug,
        checkoutBackupId: fresh.checkoutBackupId,
        ref: "main",
        sha: fresh.sha,
        fetchRef: "feat/x",
      },
    });
  });
  it("the same handle again, or none, or a second miss → cold, saying why", () => {
    const same = { checkoutBackupId: seed.checkoutBackupId, ref: "main", sha: seed.sha };
    expect(seedRetryDecision({ answer: missing, attempted, fresh: same, alreadyRetried: false })).toEqual({
      action: "cold",
      why: "seed missing (restore: Backup not found: 3f2a) and the resident published no newer handle",
    });
    expect(seedRetryDecision({ answer: missing, attempted, fresh: undefined, alreadyRetried: false }).action).toBe(
      "cold",
    );
    expect(
      seedRetryDecision({
        answer: missing,
        attempted,
        fresh: { ...same, checkoutBackupId: "9999aaaa-bbbb-cccc-dddd-eeeeffff0000" },
        alreadyRetried: true,
      }).action,
    ).toBe("cold");
  });
  it("a failed or unconfigured seed is never retried", () => {
    expect(
      seedRetryDecision({
        answer: { seeded: false, reason: "seed-failed", detail: "fixup: fix-up exited 128", step: "fixup" },
        attempted,
        fresh: { checkoutBackupId: "9999aaaa-bbbb-cccc-dddd-eeeeffff0000", ref: "main", sha: seed.sha },
        alreadyRetried: false,
      }),
    ).toEqual({ action: "cold", why: "seed failed (fixup: fix-up exited 128)" });
    expect(
      seedRetryDecision({
        answer: { seeded: false, reason: "seed-unconfigured", detail: "presigned R2 transfer needs R2_ACCESS_KEY_ID" },
        attempted,
        fresh: undefined,
        alreadyRetried: false,
      }),
    ).toEqual({ action: "cold", why: "seed unconfigured (presigned R2 transfer needs R2_ACCESS_KEY_ID)" });
  });
});

describe("seededSandboxNote", () => {
  it("names the reason the resident was not used, then what the sandbox was seeded from — ref@sha7", () => {
    expect(
      seededSandboxNote("resident degraded (disk-pressure)", {
        slug: "acme/widgets",
        ref: "feat/x",
        sha: "89abcdef0123456789abcdef0123456789abcdef",
        cached: false,
      }),
    ).toBe(
      "resident degraded (disk-pressure) — seeded sandbox · from resident snapshot · acme/widgets · feat/x@89abcde",
    );
    expect(
      seededSandboxNote("resident restoring", { slug: "a/b", ref: "main", sha: seed.sha, cached: true }),
    ).toContain("(already seeded)");
  });
});
