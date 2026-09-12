import { describe, expect, it } from "vitest";
import {
  buildReviewPostBody,
  CHANGES_TOKEN,
  isFindingDispositionsShape,
  isReviewVerdictShape,
  LGTM_TOKEN,
  NO_VERDICT_LINE,
  parseDispositionsInput,
  parseVerdictInput,
  redactDispositions,
  redactVerdict,
  verdictLine,
} from "./reviewVerdict.js";

// Feature: docs/reference/specs/run-history.md items 2 and 3 — the verdict and
// the dispositions ride the finished run's record, checked for shape (never
// bounds) when read back and redacted at every string leaf when written.
describe("the stored shapes — isReviewVerdictShape, isFindingDispositionsShape, and their redaction", () => {
  const verdict = parseVerdictInput({
    verdict: "request_changes",
    summary: "one nit",
    head: "a1b2c3d4e5f60718293a4b5c6d7e8f9012345678",
    findings: [{ id: "F1", severity: "minor", file: "src/a.ts", line: 3, title: "off by one" }],
  })!;

  it("accepts a parsed verdict and its JSON round-trip, with or without findings and a head; refuses a non-object, an unknown verdict kind, a non-string summary, non-array findings and a finding missing its id, severity, file or title", () => {
    expect(isReviewVerdictShape(verdict)).toBe(true);
    expect(isReviewVerdictShape(JSON.parse(JSON.stringify(verdict)))).toBe(true);
    expect(isReviewVerdictShape({ verdict: "approve", summary: "" })).toBe(true);
    expect(isReviewVerdictShape(null)).toBe(false);
    expect(isReviewVerdictShape({ verdict: "maybe", summary: "x" })).toBe(false);
    expect(isReviewVerdictShape({ verdict: "approve", summary: 7 })).toBe(false);
    expect(isReviewVerdictShape({ verdict: "approve", summary: "x", findings: "F1" })).toBe(false);
    expect(isReviewVerdictShape({ verdict: "approve", summary: "x", head: 7 })).toBe(false);
    for (const missing of ["id", "severity", "file", "title"]) {
      const finding: Record<string, unknown> = { id: "F1", severity: "minor", file: "src/a.ts", title: "t" };
      delete finding[missing];
      expect(isReviewVerdictShape({ verdict: "approve", summary: "x", findings: [finding] }), missing).toBe(false);
    }
    expect(
      isReviewVerdictShape({
        verdict: "approve",
        summary: "x",
        findings: [{ id: "F1", severity: "huge", file: "a", title: "t" }],
      }),
    ).toBe(false);
  });

  it("accepts a parsed disposition set and its round-trip; refuses a non-array, a non-object entry, an unknown disposition and a non-string note", () => {
    const set = parseDispositionsInput({ dispositions: [{ findingId: "F1", disposition: "fixed", note: "done" }] })!;
    expect(isFindingDispositionsShape(set.dispositions)).toBe(true);
    expect(isFindingDispositionsShape(JSON.parse(JSON.stringify(set.dispositions)))).toBe(true);
    expect(isFindingDispositionsShape([])).toBe(true);
    expect(isFindingDispositionsShape({})).toBe(false);
    expect(isFindingDispositionsShape([7])).toBe(false);
    expect(isFindingDispositionsShape([{ findingId: "F1", disposition: "maybe", note: "x" }])).toBe(false);
    expect(isFindingDispositionsShape([{ findingId: "F1", disposition: "fixed", note: 7 }])).toBe(false);
  });

  it("redaction walks the summary, every finding's title and file, and every disposition's note — the input untouched", () => {
    const token = `ghp_${"a".repeat(24)}`;
    const leaky = parseVerdictInput({
      verdict: "approve",
      summary: `used ${token}`,
      findings: [{ id: "F1", severity: "nit", file: `src/${token}.ts`, title: `see ${token}` }],
    })!;
    const redacted = redactVerdict(leaky);
    expect(JSON.stringify(redacted)).not.toContain("ghp_");
    expect(redacted.summary).toBe("used «redacted-github-token»");
    expect(redacted.findings?.[0]).toMatchObject({ id: "F1", severity: "nit", title: "see «redacted-github-token»" });
    expect(leaky.summary).toContain("ghp_");
    const notes = redactDispositions([{ findingId: "F1", disposition: "declined", note: `because ${token}` }]);
    expect(notes).toEqual([{ findingId: "F1", disposition: "declined", note: "because «redacted-github-token»" }]);
  });
});

// Feature: docs/reference/specs/agent-review.md — deterministic verdict token. The
// auto-approve workflow keys on `startsWith(body, "LGTM:")`, so the first line
// is produced by code from the structured verdict, never by the model's prose.
describe("review verdict → post body", () => {
  it("approve → body starts with the exact `LGTM:` token and the summary", () => {
    const body = buildReviewPostBody("Looks fine.\n- nit: rename x", {
      verdict: "approve",
      summary: "no blocking issues",
    });
    expect(body.startsWith(`${LGTM_TOKEN} no blocking issues\n\n`)).toBe(true);
    expect(body).toContain("Looks fine.");
  });

  it("request_changes → never starts with LGTM, even if the prose does", () => {
    const body = buildReviewPostBody("LGTM overall but one blocker...", {
      verdict: "request_changes",
      summary: "null deref in handler",
    });
    expect(body.startsWith(`${CHANGES_TOKEN} null deref in handler\n\n`)).toBe(true);
    expect(body.startsWith("LGTM")).toBe(false);
  });

  it("no verdict → fail-closed: explicit non-approving line, prose preserved", () => {
    const body = buildReviewPostBody("LGTM: ship it", undefined);
    expect(body.startsWith(`${NO_VERDICT_LINE}\n\n`)).toBe(true);
    expect(body.startsWith("LGTM")).toBe(false);
    expect(body).toContain("LGTM: ship it"); // the prose is kept, just not first
  });

  it("summary is collapsed to one line so the token line cannot be split", () => {
    expect(verdictLine({ verdict: "approve", summary: "  ok\n\nreally\n" })).toBe("LGTM: ok really");
    expect(verdictLine({ verdict: "approve", summary: "" })).toBe("LGTM:");
  });

  it("parseVerdictInput accepts only the two verdict values", () => {
    expect(parseVerdictInput({ verdict: "approve", summary: "fine" })).toEqual({ verdict: "approve", summary: "fine" });
    expect(parseVerdictInput({ verdict: "request_changes" })).toEqual({ verdict: "request_changes", summary: "" });
    expect(parseVerdictInput({ verdict: "LGTM" })).toBeNull();
    expect(parseVerdictInput({ verdict: "approved" })).toBeNull();
    expect(parseVerdictInput({})).toBeNull();
    expect(parseVerdictInput({ verdict: 1 })).toBeNull();
  });

  // Feature: docs/reference/specs/agent-ship.md item 6 — typed findings on the verdict.
  // Validated fail-closed PER finding: a malformed finding drops with a note,
  // a malformed findings array drops the whole field — the verdict itself
  // still stands either way.
  describe("findings (agent-ship item 6)", () => {
    const F1 = { id: "F1", severity: "blocking", file: "src/a.ts", line: 12, title: "Null deref in handler" } as const;
    const F2 = { id: "F2", severity: "nit", file: "src/b.ts", title: "Rename x" } as const;

    it("parses valid findings in order", () => {
      const v = parseVerdictInput({ verdict: "request_changes", summary: "two issues", findings: [F1, F2] });
      expect(v).toEqual({ verdict: "request_changes", summary: "two issues", findings: [F1, F2] });
    });

    it("renders findings as a compact list under the verdict line, before the prose", () => {
      const v = parseVerdictInput({ verdict: "request_changes", summary: "two issues", findings: [F1, F2] })!;
      const body = buildReviewPostBody("Prose explanation here.", v);
      expect(body).toBe(
        `${CHANGES_TOKEN} two issues\n` +
          "- [blocking] F1 src/a.ts:12 — Null deref in handler\n" +
          "- [nit] F2 src/b.ts — Rename x\n" +
          "\nProse explanation here.",
      );
    });

    it("a malformed single finding drops with a note naming it; the verdict and the other findings stand", () => {
      const v = parseVerdictInput({
        verdict: "request_changes",
        summary: "s",
        findings: [
          { id: "F1", severity: "major", file: "a.ts", title: "ok" },
          { id: "F2", severity: "meh", file: "b.ts", title: "bad severity" },
          { id: "", severity: "nit", file: "c.ts", title: "no id" },
        ],
      })!;
      expect(v.verdict).toBe("request_changes");
      expect(v.findings).toEqual([{ id: "F1", severity: "major", file: "a.ts", title: "ok" }]);
      expect(v.droppedFindings).toHaveLength(2);
      expect(v.droppedFindings![0]).toContain("F2");
      expect(v.droppedFindings![1]).toContain("findings[2]");
    });

    it("a malformed findings array drops the whole field; the verdict stands", () => {
      const v = parseVerdictInput({ verdict: "approve", summary: "ok", findings: "none" })!;
      expect(v.verdict).toBe("approve");
      expect(v.findings).toBeUndefined();
      expect(v.droppedFindings?.join(" ")).toMatch(/findings/);
    });

    it("approve carrying a blocking finding is downgraded to request_changes with the reason in the summary", () => {
      const v = parseVerdictInput({
        verdict: "approve",
        summary: "ship it",
        findings: [{ id: "F1", severity: "blocking", file: "a.ts", title: "Data loss on retry" }],
      })!;
      expect(v.verdict).toBe("request_changes");
      expect(v.summary).toContain("ship it");
      expect(v.summary).toMatch(/downgraded/i);
      expect(v.summary).toContain("F1");
      const body = buildReviewPostBody("prose", v);
      expect(body.startsWith("LGTM")).toBe(false);
      expect(body.startsWith(CHANGES_TOKEN)).toBe(true);
    });

    it("approve is downgraded even when the blocking finding itself is malformed and drops — never LGTM over a self-declared blocking defect", () => {
      const v = parseVerdictInput({
        verdict: "approve",
        summary: "ok",
        findings: [{ id: "F1", severity: "blocking", file: "a.ts" }], // missing title → the entry drops
      })!;
      expect(v.findings).toEqual([]);
      expect(v.droppedFindings).toHaveLength(1);
      expect(v.verdict).toBe("request_changes");
      expect(v.summary).toContain("F1");
      expect(buildReviewPostBody("prose", v).startsWith("LGTM")).toBe(false);
    });

    it("LGTM token contract holds with findings present: approve + non-blocking findings still starts with the exact token", () => {
      const v = parseVerdictInput({ verdict: "approve", summary: "minor nits only", findings: [F2] })!;
      expect(v.verdict).toBe("approve");
      const body = buildReviewPostBody("prose", v);
      expect(body.startsWith(`${LGTM_TOKEN} minor nits only\n`)).toBe(true);
      expect(body).toContain("- [nit] F2 src/b.ts — Rename x");
    });

    it("request_changes with findings never yields an LGTM-prefixed body", () => {
      const v = parseVerdictInput({ verdict: "request_changes", summary: "one bug", findings: [F1] })!;
      expect(buildReviewPostBody("prose", v).startsWith("LGTM")).toBe(false);
    });

    it("an unusable optional line is dropped like a malformed head — the finding stands without it", () => {
      const v = parseVerdictInput({
        verdict: "request_changes",
        summary: "s",
        findings: [
          { id: "F1", severity: "major", file: "a.ts", line: "twelve", title: "t" },
          { id: "F2", severity: "major", file: "b.ts", line: 0, title: "t" },
          { id: "F3", severity: "major", file: "c.ts", line: 3.5, title: "t" },
        ],
      })!;
      expect(v.findings).toEqual([
        { id: "F1", severity: "major", file: "a.ts", title: "t" },
        { id: "F2", severity: "major", file: "b.ts", title: "t" },
        { id: "F3", severity: "major", file: "c.ts", title: "t" },
      ]);
      expect(v.droppedFindings).toBeUndefined();
    });

    it("finding text fields are collapsed to one line so the compact list cannot be split", () => {
      const v = parseVerdictInput({
        verdict: "request_changes",
        summary: "s",
        findings: [{ id: " F1 ", severity: "minor", file: " src/a.ts ", title: "  broken\n\nacross lines " }],
      })!;
      expect(v.findings).toEqual([{ id: "F1", severity: "minor", file: "src/a.ts", title: "broken across lines" }]);
    });

    it("an empty findings array is valid and renders nothing extra", () => {
      const v = parseVerdictInput({ verdict: "approve", summary: "ok", findings: [] })!;
      expect(v.findings).toEqual([]);
      expect(buildReviewPostBody("prose", v)).toBe(`${LGTM_TOKEN} ok\n\nprose`);
    });
  });

  // docs/reference/specs/agent-ship.md item 6 — the coding side's typed dispositions,
  // validated in parseVerdictInput's fail-closed style: a malformed entry
  // drops with a note, a non-array input rejects the whole call (null).
  describe("dispositions (agent-ship item 6)", () => {
    it("parses a valid set", () => {
      const parsed = parseDispositionsInput({
        dispositions: [
          { findingId: "F1", disposition: "fixed", note: "guarded the null path" },
          { findingId: "F2", disposition: "declined", note: "by design" },
        ],
      });
      expect(parsed).toEqual({
        dispositions: [
          { findingId: "F1", disposition: "fixed", note: "guarded the null path" },
          { findingId: "F2", disposition: "declined", note: "by design" },
        ],
        dropped: [],
      });
    });

    it("a non-array dispositions input is null (the call is rejected, nothing recorded)", () => {
      expect(parseDispositionsInput({})).toBeNull();
      expect(parseDispositionsInput({ dispositions: "all fixed" })).toBeNull();
    });

    it("a malformed entry drops with a note naming it; the rest stand", () => {
      const parsed = parseDispositionsInput({
        dispositions: [
          { findingId: "F1", disposition: "fixed", note: "done" },
          { findingId: "F2", disposition: "wontfix", note: "nope" },
          { disposition: "fixed", note: "no id" },
        ],
      })!;
      expect(parsed.dispositions).toEqual([{ findingId: "F1", disposition: "fixed", note: "done" }]);
      expect(parsed.dropped).toHaveLength(2);
      expect(parsed.dropped[0]).toContain("F2");
      expect(parsed.dropped[1]).toContain("dispositions[2]");
    });

    it("a missing note is tolerated as empty (the summary convention), never a dropped entry", () => {
      const parsed = parseDispositionsInput({ dispositions: [{ findingId: "F1", disposition: "declined" }] })!;
      expect(parsed.dispositions).toEqual([{ findingId: "F1", disposition: "declined", note: "" }]);
    });
  });

  // docs/reference/specs/agent-review.md item 8: the agent reports the commit it reviewed
  // (`git rev-parse HEAD`); the dispatcher checks it against the PR head.
  it("parseVerdictInput carries a well-formed reported head (7–40 hex, lowercased) and drops anything else", () => {
    const sha = "E8E43F480a09b76989b85ebe6a2a254d99a4d2a3";
    expect(parseVerdictInput({ verdict: "approve", summary: "ok", head: sha })).toEqual({
      verdict: "approve",
      summary: "ok",
      head: sha.toLowerCase(),
    });
    expect(parseVerdictInput({ verdict: "approve", summary: "ok", head: " e8e43f4 " })).toEqual({
      verdict: "approve",
      summary: "ok",
      head: "e8e43f4",
    });
    expect(parseVerdictInput({ verdict: "approve", summary: "ok", head: "HEAD" })).toEqual({
      verdict: "approve",
      summary: "ok",
    });
    expect(parseVerdictInput({ verdict: "approve", summary: "ok", head: "e8e43f" })).toEqual({
      verdict: "approve",
      summary: "ok",
    });
    expect(parseVerdictInput({ verdict: "approve", summary: "ok", head: 42 })).toEqual({
      verdict: "approve",
      summary: "ok",
    });
  });
});
