import { describe, expect, it } from "vitest";
import {
  buildReviewPostBody,
  CHANGES_TOKEN,
  LGTM_TOKEN,
  NO_VERDICT_LINE,
  parseDispositionsInput,
  parseVerdictInput,
  verdictLine,
} from "./reviewVerdict.js";

// Feature: features/agent-review.md — deterministic verdict token. The
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

  // Feature: features/agent-ship.md item 6 — typed findings on the verdict.
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

  // features/agent-ship.md item 6 — the coding side's typed dispositions,
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

  // features/agent-review.md item 8: the agent reports the commit it reviewed
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
