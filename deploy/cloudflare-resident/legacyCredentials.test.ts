import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { legacyCredentialScrubCommand } from "./legacyCredentials";

function fixture(run: (root: string) => void): void {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "resident-cred-scrub-")));
  try {
    run(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function scrub(worktree: string, stage: string): void {
  const [file, ...args] = legacyCredentialScrubCommand(worktree, stage);
  execFileSync(file!, args, { stdio: "pipe" });
}

describe("legacy resident credential cleanup", () => {
  it("removes both old App token files before reuse", () =>
    fixture((root) => {
      const worktree = join(root, "worktree");
      const gitDir = join(worktree, ".git");
      const stage = join(root, "stage");
      mkdirSync(gitDir, { recursive: true });
      mkdirSync(stage);
      writeFileSync(join(gitDir, "github-credentials"), "old-token");
      writeFileSync(join(stage, "cred"), "old-token");
      scrub(worktree, stage);
      expect(() => readFileSync(join(gitDir, "github-credentials"))).toThrow();
      expect(() => readFileSync(join(stage, "cred"))).toThrow();
    }));

  it("refuses a symlinked worktree Git directory without deleting its target", () =>
    fixture((root) => {
      const worktree = join(root, "worktree");
      const outside = join(root, "outside");
      mkdirSync(worktree);
      mkdirSync(outside);
      writeFileSync(join(outside, "github-credentials"), "outside-token");
      symlinkSync(outside, join(worktree, ".git"));
      expect(() => scrub(worktree, join(root, "missing-stage"))).toThrow();
      expect(readFileSync(join(outside, "github-credentials"), "utf8")).toBe("outside-token");
    }));

  it("refuses a symlinked stage directory without deleting its target", () =>
    fixture((root) => {
      const worktree = join(root, "worktree");
      const outside = join(root, "outside");
      mkdirSync(join(worktree, ".git"), { recursive: true });
      mkdirSync(outside);
      writeFileSync(join(outside, "cred"), "outside-token");
      symlinkSync(outside, join(root, "stage"));
      expect(() => scrub(worktree, join(root, "stage"))).toThrow();
      expect(readFileSync(join(outside, "cred"), "utf8")).toBe("outside-token");
    }));
});
