import { describe, expect, it } from "vitest";
import {
  buildReviewPostBody,
  CHANGES_TOKEN,
  LGTM_TOKEN,
  NO_VERDICT_LINE,
  parseVerdictInput,
  verdictLine,
} from "./reviewVerdict.js";

// Feature: features/agent-review.md — deterministic verdict token. The
// auto-approve workflow keys on `startsWith(body, "LGTM:")`, so the first line
// is produced by code from the structured verdict, never by the model's prose.
describe("review verdict → post body", () => {
  it("approve → body starts with the exact `LGTM:` token and the summary", () => {
    const body = buildReviewPostBody("Looks fine.\n- nit: rename x", { verdict: "approve", summary: "no blocking issues" });
    expect(body.startsWith(`${LGTM_TOKEN} no blocking issues\n\n`)).toBe(true);
    expect(body).toContain("Looks fine.");
  });

  it("request_changes → never starts with LGTM, even if the prose does", () => {
    const body = buildReviewPostBody("LGTM overall but one blocker...", { verdict: "request_changes", summary: "null deref in handler" });
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

  // features/agent-review.md item 8: the agent reports the commit it reviewed
  // (`git rev-parse HEAD`); the dispatcher checks it against the PR head.
  it("parseVerdictInput carries a well-formed reported head (7–40 hex, lowercased) and drops anything else", () => {
    const sha = "E8E43F480a09b76989b85ebe6a2a254d99a4d2a3";
    expect(parseVerdictInput({ verdict: "approve", summary: "ok", head: sha })).toEqual({
      verdict: "approve",
      summary: "ok",
      head: sha.toLowerCase(),
    });
    expect(parseVerdictInput({ verdict: "approve", summary: "ok", head: " e8e43f4 " })).toEqual({ verdict: "approve", summary: "ok", head: "e8e43f4" });
    expect(parseVerdictInput({ verdict: "approve", summary: "ok", head: "HEAD" })).toEqual({ verdict: "approve", summary: "ok" });
    expect(parseVerdictInput({ verdict: "approve", summary: "ok", head: "e8e43f" })).toEqual({ verdict: "approve", summary: "ok" });
    expect(parseVerdictInput({ verdict: "approve", summary: "ok", head: 42 })).toEqual({ verdict: "approve", summary: "ok" });
  });
});
