// Feature: docs/reference/specs/live-view.md item 19 — the REVIEW/CODING row's links
// are built from shape-verified values only; anything odd renders as text.
import { describe, expect, it } from "vitest";
import { githubCommitUrl, githubPrUrl, githubRepoUrl, githubTreeUrl, shortSha } from "./githubLinks";

describe("githubLinks", () => {
  it("a well-formed repo, branch, PR number and sha each build their one URL", () => {
    expect(githubRepoUrl("acme/web")).toBe("https://github.com/acme/web");
    expect(githubPrUrl("acme/web", 42)).toBe("https://github.com/acme/web/pull/42");
    expect(githubTreeUrl("acme/web", "main")).toBe("https://github.com/acme/web/tree/main");
    expect(githubTreeUrl("acme/web", "oss/17c-review-full-diff")).toBe(
      "https://github.com/acme/web/tree/oss/17c-review-full-diff",
    );
    expect(githubCommitUrl("acme/web", "0123456789abcdef0123456789abcdef01234567")).toBe(
      "https://github.com/acme/web/commit/0123456789abcdef0123456789abcdef01234567",
    );
    expect(shortSha("0123456789abcdef0123456789abcdef01234567")).toBe("0123456");
  });

  it("a branch is word characters, dots, dashes and slashes only — anything else renders as text, never a link", () => {
    expect(githubTreeUrl("acme/web", "feat/a.b-c_d/e")).toBe("https://github.com/acme/web/tree/feat/a.b-c_d/e");
    expect(githubTreeUrl("acme/web", "feat/a#b")).toBeUndefined();
    expect(githubTreeUrl("acme/web", "feat/a?b=1")).toBeUndefined();
  });

  it("an odd repo, ref, number or sha builds nothing — never a link from text that could carry a path or a scheme", () => {
    for (const repo of ["javascript:alert(1)//x", "acme", "acme/web/extra", "", undefined]) {
      expect(githubRepoUrl(repo)).toBeUndefined();
      expect(githubPrUrl(repo, 1)).toBeUndefined();
      expect(githubTreeUrl(repo, "main")).toBeUndefined();
      expect(githubCommitUrl(repo, "0123456")).toBeUndefined();
    }
    for (const ref of [
      "-x",
      ".hidden",
      "a..b",
      "a//b",
      "a@{1}",
      "x.lock",
      "trailing/",
      "trailing.",
      "sp ace",
      "",
      undefined,
    ])
      expect(githubTreeUrl("acme/web", ref)).toBeUndefined();
    for (const n of [0, -1, 1.5, Number.NaN, undefined]) expect(githubPrUrl("acme/web", n)).toBeUndefined();
    for (const sha of ["012345", "0123456789ABCDEF", "not a sha", "", undefined])
      expect(githubCommitUrl("acme/web", sha)).toBeUndefined();
  });
});
