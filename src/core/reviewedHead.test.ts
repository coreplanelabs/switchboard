import { describe, expect, it } from "vitest";
import { checkReviewedHead, parseRevParseOutput } from "./reviewedHead.js";

// Feature: docs/reference/specs/agent-review.md item 8 — a review is posted to a PR only
// when the head the agent actually reviewed is the PR head resolved for the
// run. Otherwise an agent that fetched and reviewed another PR's branch gets
// its `LGTM:` posted — and auto-approved — on the wrong PR. This check is
// fail-closed: unknown or unverifiable → no post.

const PR_HEAD = "e8e43f480a09b76989b85ebe6a2a254d99a4d2a3";
const OTHER = "d75b5a51aba97d43c64a42c96e580dd9abbfd78e";

describe("checkReviewedHead", () => {
  it("passes when the observed HEAD equals the PR head", () => {
    expect(checkReviewedHead({ expected: PR_HEAD, observed: PR_HEAD })).toEqual({
      ok: true,
      head: PR_HEAD,
      source: "observed",
    });
  });

  it("fails with the authoritative source and full divergence when the observed HEAD is another commit", () => {
    const r = checkReviewedHead({ expected: PR_HEAD, observed: OTHER, reported: OTHER });
    expect(r.ok).toBe(false);
    if (!r.ok)
      expect(r.reason).toBe(
        `workspace-observed reviewed head ${OTHER} is not the PR head ${PR_HEAD}; they first differ at hex 1 (d ≠ e)`,
      );
  });

  it("shows a divergence beyond an accepted-looking seven-character prefix instead of printing two identical prefixes", () => {
    const expected = "abcdef0111111111111111111111111111111111";
    const observed = "abcdef0222222222222222222222222222222222";
    const r = checkReviewedHead({ expected, observed });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toContain(`workspace-observed reviewed head ${observed}`);
      expect(r.reason).toContain(`PR head ${expected}`);
      expect(r.reason).toContain("first differ at hex 8 (2 ≠ 1)");
    }
  });

  it("the observed HEAD is authoritative: a matching reported head cannot rescue a mismatching observed one", () => {
    expect(checkReviewedHead({ expected: PR_HEAD, observed: OTHER, reported: PR_HEAD }).ok).toBe(false);
  });

  it("falls back to the agent-reported head when nothing was observed (cold sandbox: cwd is not the clone)", () => {
    expect(checkReviewedHead({ expected: PR_HEAD, reported: PR_HEAD })).toEqual({
      ok: true,
      head: PR_HEAD,
      source: "reported",
    });
    expect(checkReviewedHead({ expected: PR_HEAD, reported: PR_HEAD.slice(0, 7) })).toEqual({
      ok: true,
      head: PR_HEAD.slice(0, 7),
      source: "reported",
    });
  });

  it("a reported head that mismatches names the model report as its source", () => {
    const reported = OTHER.slice(0, 12);
    const r = checkReviewedHead({ expected: PR_HEAD, reported });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain(`model-reported reviewed head ${reported}`);
  });

  it("fails closed when the PR head is unknown (resolution-time fetch failed)", () => {
    const r = checkReviewedHead({ observed: PR_HEAD, reported: PR_HEAD });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/PR head unknown/);
  });

  it("fails closed when neither an observed nor a reported head exists", () => {
    const r = checkReviewedHead({ expected: PR_HEAD });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/reviewed head unknown/);
  });

  it("a reported head that is not hex, or shorter than 7 chars, counts as absent", () => {
    expect(checkReviewedHead({ expected: PR_HEAD, reported: "HEAD" }).ok).toBe(false);
    expect(checkReviewedHead({ expected: PR_HEAD, reported: PR_HEAD.slice(0, 6) }).ok).toBe(false);
  });

  it("comparison is case-insensitive on hex", () => {
    expect(checkReviewedHead({ expected: PR_HEAD, reported: PR_HEAD.toUpperCase() }).ok).toBe(true);
  });
});

describe("parseRevParseOutput", () => {
  it("extracts the 40-hex line from `git rev-parse HEAD` output", () => {
    expect(parseRevParseOutput(`${PR_HEAD}\n`)).toBe(PR_HEAD);
    expect(parseRevParseOutput(`warning: something\n${PR_HEAD}\n`)).toBe(PR_HEAD);
  });

  it("returns undefined for errors, empty output, or non-git cwd", () => {
    expect(
      parseRevParseOutput("fatal: not a git repository (or any of the parent directories): .git\nexit 128"),
    ).toBeUndefined();
    expect(parseRevParseOutput("")).toBeUndefined();
    expect(parseRevParseOutput("exit 127: git: command not found")).toBeUndefined();
  });
});
