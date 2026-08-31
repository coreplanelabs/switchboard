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
//
// The verdict also carries typed findings (features/agent-ship.md item 6):
// one compact entry per issue, rendered as a list under the verdict line, so
// a fix round can reference each finding by its stable id and answer it with
// a typed disposition (`parseDispositionsInput` below). Findings validate
// fail-closed PER finding — a malformed finding drops with a note, a
// malformed array drops the whole field — and an `approve` carrying a
// self-declared `blocking` finding is downgraded to `request_changes`, so the
// posted body can never begin with `LGTM:` over a defect the reviewer itself
// called blocking.

import { normalizeHead } from "./reviewedHead.js";

export type ReviewVerdictKind = "approve" | "request_changes";

export const FINDING_SEVERITIES = ["blocking", "major", "minor", "nit"] as const;
export type FindingSeverity = (typeof FINDING_SEVERITIES)[number];

export interface Finding {
  /** Stable id the reviewer assigned in order ("F1", "F2", …) — dispositions
   *  reference findings by this id. */
  id: string;
  severity: FindingSeverity;
  /** Repo-relative file the finding points at. */
  file: string;
  /** Optional 1-based line. An unusable value is dropped like a malformed
   *  `head` — the finding stands without it. */
  line?: number;
  /** One line naming the issue; the full explanation lives in the prose. */
  title: string;
}

export interface ReviewVerdict {
  verdict: ReviewVerdictKind;
  /** One line: why. Newlines are collapsed so the token line stays one line. */
  summary: string;
  /** The commit the agent says it reviewed (`git rev-parse HEAD` in its
   *  checkout), 7–40 lowercase hex. The dispatcher's reviewed-head guard
   *  (reviewedHead.ts) compares it to the PR head when the workspace HEAD
   *  could not be observed directly. Absent when not supplied or malformed. */
  head?: string;
  /** Typed findings enumerated through `submit_verdict`. Present only when
   *  the input carried a findings array (possibly empty after drops); absent
   *  when no array was supplied or the array itself was malformed. */
  findings?: Finding[];
  /** Parse notes naming what was dropped from `findings` (ids/indices with
   *  reasons) — surfaced in the tool ack so the model can resubmit, never
   *  rendered into the posted body. */
  droppedFindings?: string[];
}

export const LGTM_TOKEN = "LGTM:";
export const CHANGES_TOKEN = "Changes requested:";
export const NO_VERDICT_LINE = "No verdict submitted — not approving.";

/** Parse an arbitrary tool input into a verdict, or null when it is not one. */
export function parseVerdictInput(input: Record<string, unknown>): ReviewVerdict | null {
  const verdict = input.verdict;
  if (verdict !== "approve" && verdict !== "request_changes") return null;
  const summary = typeof input.summary === "string" ? oneLine(input.summary) : "";
  const head = normalizeHead(input.head);
  const out: ReviewVerdict = { verdict, summary };
  if (head) out.head = head;
  if (input.findings !== undefined) {
    const parsed = parseFindings(input.findings);
    if (parsed.findings) out.findings = parsed.findings;
    if (parsed.dropped.length) out.droppedFindings = parsed.dropped;
    // Verdict/severity consistency, fail-closed: an approve carrying a
    // blocking finding downgrades so the posted body can never start with
    // `LGTM:` over a self-declared blocking defect. Keyed on the RAW entries'
    // declared severity, not the validated survivors — a blocking entry that
    // itself failed validation and dropped still poisons the approve.
    if (out.verdict === "approve" && parsed.blocking.length > 0) {
      out.verdict = "request_changes";
      out.summary = oneLine(
        `${out.summary} [downgraded from approve: blocking finding${parsed.blocking.length === 1 ? "" : "s"} ${parsed.blocking.join(", ")}]`,
      );
    }
  }
  return out;
}

/** Fail-closed per finding: each malformed entry drops with a note naming its
 *  index (and id when readable); a non-array drops the whole field.
 *  `blocking` labels every raw entry that declared severity "blocking" —
 *  valid or not — for the approve downgrade above. */
function parseFindings(value: unknown): { findings?: Finding[]; dropped: string[]; blocking: string[] } {
  if (!Array.isArray(value)) {
    return { dropped: ["findings: dropped — not an array"], blocking: [] };
  }
  const findings: Finding[] = [];
  const dropped: string[] = [];
  const blocking: string[] = [];
  value.forEach((raw, i) => {
    const parsed = parseFinding(raw);
    if (parsed.finding) {
      findings.push(parsed.finding);
    } else {
      dropped.push(`findings[${i}]${parsed.id ? ` (${parsed.id})` : ""}: dropped — ${parsed.reason}`);
    }
    const label = parsed.finding?.id ?? parsed.id ?? `findings[${i}]`;
    const r = typeof raw === "object" && raw !== null ? (raw as Record<string, unknown>) : undefined;
    if (r?.severity === "blocking") blocking.push(label);
  });
  return { findings, dropped, blocking };
}

function parseFinding(raw: unknown): { finding: Finding; id?: never; reason?: never } | { finding?: never; id?: string; reason: string } {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return { reason: "not an object" };
  const r = raw as Record<string, unknown>;
  const id = typeof r.id === "string" ? oneLine(r.id) : "";
  if (!id) return { reason: "missing or empty id" };
  const severity = r.severity;
  if (!(FINDING_SEVERITIES as readonly unknown[]).includes(severity)) {
    return { id, reason: `invalid severity ${JSON.stringify(r.severity)} (expected ${FINDING_SEVERITIES.join("|")})` };
  }
  const file = typeof r.file === "string" ? oneLine(r.file) : "";
  if (!file) return { id, reason: "missing or empty file" };
  const title = typeof r.title === "string" ? oneLine(r.title) : "";
  if (!title) return { id, reason: "missing or empty title" };
  const finding: Finding = { id, severity: severity as FindingSeverity, file, title };
  // Like `head`: an unusable optional locator is dropped, the finding stands —
  // dropping the whole finding over a bad line would also drop the severity
  // that the approve→request_changes downgrade keys on.
  if (typeof r.line === "number" && Number.isInteger(r.line) && r.line >= 1) finding.line = r.line;
  return { finding };
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

/** One compact finding line — `[severity] id file[:line] — title` — shared by
 *  the posted body's list (bulleted below) and ship's synthesized child turns. */
export function formatFinding(f: Finding): string {
  const location = f.line !== undefined ? `${f.file}:${f.line}` : f.file;
  return `[${f.severity}] ${f.id} ${location} — ${f.title}`;
}

/**
 * Build the body posted to GitHub: the deterministic verdict line, the
 * compact findings list (when present), a blank line, then the model's
 * review text. Never starts with "LGTM" unless the verdict is `approve`.
 */
export function buildReviewPostBody(answer: string, verdict: ReviewVerdict | undefined): string {
  const head = [verdictLine(verdict), ...(verdict?.findings ?? []).map((f) => `- ${formatFinding(f)}`)];
  return `${head.join("\n")}\n\n${answer.trim()}`;
}

// --- Dispositions (the coding side's answer to findings) -------------------
//
// A fix round records one disposition per finding through the
// `submit_dispositions` tool; the ship orchestrator keeps the last valid set
// and splits a cap report into declined (disposition recorded) vs unaddressed
// (none). Validation mirrors the findings above: a malformed entry drops with
// a note; a non-array input rejects the whole call.

export type DispositionKind = "fixed" | "declined";

export interface FindingDisposition {
  /** The stable finding id from the review verdict this disposition answers. */
  findingId: string;
  disposition: DispositionKind;
  /** One line: what was done, or why the finding was declined. */
  note: string;
}

/**
 * Parse a `submit_dispositions` input. Null when `dispositions` is not an
 * array (the call is rejected, nothing recorded); otherwise each malformed
 * entry drops with a note naming its index (and findingId when readable),
 * mirroring the per-finding validation above. A missing note is tolerated as
 * "" (the summary convention), never a dropped entry.
 */
export function parseDispositionsInput(
  input: Record<string, unknown>,
): { dispositions: FindingDisposition[]; dropped: string[] } | null {
  const value = input.dispositions;
  if (!Array.isArray(value)) return null;
  const dispositions: FindingDisposition[] = [];
  const dropped: string[] = [];
  value.forEach((raw, i) => {
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
      dropped.push(`dispositions[${i}]: dropped — not an object`);
      return;
    }
    const r = raw as Record<string, unknown>;
    const findingId = typeof r.findingId === "string" ? oneLine(r.findingId) : "";
    if (!findingId) {
      dropped.push(`dispositions[${i}]: dropped — missing or empty findingId`);
      return;
    }
    const disposition = r.disposition;
    if (disposition !== "fixed" && disposition !== "declined") {
      dropped.push(`dispositions[${i}] (${findingId}): dropped — invalid disposition ${JSON.stringify(r.disposition)} (expected fixed|declined)`);
      return;
    }
    const note = typeof r.note === "string" ? oneLine(r.note) : "";
    dispositions.push({ findingId, disposition, note });
  });
  return { dispositions, dropped };
}
