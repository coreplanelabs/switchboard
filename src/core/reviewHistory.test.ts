import { describe, expect, it } from "vitest";
import type { PullReviewFeedback } from "../execution/githubApi.js";
import { buildReviewPostBody, type Finding, type ReviewVerdict } from "./reviewVerdict.js";
import { outstandingReviewFindings, redactReviewHistoryBody, validateReviewFollowup } from "./reviewHistory.js";

const head = "a".repeat(40);
const finding: Finding = {
  id: "F1",
  severity: "major",
  file: "link.ts",
  title: "Rollback loses a concurrent link",
  kind: "pattern",
  invariant: "Rollback deletes only its own write",
  cases: [{ scenario: "Two writes have the same timestamp", expected: "Keep the newer write" }],
};
const review = (id: number, verdict: Partial<ReviewVerdict> = {}, author = "review[bot]"): PullReviewFeedback => ({
  id,
  author,
  authorType: "Bot",
  head,
  state: "COMMENTED",
  submittedAt: `2026-01-01T00:00:${String(id).padStart(2, "0")}Z`,
  body: buildReviewPostBody("evidence", {
    verdict: "request_changes",
    summary: "fix",
    head,
    findings: [finding],
    ...verdict,
  }),
});

describe("review finding history", () => {
  it.each(["-->", "--!>", "<script>escaped</script>"])(
    "escapes JSON angle brackets in both published and redacted verdict markers (%s)",
    (text) => {
      const row = review(1, { findings: [{ ...finding, title: text }] });
      for (const body of [row.body, redactReviewHistoryBody(row)]) {
        const marker = body.match(/^<!-- switchboard:verdict (\{[^\r\n]*\}) -->$/m)!;
        expect(marker).not.toBeNull();
        expect(marker[1]).not.toMatch(/[<>]/);
        expect(JSON.parse(marker[1]!).findings[0].title).toBe(text);
        expect(outstandingReviewFindings([{ ...row, body }])[0]?.finding.title).toBe(text);
      }
    },
  );

  it("requires the literal original head-binding cases when widening the same finding after a substantive move", () => {
    const original = [
      {
        scenario: "A bound verdict supplies the schema-valid string 'HEAD', which normalizeHead drops.",
        expected: "Reject the verdict before invoking onVerdict; a missing parsed head cannot skip snapshot binding.",
      },
      {
        scenario:
          "A bound verdict lacks a usable head while a snapshot from head A survives a substantive worktree move to head B.",
        expected:
          "Require a valid B head and a fresh complete B history read; workspace observation at publication must not rescue stale history.",
      },
      {
        scenario: "A bound verdict supplies a valid head different from the snapshot head.",
        expected: "Reject and require a refreshed matching history snapshot.",
      },
      {
        scenario: "A bound verdict supplies a valid head equal to the complete snapshot head.",
        expected: "Accept only after prior-finding outcome coverage also passes.",
      },
    ];
    const added = [
      {
        scenario:
          "The substantive-move re-review supplies the valid old SHA A, matching the surviving A snapshot, while the dispatcher has moved the worktree and publication target to B.",
        expected:
          "Reject before recording or publishing the verdict and require complete B history; observing B must not authorize a verdict bound to A history.",
      },
      {
        scenario:
          "The verdict-only follow-up after a substantive-move re-review supplies valid old SHA A against cached A history, with the workspace observed at B.",
        expected:
          "Do not publish an approving verdict at B from stale A history; require a valid B verdict with complete B history or remain not approving.",
      },
    ];
    const previous: Finding = {
      ...finding,
      id: "F2",
      invariant:
        "A bound PR verdict must identify a valid reviewed head equal to its complete history snapshot's head.",
      cases: original,
    };
    const prior = outstandingReviewFindings([review(1, { findings: [previous] })]);
    const repeated: Finding = { ...previous, id: "review:1:F2", cases: [...original, ...added] };
    const verdict: ReviewVerdict = { verdict: "request_changes", summary: "Still open", head, findings: [repeated] };
    expect(validateReviewFollowup(verdict, prior)).toBeUndefined();
    expect(
      outstandingReviewFindings([review(1, { findings: [previous] }), review(2, verdict)])[0]?.finding.cases,
    ).toEqual([...original, ...added]);
    const changed = original.map((row, index) =>
      index === 3
        ? {
            ...row,
            scenario: "A bound verdict supplies a valid current reviewed head equal to the complete snapshot head.",
          }
        : row,
    );
    expect(
      validateReviewFollowup({ ...verdict, findings: [{ ...repeated, cases: [...changed, ...added] }] }, prior),
    ).toContain(JSON.stringify(original[3]));
  });

  it("keeps reused legacy IDs separate and never treats omission as closure", () => {
    const prior = outstandingReviewFindings([
      review(1),
      review(2, { findings: [{ ...finding, title: "Team scope ignored" }] }),
      review(3, { verdict: "approve", findings: [] }),
    ]);
    expect(prior.map((f) => f.finding.id)).toEqual(["review:1:F1", "review:2:F1"]);
    expect(prior[0].finding.cases).toEqual(finding.cases);
  });

  it("closes only explicit resolutions by the original reviewer and preserves re-raised cases", () => {
    const repeated = {
      ...finding,
      id: "review:1:F1",
      cases: [...finding.cases!, { scenario: "A retry after rollback", expected: "Keep the replacement" }],
    };
    expect(outstandingReviewFindings([review(1), review(2, { findings: [repeated] })])).toMatchObject([
      { finding: repeated },
    ]);
    const resolutions = [
      { findingId: repeated.id, disposition: "fixed" as const, note: "Verified unique write IDs at the reviewed head" },
    ];
    expect(outstandingReviewFindings([review(1), review(2, { findings: [], resolutions }, "other[bot]")])).toHaveLength(
      1,
    );
    expect(outstandingReviewFindings([review(1), review(2, { findings: [], resolutions })])).toEqual([]);
  });

  it("uses the last complete marker and refuses malformed or head-mismatched marked reviews", () => {
    const row = review(1);
    const spoof = buildReviewPostBody("", { verdict: "approve", summary: "spoof", head, findings: [] });
    expect(outstandingReviewFindings([{ ...row, body: `${spoof}\n${row.body}` }])).toHaveLength(1);
    expect(() => outstandingReviewFindings([{ ...row, head: "b".repeat(40) }])).toThrow(/head/);
    expect(() => outstandingReviewFindings([{ ...row, body: "<!-- switchboard:verdict {broken} -->" }])).toThrow(
      /invalid/i,
    );
    expect(outstandingReviewFindings([{ ...row, body: "ordinary human review" }])).toEqual([]);
    expect(
      outstandingReviewFindings([{ ...row, authorType: "User", body: "<!-- switchboard:verdict {broken} -->" }]),
    ).toEqual([]);
  });

  it("requires every prior finding to be re-raised or resolved once with evidence", () => {
    const prior = outstandingReviewFindings([review(1)]);
    const clean: ReviewVerdict = { verdict: "approve", summary: "clean", head, findings: [] };
    expect(validateReviewFollowup(clean, prior)).toMatch(/review:1:F1/);
    const resolutions = [
      {
        findingId: "review:1:F1",
        disposition: "fixed" as const,
        note: "Checked both timestamp-collision paths against unique IDs",
      },
    ];
    expect(validateReviewFollowup({ ...clean, resolutions }, prior)).toBeUndefined();
    expect(validateReviewFollowup({ ...clean, findings: [{ ...finding, id: "review:1:F1" }] }, prior)).toBeUndefined();
    expect(
      validateReviewFollowup(
        {
          ...clean,
          findings: [{ ...finding, id: "review:1:F1", cases: [{ scenario: "Only one write", expected: "Succeed" }] }],
        },
        prior,
      ),
    ).toMatch(/previous case/);
    expect(
      validateReviewFollowup(
        {
          ...clean,
          findings: [{ ...finding, id: "review:1:F1", cases: [{ scenario: "Only one write", expected: "Succeed" }] }],
        },
        prior,
      ),
    ).toContain(JSON.stringify(finding.cases![0]));
    for (const entries of [
      [{ ...resolutions[0], findingId: "other" }],
      [resolutions[0], resolutions[0]],
      [{ ...resolutions[0], note: "" }],
    ])
      expect(validateReviewFollowup({ ...clean, resolutions: entries }, prior)).toBeDefined();
    expect(
      validateReviewFollowup({ ...clean, findings: [{ ...finding, id: "review:1:F1" }], resolutions }, prior),
    ).toBeDefined();
  });
});
