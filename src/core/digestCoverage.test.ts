import { describe, expect, it } from "vitest";
import { checkDigestCoverage, coverageTolerance } from "./digestCoverage.js";

// Feature: docs/reference/specs/agent-review.md item 15 — the digest-coverage
// guard. The case that motivated it: a 41-file, +2459/−579 PR whose digest
// covered 13 files, +144/−53, and was approved on that.

const PR = { changedFiles: 41, additions: 2459, deletions: 579 };
const digest = (files: number, additions: number, deletions: number) => ({
  complete: true as const,
  base: "origin/main",
  totals: { files, additions, deletions },
});

describe("checkDigestCoverage", () => {
  it("refuses the verdict when the digest covered fewer files than the PR, naming both sides", () => {
    const out = checkDigestCoverage({ digest: digest(13, 144, 53), pr: PR });
    expect(out.ok).toBe(false);
    if (out.ok) throw new Error("unreachable");
    expect(out.reason).toContain("digest covered 13 of 41 files");
    expect(out.reason).toContain("+144/−53");
    expect(out.reason).toContain("+2459/−579");
  });

  it("refuses when the file count matches but the lines fall far short (a digest of the right files at the wrong range)", () => {
    const out = checkDigestCoverage({ digest: digest(41, 100, 20), pr: PR });
    expect(out.ok).toBe(false);
  });

  it("passes an exact match, and a digest within the tolerance (rename detection, binaries)", () => {
    expect(checkDigestCoverage({ digest: digest(41, 2459, 579), pr: PR })).toEqual({ ok: true, compared: true });
    // one rename counted differently: a file and its lines short, inside the tolerance
    expect(checkDigestCoverage({ digest: digest(40, 2400, 560), pr: PR })).toEqual({ ok: true, compared: true });
  });

  it("never refuses a digest that covers MORE than the PR (a lagging local base widens the range)", () => {
    expect(checkDigestCoverage({ digest: digest(60, 4000, 900), pr: PR })).toEqual({ ok: true, compared: true });
  });

  it("refuses a digest that could not state its totals — its own output was cut", () => {
    const out = checkDigestCoverage({
      digest: { complete: false, base: "origin/main", reason: "the file listing exceeded the output cap" },
      pr: PR,
    });
    expect(out.ok).toBe(false);
    if (out.ok) throw new Error("unreachable");
    expect(out.reason).toContain("exceeded the output cap");
  });

  it("has nothing to compare without a digest, or without the PR's size — and says so", () => {
    expect(checkDigestCoverage({ digest: undefined, pr: PR })).toEqual({ ok: true, compared: false });
    expect(checkDigestCoverage({ digest: digest(13, 144, 53), pr: undefined })).toEqual({ ok: true, compared: false });
  });

  it("tolerance: one file + 5 % of the PR's files; 50 lines + 25 % of the PR's lines", () => {
    expect(coverageTolerance(PR)).toEqual({ files: 3, lines: 50 + Math.floor(3038 * 0.25) });
    expect(coverageTolerance({ changedFiles: 1, additions: 1, deletions: 0 })).toEqual({ files: 1, lines: 50 });
  });
});
