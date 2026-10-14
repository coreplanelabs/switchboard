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
  it.each([{ verdict: "request_changes", findings: [] }, { verdict: "request_changes" }, { verdict: "approve" }])(
    "reads legacy incomplete markers as context without closing valid findings (%j)",
    (legacy) => {
      const row = {
        ...review(2),
        body: `Legacy report\n<!-- switchboard:verdict ${JSON.stringify({
          ...legacy,
          head,
          resolutions: [{ findingId: "review:1:F1", disposition: "fixed", note: "claimed fixed" }],
        })} -->`,
      };
      const later = review(3, { findings: [{ ...finding, title: "Another unresolved write" }] });
      for (const body of [row.body, redactReviewHistoryBody(row)]) {
        expect(outstandingReviewFindings([review(1), { ...row, body }, later])).toMatchObject([
          { finding: { id: "review:1:F1", title: "Rollback loses a concurrent link" } },
          { finding: { id: "review:3:F1", title: "Another unresolved write" } },
        ]);
      }
      expect(() => outstandingReviewFindings([{ ...row, head: "b".repeat(40) }, later])).toThrow(/head/);
    },
  );

  it.each([null, "missing", [{ id: "F1" }]])(
    "refuses malformed historical findings rather than skipping them (%j)",
    (findings) => {
      const row = {
        ...review(1),
        body: `<!-- switchboard:verdict ${JSON.stringify({ verdict: "request_changes", head, findings })} -->`,
      };
      expect(() => outstandingReviewFindings([row, review(2)])).toThrow("Invalid typed review history");
      expect(() => redactReviewHistoryBody(row)).toThrow("Invalid typed review history");
    },
  );

  it("refuses a malformed final marker instead of accepting an earlier valid marker", () => {
    const row = review(1);
    for (const suffix of ["<!-- switchboard:verdict {", "<!-- switchboard:verdict {broken} -->"]) {
      const broken = { ...row, body: `${row.body}\n${suffix}` };
      expect(() => outstandingReviewFindings([broken])).toThrow(/Invalid review history marker/);
      expect(() => redactReviewHistoryBody(broken)).toThrow(/Invalid review history marker/);
    }
    expect(outstandingReviewFindings([row])).toMatchObject([{ finding: { id: "review:1:F1" } }]);
  });

  it("refuses changed finding identities and duplicate case identities before redaction can normalize them", () => {
    for (const invalid of [
      { ...finding, id: " F1 " },
      {
        ...finding,
        cases: [
          { id: "C1", scenario: "First write", expected: "Keep it" },
          { id: "C1", scenario: "Other write", expected: "Keep both" },
        ],
      },
    ]) {
      const row = review(1, { findings: [invalid] });
      expect(() => outstandingReviewFindings([row])).toThrow("Invalid typed review history");
      expect(() => redactReviewHistoryBody(row)).toThrow("Invalid typed review history");
    }
    expect(outstandingReviewFindings([review(1)])[0]?.finding.cases).toEqual([
      { id: "C1", scenario: "Two writes have the same timestamp", expected: "Keep the newer write" },
    ]);
  });

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

  it("keeps case IDs stable when later history reorders a widened matrix", () => {
    const repeated: Finding = {
      ...finding,
      id: "review:1:F1",
      cases: [
        { id: "C2", scenario: "A retry after rollback", expected: "Keep the replacement" },
        { id: "C1", scenario: "Two writes have the same timestamp", expected: "Keep the newer write" },
      ],
    };
    const prior = outstandingReviewFindings([review(1), review(2, { findings: [repeated] })]);
    expect(prior[0]?.finding.cases).toEqual([
      { id: "C2", scenario: "A retry after rollback", expected: "Keep the replacement" },
      { id: "C1", scenario: "Two writes have the same timestamp", expected: "Keep the newer write" },
    ]);
  });

  it("keeps reused legacy IDs separate and never treats omission as closure", () => {
    const prior = outstandingReviewFindings([
      review(1),
      review(2, { findings: [{ ...finding, title: "Team scope ignored" }] }),
      review(3, { verdict: "approve", findings: [] }),
    ]);
    expect(prior.map((f) => f.finding.id)).toEqual(["review:1:F1", "review:2:F1"]);
    expect(prior[0].finding.cases).toEqual([
      { id: "C1", scenario: "Two writes have the same timestamp", expected: "Keep the newer write" },
    ]);
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
    expect(
      outstandingReviewFindings([
        review(1),
        review(2, { verdict: "approve", findings: [], resolutions }, "other[bot]"),
      ]),
    ).toHaveLength(1);
    expect(
      outstandingReviewFindings([review(1), review(2, { verdict: "approve", findings: [], resolutions })]),
    ).toEqual([]);
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
    expect(
      validateReviewFollowup(
        {
          ...clean,
          resolutions,
          caseAssessments: [
            {
              findingId: "review:1:F1",
              caseId: "C1",
              outcome: "fixed",
              note: "Checked both timestamp-collision paths against unique IDs",
            },
          ],
        },
        prior,
      ),
    ).toBeUndefined();
    expect(
      validateReviewFollowup(
        {
          ...clean,
          findings: [prior[0].finding],
          caseAssessments: [
            {
              findingId: "review:1:F1",
              caseId: "C1",
              outcome: "open",
              note: "Collision still deletes the newer write at this head",
            },
          ],
        },
        prior,
      ),
    ).toBeUndefined();
    expect(
      validateReviewFollowup(
        {
          ...clean,
          findings: [{ ...finding, id: "review:1:F1", cases: [{ scenario: "Only one write", expected: "Succeed" }] }],
        },
        prior,
      ),
    ).toMatch(/identity or text/);
    expect(
      validateReviewFollowup(
        {
          ...clean,
          findings: [{ ...finding, id: "review:1:F1", cases: [{ scenario: "Only one write", expected: "Succeed" }] }],
        },
        prior,
      ),
    ).toContain("prior case identity or text changed");
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
