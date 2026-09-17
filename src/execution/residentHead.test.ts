import { describe, expect, it } from "vitest";
import { attachTarget, mirrorFetchReason, parseWantSha, wantShaForBinding } from "./residentHead.js";

// Feature: docs/reference/specs/resident-repos.md item 51 — the attach target once the
// mirror is as fresh as it will get: the ref when it exists; the expected commit,
// detached, when the ref is gone but the mirror holds the commit (a merged PR's
// deleted branch, its head still under refs/pull/N/head); unknown-ref otherwise.
describe("attachTarget", () => {
  const sha = "e".repeat(40);
  const other = "f".repeat(40);
  it("the ref exists and the caller named no commit, or its tip IS the commit → clone its tip", () => {
    expect(attachTarget({ refExists: true, wantSha: sha, commitInMirror: true, tipSha: sha })).toEqual({ kind: "ref" });
    expect(attachTarget({ refExists: true, wantSha: null, commitInMirror: false, tipSha: other })).toEqual({
      kind: "ref",
    });
    expect(attachTarget({ refExists: true, wantSha: null, commitInMirror: false })).toEqual({ kind: "ref" });
  });
  it("the ref exists but its tip is not the commit the caller named, even after the fetch → stale-tip, never the tip: a run executes at the sha it asked for or not on this resident", () => {
    // Both directions refuse: an older tip (the fetch failed or was skipped, so
    // the mirror is behind the commit the bot resolved) and a newer one (a push
    // raced the attach). The caller falls back cold at the requested commit.
    expect(attachTarget({ refExists: true, wantSha: sha, commitInMirror: true, tipSha: other })).toEqual({
      kind: "stale-tip",
      tip: other,
      want: sha,
    });
    // An unreadable tip with a named commit is never assumed fresh.
    expect(attachTarget({ refExists: true, wantSha: sha, commitInMirror: false, tipSha: null })).toEqual({
      kind: "stale-tip",
      tip: null,
      want: sha,
    });
    expect(attachTarget({ refExists: true, wantSha: sha, commitInMirror: false })).toEqual({
      kind: "stale-tip",
      tip: null,
      want: sha,
    });
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

// The fetch decision names WHY it fetches: a missing ref and a stale tip fail
// the attach when their fetch fails, as they always did; a fetch that only
// verifies a returnable ref against the origin (item 16's second movement)
// fails soft — the attach goes on with the mirror's ref.
describe("mirrorFetchReason", () => {
  const trusted = { returnable: false };
  it("a missing ref always fetches (the pre-existing rule), with or without a wanted sha, returnable or not", () => {
    expect(mirrorFetchReason({ refExists: false, wantSha: null, ...trusted })).toBe("missing-ref");
    expect(mirrorFetchReason({ refExists: false, wantSha: TIP, ...trusted })).toBe("missing-ref");
    expect(mirrorFetchReason({ refExists: false, wantSha: null, returnable: true })).toBe("missing-ref");
  });
  it("no wanted sha + ref present, on a ref the binding could not return from → the mirror as it stands is good enough", () => {
    expect(mirrorFetchReason({ refExists: true, mirrorSha: OLD, wantSha: null, ...trusted })).toBeNull();
  });
  it("ref present but its tip is an older commit than the wanted head → fetch", () => {
    expect(mirrorFetchReason({ refExists: true, mirrorSha: OLD, wantSha: TIP, ...trusted })).toBe("stale-tip");
  });
  it("tip already at the wanted commit → no fetch", () => {
    expect(mirrorFetchReason({ refExists: true, mirrorSha: TIP, wantSha: TIP, ...trusted })).toBeNull();
  });
  it("an unreadable mirror tip with a wanted sha → fetch (never assume fresh)", () => {
    expect(mirrorFetchReason({ refExists: true, wantSha: TIP, ...trusted })).toBe("stale-tip");
  });
  it("a returnable ref the mirror still holds → fetch: a branch this thread may return from is verified against the origin at every attach, never trusted from the mirror alone", () => {
    expect(mirrorFetchReason({ refExists: true, wantSha: null, returnable: true })).toBe("returnable-ref");
    expect(mirrorFetchReason({ refExists: true, mirrorSha: TIP, wantSha: TIP, returnable: true })).toBe(
      "returnable-ref",
    );
  });
  it("a returnable ref at a stale tip is the stale fetch, not the verification: its failure keeps failing the attach", () => {
    expect(mirrorFetchReason({ refExists: true, mirrorSha: OLD, wantSha: TIP, returnable: true })).toBe("stale-tip");
  });
});
