import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { PREPARE_COMMIT_MSG_HOOK } from "./e2b.js";

// Feature: docs/reference/specs/execution.md item 5 — the agent trailer
// (record 0062): every image carries deploy/hooks/prepare-commit-msg through
// core.hooksPath, appending `Co-Authored-By: <bot pair>` from
// GIT_COMMITTER_NAME/GIT_COMMITTER_EMAIL at commit time (the image's own git
// identity standing in without them), idempotently; and every image's
// fallback user.email is OFF the GitHub domain, so an unidentified commit
// never renders as a GitHub account. The sandbox and resident images build
// from their own directory, so each carries a byte-identical copy; E2B setup
// writes the same bytes from its constant.

const ROOT = resolve(import.meta.dirname, "../..");
const HOOK = resolve(ROOT, "deploy/hooks/prepare-commit-msg");
const HOOKS_DIR = resolve(ROOT, "deploy/hooks");
const canonical = readFileSync(HOOK, "utf8");

const BOT_ENV = {
  GIT_COMMITTER_NAME: "switchboard-app[bot]",
  GIT_COMMITTER_EMAIL: "111+switchboard-app[bot]@users.noreply.github.com",
};
const TRAILER = `Co-Authored-By: ${BOT_ENV.GIT_COMMITTER_NAME} <${BOT_ENV.GIT_COMMITTER_EMAIL}>`;

/** The test process's env without any GIT_* the caller might carry, plus `extra`. */
function envWith(extra: Record<string, string>): NodeJS.ProcessEnv {
  const clean = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("GIT_")));
  return { ...clean, ...extra };
}

function repoWith(config: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "swb-hook-"));
  const git = (...args: string[]) => execFileSync("git", args, { cwd: dir, env: envWith({}) });
  git("init", "-q");
  for (const [key, value] of Object.entries(config)) git("config", key, value);
  writeFileSync(join(dir, "a.txt"), "a\n");
  git("add", "a.txt");
  return dir;
}

describe("one hook, every image (deploy/hooks/prepare-commit-msg)", () => {
  it("the sandbox and resident image copies and the E2B constant are byte-identical to the canonical file", () => {
    expect(readFileSync(resolve(ROOT, "deploy/cloudflare-sandbox/prepare-commit-msg"), "utf8")).toBe(canonical);
    expect(readFileSync(resolve(ROOT, "deploy/cloudflare-resident/prepare-commit-msg"), "utf8")).toBe(canonical);
    expect(PREPARE_COMMIT_MSG_HOOK).toBe(canonical);
  });

  it("the root image's build context lets the hook through (.dockerignore re-includes it)", () => {
    // The bot image builds from the repo root, whose .dockerignore excludes
    // deploy/ wholesale; without this negation its COPY of the hook fails at
    // build time (the image CI leg), which this pin catches in seconds.
    const lines = readFileSync(resolve(ROOT, ".dockerignore"), "utf8").split("\n");
    expect(lines).toContain("!deploy/hooks/prepare-commit-msg");
  });

  it("every image wires core.hooksPath at the hook and a fallback address off the GitHub domain", () => {
    for (const file of [
      "Dockerfile",
      "deploy/cloudflare-sandbox/Dockerfile",
      "deploy/cloudflare-resident/Dockerfile",
    ]) {
      const text = readFileSync(resolve(ROOT, file), "utf8");
      expect(text, file).toMatch(/core\.hooksPath \/opt\/switchboard\/hooks/);
      expect(text, file).toMatch(/prepare-commit-msg \/opt\/switchboard\/hooks\/prepare-commit-msg/);
      expect(text, file).not.toMatch(/user\.email "[^"]*github\.com"/);
      expect(text, file).toMatch(/user\.email "switchboard-(bot|resident)@switchboard\.invalid"/);
    }
    const e2b = readFileSync(resolve(ROOT, "src/execution/e2b.ts"), "utf8");
    expect(e2b).toContain(`git config --global core.hooksPath `);
    expect(e2b).toContain(`user.email "switchboard-bot@switchboard.invalid"`);
    expect(e2b).not.toContain(`user.email "switchboard-bot@users.noreply.github.com"`);
  });
});

describe("the hook on a message file", () => {
  const runHook = (msgFile: string, env: Record<string, string>) =>
    execFileSync("sh", [HOOK, msgFile], { env: envWith(env), cwd: tmpdir() });

  it("appends the trailer built from GIT_COMMITTER_* to a message without one and leaves a message that has it unchanged", () => {
    const msgFile = join(mkdtempSync(join(tmpdir(), "swb-hook-msg-")), "msg");
    writeFileSync(msgFile, "one\n");
    runHook(msgFile, BOT_ENV);
    const once = readFileSync(msgFile, "utf8");
    expect(once).toBe(`one\n\n${TRAILER}\n`);
    runHook(msgFile, BOT_ENV); // idempotent: the same trailer is not added twice
    expect(readFileSync(msgFile, "utf8")).toBe(once);
  });

  it("a foreign Co-Authored-By does not stop it — the bot's trailer is still added", () => {
    const msgFile = join(mkdtempSync(join(tmpdir(), "swb-hook-msg-")), "msg");
    writeFileSync(msgFile, "one\n\nCo-Authored-By: stranger <s@example.com>\n");
    runHook(msgFile, BOT_ENV);
    const text = readFileSync(msgFile, "utf8");
    expect(text).toContain("Co-Authored-By: stranger <s@example.com>");
    expect(text).toContain(TRAILER);
  });
});

describe("git commit under the hook (core.hooksPath)", () => {
  const log = (dir: string) =>
    execFileSync("git", ["log", "-1", "--format=%an%n%ae%n%cn%n%ce%n%B"], { cwd: dir, env: envWith({}) })
      .toString()
      .split("\n");

  it("with the four variables set: author the requester pair, committer the bot pair, trailer the bot pair", () => {
    const dir = repoWith({ "core.hooksPath": HOOKS_DIR });
    execFileSync("git", ["commit", "-q", "-m", "feat: x"], {
      cwd: dir,
      env: envWith({
        ...BOT_ENV,
        GIT_AUTHOR_NAME: "ivy-dev",
        GIT_AUTHOR_EMAIL: "4242+ivy-dev@users.noreply.github.com",
      }),
    });
    const [an, ae, cn, ce, ...body] = log(dir);
    expect([an, ae]).toEqual(["ivy-dev", "4242+ivy-dev@users.noreply.github.com"]);
    expect([cn, ce]).toEqual([BOT_ENV.GIT_COMMITTER_NAME, BOT_ENV.GIT_COMMITTER_EMAIL]);
    expect(body.join("\n")).toContain(TRAILER);
  });

  it("with none set: the image fallback name and a non-GitHub address, on the commit and in the trailer", () => {
    const dir = repoWith({
      "core.hooksPath": HOOKS_DIR,
      // the images' own fallback identity (Dockerfile, git config --system/--global)
      "user.name": "switchboard-bot",
      "user.email": "switchboard-bot@switchboard.invalid",
    });
    execFileSync("git", ["commit", "-q", "-m", "feat: x"], { cwd: dir, env: envWith({}) });
    const [an, ae, cn, ce, ...body] = log(dir);
    expect([an, ae, cn, ce]).toEqual([
      "switchboard-bot",
      "switchboard-bot@switchboard.invalid",
      "switchboard-bot",
      "switchboard-bot@switchboard.invalid",
    ]);
    expect(ce).not.toContain("github.com");
    expect(body.join("\n")).toContain("Co-Authored-By: switchboard-bot <switchboard-bot@switchboard.invalid>");
  });
});
