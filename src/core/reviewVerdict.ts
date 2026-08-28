// Deterministic review verdict → GitHub comment body.
//
// Downstream automation (the org's `auto-approve-claude-lgtm.yml` workflow)
// approves a PR when a trusted bot's review body STARTS WITH the exact token
// `LGTM:`. That token must therefore never depend on how the model happens to
// phrase its opening line. The model states its judgement through the
// structured `submit_verdict` tool (src/tools/workspace.ts); this module turns
// that structured value into the first line of the posted body:
//
//   approve          → "LGTM: <summary>"
//   request_changes  → "Changes requested: <summary>"
//   (no verdict)     → "No verdict submitted — not approving." (fail-closed)
//
// The model's prose follows after a blank line. Whatever the prose says, only
// an explicit `approve` verdict can produce a body that begins with "LGTM".

export type ReviewVerdictKind = "approve" | "request_changes";

export interface ReviewVerdict {
  verdict: ReviewVerdictKind;
  /** One line: why. Newlines are collapsed so the token line stays one line. */
  summary: string;
}

export const LGTM_TOKEN = "LGTM:";
export const CHANGES_TOKEN = "Changes requested:";
export const NO_VERDICT_LINE = "No verdict submitted — not approving.";

/** Parse an arbitrary tool input into a verdict, or null when it is not one. */
export function parseVerdictInput(input: Record<string, unknown>): ReviewVerdict | null {
  const verdict = input.verdict;
  if (verdict !== "approve" && verdict !== "request_changes") return null;
  const summary = typeof input.summary === "string" ? oneLine(input.summary) : "";
  return { verdict, summary };
}

function oneLine(s: string): string {
  return s.replace(/\s*\n+\s*/g, " ").trim();
}

/** The exact first line of the posted body for a verdict (or its absence). */
export function verdictLine(verdict: ReviewVerdict | undefined): string {
  if (!verdict) return NO_VERDICT_LINE;
  const token = verdict.verdict === "approve" ? LGTM_TOKEN : CHANGES_TOKEN;
  const summary = oneLine(verdict.summary);
  return summary ? `${token} ${summary}` : token;
}

/**
 * Build the body posted to GitHub: the deterministic verdict line, a blank
 * line, then the model's review text. Never starts with "LGTM" unless the
 * verdict is `approve`.
 */
export function buildReviewPostBody(answer: string, verdict: ReviewVerdict | undefined): string {
  return `${verdictLine(verdict)}\n\n${answer.trim()}`;
}
