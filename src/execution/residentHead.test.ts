import { describe, expect, it } from "vitest";
import { attachTarget, mirrorNeedsFetch, parseWantSha, wantShaForBinding } from "./residentHead.js";

// Feature: docs/reference/specs/resident-repos.md item 51 — the attach target once the
// mirror is as fresh as it will get: the ref when it exists; the expected commit,
// detached, when the ref is gone but the mirror holds the commit (a merged PR's
// deleted branch, its head still under refs/pull/N/head); unknown-ref otherwise.
describe("attachTarget", () => {
  const sha = "e".repeat(40);
  it("the ref exists → clone its tip, whatever was expected (the ref always wins over a detached tree)", () => {
    expect(attachTarget({ refExists: true, wantSha: sha, commitInMirror: true })).toEqual({ kind: "ref" });
    expect(attachTarget({ refExists: true, wantSha: null, commitInMirror: false })).toEqual({ kind: "ref" });
  });
  it("the ref is gone but the expected commit is in the mirror → check that commit out, detached", () => {
    expect(attachTarget({ refExists: false, wantSha: sha, commitInMirror: true })).toEqual({ kind: "sha", sha });
  });
  it("the ref is gone and no commit was expected, or the mirror does not hold it either → unknown-ref, as before", () => {
    expect(attachTarget({ refExists: false, wantSha: null, commitInMirror: false })).toEqual({ kind: "unknown-ref" });
    expect(attachTarget({ refExists: false, wantSha: sha, commitInMirror: false })).toEqual({ kind: "unknown-ref" });
  });
});

const TIP = "47c4230692cbc5961682532afb822e9c2f1f40b7";
const OLD = "b54e38f9473f1578ec796c9495155307535ef51e";

describe("parseWantSha (/attach body field `sha`)", () => {
  it("absent → null (older bots, coding runs)", () => {
    expect(parseWantSha(undefined)).toEqual({ sha: null });
  });
  it("accepts a full 40-hex lowercase sha", () => {
    expect(parseWantSha(TIP)).toEqual({ sha: TIP });
  });
  it("refuses anything but a full sha — abbreviations included — before it can become a git argument", () => {
    for (const bad of [
      "",
      "47c4230",
      TIP.toUpperCase(),
      "HEAD",
      "main",
      "../evil",
      TIP + "0",
      TIP.slice(0, 39),
      42,
      null,
      true,
      { sha: TIP },
    ]) {
      expect(parseWantSha(bad)).toEqual({ error: expect.stringMatching(/sha must be a full 40/) });
    }
  });
});

describe("wantShaForBinding", () => {
  it("refHint is the bound ref → the sha applies", () => {
    expect(wantShaForBinding({ boundRef: "patch-1", refHint: "patch-1", wantSha: TIP })).toBe(TIP);
  });
  it("no refHint (follow-up naming no branch) → the sha applies to the bound ref", () => {
    expect(wantShaForBinding({ boundRef: "patch-1", refHint: null, wantSha: TIP })).toBe(TIP);
  });
  it("sticky binding on ANOTHER branch than the one the sha was resolved for → dropped (no per-attach fetch tax)", () => {
    expect(wantShaForBinding({ boundRef: "main", refHint: "patch-1", wantSha: TIP })).toBeNull();
  });
  it("no sha → null whatever the refs", () => {
    expect(wantShaForBinding({ boundRef: "main", refHint: "patch-1", wantSha: null })).toBeNull();
    expect(wantShaForBinding({ boundRef: "main", refHint: null, wantSha: null })).toBeNull();
  });
});

describe("mirrorNeedsFetch", () => {
  it("a missing ref always fetches (the pre-existing rule), with or without a wanted sha", () => {
    expect(mirrorNeedsFetch({ refExists: false, wantSha: null })).toBe(true);
    expect(mirrorNeedsFetch({ refExists: false, wantSha: TIP })).toBe(true);
  });
  it("no wanted sha + ref present → the mirror as it stands is good enough", () => {
    expect(mirrorNeedsFetch({ refExists: true, mirrorSha: OLD, wantSha: null })).toBe(false);
  });
  it("ref present but its tip is an older commit than the wanted head → fetch", () => {
    expect(mirrorNeedsFetch({ refExists: true, mirrorSha: OLD, wantSha: TIP })).toBe(true);
  });
  it("tip already at the wanted commit → no fetch", () => {
    expect(mirrorNeedsFetch({ refExists: true, mirrorSha: TIP, wantSha: TIP })).toBe(false);
  });
  it("an unreadable mirror tip with a wanted sha → fetch (never assume fresh)", () => {
    expect(mirrorNeedsFetch({ refExists: true, wantSha: TIP })).toBe(true);
  });
});
