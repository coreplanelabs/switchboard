import type { PullReviewFeedback } from "../execution/githubApi.js";
import {
  completeReviewVerdict,
  isFindingShape,
  parseVerdictInput,
  redactVerdict,
  type Finding,
  type ReviewVerdict,
} from "./reviewVerdict.js";
import { normalizeHead } from "./reviewedHead.js";
import { redactSecrets } from "./redact.js";
import { mapStringLeaves } from "./prDescription.js";
import type { ReviewHistoryReadReceipt } from "./references/sourceResultContext.js";

export interface PriorReviewFinding {
  reviewId: number;
  author: string;
  head: string;
  finding: Finding;
}

/** Rebuilt from GitHub on each run; accepted closures persist in the verdict, not this cache. */
export interface ReviewHistoryContext {
  target: { repo: string; number: number };
  /** Dispatcher-pinned head for a head-move re-review and all later verdict turns. */
  requiredHead?: string;
  snapshot?: { head: string; findings: PriorReviewFinding[] };
  /** Pages are delivered in order from one unchanged source snapshot. */
  progress?: { head: string; fingerprint: string; nextPage: number; pageSize?: number };
  /** Controller-only layout override for validating a recorded read without widening the result budget. */
  pageSize?: number;
  /** Controller-only native metadata for this read; persisted on its source result receipt. */
  lastRead?: ReviewHistoryReadReceipt;
  /** The existing required-head guard is committed before a head-move model turn. */
  commitRequiredHead?: (head: string) => Promise<boolean>;
}

const VERDICT_MARKER = /^<!-- switchboard:verdict (\{[^\r\n]*\}) -->\r?$/gm;

function markedReview(body: string): { marker: RegExpMatchArray; input: Record<string, unknown> } | undefined {
  const marker = [...body.matchAll(VERDICT_MARKER)].at(-1);
  const last = [...body.matchAll(/^<!-- switchboard:verdict/gm)].at(-1);
  if (!marker || last?.index !== marker.index) {
    if (body.includes("<!-- switchboard:verdict")) throw new Error("Invalid review history marker");
    return undefined;
  }
  let raw: unknown;
  try {
    raw = JSON.parse(marker[1]!);
  } catch {
    throw new Error("Invalid review history marker JSON");
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("Invalid review history marker");
  return { marker, input: raw as Record<string, unknown> };
}

/** Old incomplete reports remain context, but malformed typed evidence still refuses the read. */
function historyVerdict(input: Record<string, unknown>): ReviewVerdict | undefined {
  if (input.verdict === "none") return undefined;
  const verdict = parseVerdictInput(input, { history: true });
  if (
    !verdict ||
    verdict.droppedFindings?.length ||
    (input.findings !== undefined && (!Array.isArray(input.findings) || !input.findings.every(isFindingShape)))
  )
    throw new Error("Invalid typed review history");
  for (const [index, finding] of (verdict.findings ?? []).entries()) {
    const original = (input.findings as Finding[])[index]!;
    const caseIds = finding.cases?.flatMap((row) => (row.id ? [row.id] : [])) ?? [];
    if (finding.id !== original.id || new Set(caseIds).size !== caseIds.length)
      throw new Error("Invalid typed review history");
  }
  return verdict;
}

/** Legacy matrices get IDs in their recorded order. Appends never renumber existing cases. */
export function withFindingCaseIds(finding: Finding): Finding {
  if (!finding.cases) return finding;
  let next = Math.max(0, ...finding.cases.map((row) => (row.id ? Number(row.id.slice(1)) : 0)));
  return { ...finding, cases: finding.cases.map((row) => ({ ...row, id: row.id ?? `C${++next}` })) };
}

/** Prior text belongs to the record. A follow-up supplies identity and new cases only. */
export function materializeReviewFollowup(
  input: Record<string, unknown>,
  prior: readonly PriorReviewFinding[],
): { input: Record<string, unknown>; error?: string } {
  if (!Array.isArray(input.findings)) return { input };
  let error: string | undefined;
  const findings = input.findings.map((raw) => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return raw;
    const row = raw as Record<string, unknown>;
    const previous = prior.find((p) => p.finding.id === row.id)?.finding;
    const additions = row.cases;
    if (Array.isArray(additions) && additions.some((value) => value && typeof value === "object" && "id" in value)) {
      error = `new cases for ${row.id} must omit IDs; assess prior cases in caseAssessments`;
      return raw;
    }
    if (!previous) {
      if (typeof row.id === "string" && row.id.startsWith("review:"))
        error = `unknown prior finding ${row.id}; read complete review history first`;
      return raw;
    }
    if (additions !== undefined && !Array.isArray(additions)) {
      error = `new cases for ${previous.id} must be an array`;
      return raw;
    }
    if (Array.isArray(additions) && additions.length && !previous.cases) {
      error = `prior finding ${previous.id} has no invariant case table; new cases require a pattern finding`;
      return raw;
    }
    const metadata: Finding = { ...previous, kind: previous.kind ?? (previous.cases ? "pattern" : "single") };
    if (
      Object.entries(row).some(
        ([key, value]) => key !== "id" && key !== "cases" && value !== metadata[key as keyof Finding],
      )
    ) {
      error = `metadata for ${previous.id} belongs to history; re-raise with its ID and new cases only`;
      return raw;
    }
    return {
      ...metadata,
      ...(previous.cases
        ? { cases: [...withFindingCaseIds(previous).cases!, ...((additions as unknown[]) ?? [])] }
        : {}),
    };
  });
  return { input: { ...input, findings }, ...(error ? { error } : {}) };
}

/** Redact prose separately from the authoritative marker: header patterns can
 * consume the rest of a JSON line. Never re-redact the reconstructed envelope
 * or the serialized history document; only its text leaves are source text. */
export function redactReviewHistoryBody(review: PullReviewFeedback): string {
  if (review.authorType !== "Bot" || review.state === "PENDING") return redactSecrets(review.body);
  const marked = markedReview(review.body);
  if (!marked) return redactSecrets(review.body);
  const { marker, input } = marked;
  const verdict = historyVerdict(input);
  const payload = verdict ? redactVerdict(verdict) : mapStringLeaves(input, redactSecrets);
  const envelope = `<!-- switchboard:verdict ${JSON.stringify(payload).replace(/[<>]/g, (c) => (c === "<" ? "\\u003c" : "\\u003e"))} -->`;
  return (
    redactSecrets(review.body.slice(0, marker.index)) +
    envelope +
    redactSecrets(review.body.slice(marker.index! + marker[0].length))
  );
}

/** Marked review text is source context. Native review IDs, author and head
 * bind its references; neither prose nor an author's fix claim can close a finding. */
export function outstandingReviewFindings(reviews: readonly PullReviewFeedback[]): PriorReviewFinding[] {
  const outstanding = new Map<string, PriorReviewFinding>();
  const known = new Map<string, string>();
  const ids = new Set<number>();
  for (const review of [...reviews].sort((a, b) => a.submittedAt.localeCompare(b.submittedAt) || a.id - b.id)) {
    if (ids.has(review.id)) throw new Error("Duplicate review identity in history");
    ids.add(review.id);
    if (review.authorType !== "Bot" || review.state === "PENDING") continue;
    const marked = markedReview(review.body);
    if (!marked) continue;
    const verdict = historyVerdict(marked.input);
    if (!verdict) continue;
    if (!verdict.head || verdict.head !== normalizeHead(review.head))
      throw new Error("Review history marker head disagrees with its native review head");
    if (!completeReviewVerdict(verdict)) continue;
    const repeated = new Set<string>();
    for (const finding of verdict.findings ?? []) {
      const key = known.get(finding.id) === review.author ? finding.id : `review:${review.id}:${finding.id}`;
      if (repeated.has(key)) throw new Error("Duplicate finding identity in review history");
      repeated.add(key);
      known.set(key, review.author);
      outstanding.set(key, {
        reviewId: review.id,
        author: review.author,
        head: verdict.head,
        finding: withFindingCaseIds({ ...finding, id: key }),
      });
    }
    for (const closure of verdict.resolutions ?? []) {
      if (repeated.has(closure.findingId)) throw new Error("Review history both resolves and re-raises a finding");
      if (known.get(closure.findingId) === review.author) outstanding.delete(closure.findingId);
    }
  }
  return [...outstanding.values()];
}

/** Enforces coverage and identity, not the truth of the reviewer's evidence. */
export function validateReviewFollowup(
  verdict: ReviewVerdict,
  prior: readonly PriorReviewFinding[],
): string | undefined {
  const issued = new Set(prior.map((p) => p.finding.id));
  const findings = verdict.findings ?? [];
  const resolutions = verdict.resolutions ?? [];
  const seen = new Set<string>();
  for (const finding of findings) {
    if (seen.has(finding.id)) return `duplicate finding ${finding.id}`;
    if (finding.id.startsWith("review:") && !issued.has(finding.id)) return `unknown prior finding ${finding.id}`;
    seen.add(finding.id);
    const previous = prior.find((p) => p.finding.id === finding.id)?.finding;
    const missingCases =
      previous &&
      withFindingCaseIds(previous).cases?.filter(
        (row) =>
          !finding.cases?.some(
            (next) => next.id === row.id && next.scenario === row.scenario && next.expected === row.expected,
          ),
      );
    if (missingCases?.length) return `prior case identity or text changed for ${finding.id}`;
  }
  for (const resolution of resolutions) {
    if (!issued.has(resolution.findingId)) return `unknown resolution ${resolution.findingId}`;
    if (seen.has(resolution.findingId)) return `duplicate or overlapping outcome for ${resolution.findingId}`;
    if (!resolution.note.trim()) return `evidence note required for ${resolution.findingId}`;
    seen.add(resolution.findingId);
  }
  const missing = [...issued].filter((id) => !seen.has(id));
  if (missing.length) return `re-raise or explicitly resolve each prior finding; missing: ${JSON.stringify(missing)}`;
  const assessments = verdict.caseAssessments ?? [];
  const assessed = new Set<string>();
  for (const row of assessments) {
    const previous = prior.find((p) => p.finding.id === row.findingId)?.finding;
    if (!previous || !withFindingCaseIds(previous).cases?.some((c) => c.id === row.caseId))
      return `unknown prior case ${row.findingId}/${row.caseId}`;
    const key = JSON.stringify([row.findingId, row.caseId]);
    if (assessed.has(key)) return `duplicate case assessment ${row.findingId}/${row.caseId}`;
    assessed.add(key);
    if (!row.note.trim()) return `current-head evidence required for ${row.findingId}/${row.caseId}`;
    const closure = resolutions.find((r) => r.findingId === row.findingId);
    if (closure && (row.outcome === "open" || (closure.disposition === "declined" && row.outcome !== "declined")))
      return `case ${row.findingId}/${row.caseId} must support its ${closure.disposition} resolution`;
  }
  for (const { finding } of prior) {
    const previous = withFindingCaseIds(finding);
    const missing = previous.cases?.filter((row) => !assessed.has(JSON.stringify([finding.id, row.id])));
    if (missing?.length)
      return `assess every prior case for ${finding.id} in caseAssessments with outcome and current-head evidence; missing: ${JSON.stringify(missing.map((row) => row.id))}`;
    if (
      previous.cases &&
      resolutions.some((row) => row.findingId === finding.id && row.disposition === "fixed") &&
      !assessments.some((row) => row.findingId === finding.id && row.outcome === "fixed")
    )
      return `a fixed resolution for ${finding.id} requires a verified fixed case; decline findings whose cases do not apply`;
    const repeated = findings.find((f) => f.id === finding.id);
    if (
      previous.cases &&
      repeated &&
      !assessments.some((row) => row.findingId === finding.id && row.outcome === "open") &&
      repeated.cases?.length === previous.cases.length
    )
      return `resolve ${finding.id} when all its cases are closed, or add the newly failing case`;
  }
  return undefined;
}
