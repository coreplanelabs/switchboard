import { describe, expect, it } from "vitest";
import { reviewTargetBlock } from "./reviewTarget.js";

// Feature: docs/reference/specs/agent-review.md item 9 — the review agent is TOLD what it is
// reviewing, deterministically, from the facts Switchboard resolved before the
// model turn (repo, PR, head branch/commit, base). An agent handed only a URL
// and a prompt saying the worktree was "typically" the branch under review
// went looking and reviewed another PR's branch. Item 8's guard is the
// backstop; this is the fix.

const SHA = "e8e43f480a09b76989b85ebe6a2a254d99a4d2a3";

describe("reviewTargetBlock", () => {
  const full = { repo: "acme/api", pr: 42, ref: "patch-1", headSha: SHA, baseRef: "main" };

  it("resident path: names every resolved fact and pins the first command to a HEAD check", () => {
    const b = reviewTargetBlock({ ...full, resident: true });
    expect(b.startsWith("REVIEW TARGET")).toBe(true);
    expect(b).toContain("Repository: acme/api");
    expect(b).toContain(`Pull request: #${full.pr} — https://github.com/acme/api/pull/${full.pr}`);
    expect(b).toContain("Head branch: patch-1");
    expect(b).toContain(`Head commit: ${SHA}`);
    expect(b).toContain("Base branch: main");
    expect(b).toContain("The worktree is already at that head");
    expect(b).toMatch(/FIRST command: `git rev-parse HEAD`/);
    expect(b).toMatch(/STOP/);
    expect(b).toMatch(/do not fetch or check out anything/i);
    expect(b).toContain("`origin/main` is already present");
    expect(b).toMatch(/do NOT run `git fetch`/);
    expect(b).toContain("`head` to submit_verdict");
    expect(b).not.toMatch(/gh pr checkout/);
  });

  it("sandbox path: clone + gh pr checkout, then the same HEAD check; no worktree claims", () => {
    const b = reviewTargetBlock({ ...full, resident: false });
    expect(b).toContain("`gh pr checkout 42`");
    expect(b).toMatch(/`git rev-parse HEAD`/);
    expect(b).toMatch(/STOP/);
    expect(b).not.toContain("worktree is already");
    expect(b).not.toContain("do NOT run `git fetch`");
  });

  it("unknown head branch / base are named as unknown, never invented", () => {
    const b = reviewTargetBlock({ repo: "acme/api", pr: 7, headSha: SHA, resident: true });
    expect(b).toContain("Head branch: unknown");
    expect(b).toContain("Base branch: the repository's default branch");
    expect(b).toContain("`origin/HEAD`"); // the diff base when the base branch is unknown
  });

  it("unknown head commit: says so and asks for `git rev-parse HEAD` as the reported head — no STOP rule to compare against", () => {
    const b = reviewTargetBlock({ repo: "acme/api", pr: 7, ref: "patch-1", baseRef: "main", resident: true });
    expect(b).toContain("Head commit: unknown");
    expect(b).not.toMatch(/must equal/);
    expect(b).toContain("`head` to submit_verdict");
  });

  // A worktree attached at the PR head does not stop an agent whose first
  // command is `cd /workspace`: it then finds the resident's warm
  // default-branch checkout with `find`, reads `main`'s HEAD there and reports
  // a false mismatch. The block names the worktree and forbids leaving it.
  it("resident path with the worktree path: names it, pins every command to it, forbids cd/find", () => {
    const b = reviewTargetBlock({
      ...full,
      resident: true,
      workspace: "/workspace/threads/slack-C1-9.0-ab12cd34/patch-1",
    });
    expect(b).toContain("`/workspace/threads/slack-C1-9.0-ab12cd34/patch-1`");
    expect(b).toMatch(/never `cd` out of it/i);
    expect(b).toMatch(/search the filesystem/i);
    expect(b).toMatch(/any other checkout on this host/i);
    expect(b).toMatch(/FIRST command: `git rev-parse HEAD` \(from the current directory, no `cd`\)/);
  });

  it("resident path without a worktree path: no path is invented, the no-cd rule still stands", () => {
    const b = reviewTargetBlock({ ...full, resident: true });
    expect(b).not.toMatch(/\/workspace\//);
    expect(b).toMatch(/no `cd`/);
  });

  it("verifiedAtAttach: says Switchboard already checked the attached commit; absent otherwise", () => {
    const verified = reviewTargetBlock({ ...full, resident: true, verifiedAtAttach: true });
    expect(verified).toMatch(/Switchboard attached this worktree at that commit and verified it before this run/);
    expect(verified).toMatch(/STOP/); // the model-side check stays as the backstop for drift after attach
    expect(reviewTargetBlock({ ...full, resident: true })).not.toMatch(/verified it before this run/);
    // Never claimed on the sandbox path — nothing was attached there.
    expect(reviewTargetBlock({ ...full, resident: false, verifiedAtAttach: true })).not.toMatch(
      /verified it before this run/,
    );
  });

  // docs/reference/specs/agent-review.md item 15 — the block states the PR's size
  // from GitHub, so a diff or digest that shows less is recognizably cut short.
  it("states the PR's size from GitHub with the read-the-rest rule when known; says nothing about size when unknown", () => {
    const b = reviewTargetBlock({
      ...full,
      resident: true,
      size: { changedFiles: 41, additions: 2459, deletions: 579 },
    });
    expect(b).toContain("Size (GitHub): 41 files, +2459/−579");
    expect(b).toMatch(/cut short/);
    expect(b).toMatch(/file by file/);
    expect(b).toMatch(/does not post a verdict whose digest covered less/);
    expect(
      reviewTargetBlock({ ...full, resident: false, size: { changedFiles: 1, additions: 3, deletions: 0 } }),
    ).toContain("Size (GitHub): 1 file, +3/−0");
    expect(reviewTargetBlock({ ...full, resident: true })).not.toMatch(/Size \(GitHub\)/);
  });

  it("is deterministic (same input, same text)", () => {
    expect(reviewTargetBlock({ ...full, resident: true })).toBe(reviewTargetBlock({ ...full, resident: true }));
  });
});
