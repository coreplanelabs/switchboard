import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  legacyCredentialScrubCommand,
  legacyStageContentScanCommand,
  legacyStageReuseScrubCommand,
} from "./legacyCredentials";

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

function stageContent(stage: string): string {
  const [file, ...args] = legacyStageContentScanCommand(stage);
  return execFileSync(file!, args, { encoding: "utf8", stdio: "pipe" });
}

function scrubStage(stage: string): void {
  const [file, ...args] = legacyStageReuseScrubCommand(stage);
  execFileSync(file!, args, { stdio: "pipe" });
}

describe("legacy resident credential cleanup", () => {
  it("refuses reuse of a UID with a credential or staged write without reading either", () =>
    fixture((root) => {
      const stage = join(root, "stage");
      expect(stageContent(stage)).toBe("clean\n");
      mkdirSync(stage);
      expect(stageContent(stage)).toBe("clean\n");
      writeFileSync(join(stage, "cred"), "old-token");
      expect(stageContent(stage)).toBe("stale\n");
      rmSync(join(stage, "cred"));
      writeFileSync(join(stage, "put"), "old-payload");
      expect(stageContent(stage)).toBe("stale\n");
    }));

  it("fails closed on a linked staging directory", () =>
    fixture((root) => {
      const outside = join(root, "outside");
      mkdirSync(outside);
      symlinkSync(outside, join(root, "stage"));
      expect(() => stageContent(join(root, "stage"))).toThrow();
    }));

  it("cleans a failed write's stage file without following a linked stage", () =>
    fixture((root) => {
      const stage = join(root, "stage");
      mkdirSync(stage);
      writeFileSync(join(stage, "put"), "old-payload");
      writeFileSync(join(stage, "cred"), "old-token");
      scrubStage(stage);
      expect(stageContent(stage)).toBe("clean\n");

      const outside = join(root, "outside");
      mkdirSync(outside);
      writeFileSync(join(outside, "put"), "outside-payload");
      rmSync(stage, { recursive: true });
      symlinkSync(outside, stage);
      expect(() => scrubStage(stage)).toThrow();
      expect(readFileSync(join(outside, "put"), "utf8")).toBe("outside-payload");
    }));

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

  it("removes a superseded ref's App token even if its checkout remains beside the replacement", () =>
    fixture((root) => {
      const threadDir = join(root, "thread");
      const prior = join(threadDir, "prior-ref");
      const replacement = join(threadDir, "replacement-ref");
      mkdirSync(join(prior, ".git"), { recursive: true });
      mkdirSync(join(replacement, ".git"), { recursive: true });
      writeFileSync(join(prior, ".git", "github-credentials"), "old-token");
      writeFileSync(join(prior, "scratch"), "retained checkout");

      scrub(prior, join(root, "missing-stage"));

      expect(readFileSync(join(prior, "scratch"), "utf8")).toBe("retained checkout");
      expect(() => readFileSync(join(prior, ".git", "github-credentials"))).toThrow();
      expect(realpathSync(replacement)).toBe(replacement);
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
