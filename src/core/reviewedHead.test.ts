import { describe, expect, it } from "vitest";
import { checkReviewedHead, parseRevParseOutput } from "./reviewedHead.js";

// Feature: features/agent-review.md item 8 — a review is posted to a PR only
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

  it("fails when the observed HEAD is another commit — a review of another PR's branch", () => {
    const r = checkReviewedHead({ expected: PR_HEAD, observed: OTHER, reported: OTHER });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe(`reviewed head ${OTHER.slice(0, 7)} is not the PR head ${PR_HEAD.slice(0, 7)}`);
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

  it("a reported head that mismatches fails", () => {
    expect(checkReviewedHead({ expected: PR_HEAD, reported: OTHER.slice(0, 12) }).ok).toBe(false);
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
