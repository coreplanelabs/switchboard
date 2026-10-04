import type { PullReviewFeedback } from "../execution/githubApi.js";
import { isFindingShape, parseVerdictInput, redactVerdict, type Finding, type ReviewVerdict } from "./reviewVerdict.js";
import { normalizeHead } from "./reviewedHead.js";
import { redactSecrets } from "./redact.js";
import { mapStringLeaves } from "./prDescription.js";

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
  progress?: { head: string; fingerprint: string; nextPage: number };
}

const VERDICT_MARKER = /^<!-- switchboard:verdict (\{[^\r\n]*\}) -->\r?$/gm;

/** Redact prose separately from the authoritative marker: header patterns can
 * consume the rest of a JSON line. Never re-redact the reconstructed envelope
 * or the serialized history document; only its text leaves are source text. */
export function redactReviewHistoryBody(review: PullReviewFeedback): string {
  if (review.authorType !== "Bot" || review.state === "PENDING") return redactSecrets(review.body);
  const marker = [...review.body.matchAll(VERDICT_MARKER)].at(-1);
  if (!marker) return redactSecrets(review.body);
  const raw = JSON.parse(marker[1]!);
  const payload = raw.verdict === "none" ? mapStringLeaves(raw, redactSecrets) : redactVerdict(parseVerdictInput(raw)!);
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
    const marker = [...review.body.matchAll(VERDICT_MARKER)].at(-1);
    if (!marker) {
      if (review.body.includes("<!-- switchboard:verdict")) throw new Error("Invalid review history marker");
      continue;
    }
    let raw: Record<string, unknown>;
    try {
      raw = JSON.parse(marker[1]!);
    } catch {
      throw new Error("Invalid review history marker JSON");
    }
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("Invalid review history marker");
    // A no-verdict post has no typed finding or closure authority.
    if (raw.verdict === "none") continue;
    const verdict = parseVerdictInput(raw);
    if (
      !verdict ||
      verdict.droppedFindings?.length ||
      (raw.findings !== undefined && (!Array.isArray(raw.findings) || !raw.findings.every(isFindingShape)))
    )
      throw new Error("Invalid typed review history");
    if (!verdict.head || verdict.head !== normalizeHead(review.head))
      throw new Error("Review history marker head disagrees with its native review head");
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
        finding: { ...finding, id: key },
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
    const missingCases = previous?.cases?.filter(
      (row) => !finding.cases?.some((next) => next.scenario === row.scenario && next.expected === row.expected),
    );
    if (missingCases?.length)
      return `preserve every previous case for ${finding.id}; copy these scenario and expected values exactly, then add new cases: ${JSON.stringify(missingCases)}`;
  }
  for (const resolution of resolutions) {
    if (!issued.has(resolution.findingId)) return `unknown resolution ${resolution.findingId}`;
    if (seen.has(resolution.findingId)) return `duplicate or overlapping outcome for ${resolution.findingId}`;
    if (!resolution.note.trim()) return `evidence note required for ${resolution.findingId}`;
    seen.add(resolution.findingId);
  }
  const missing = [...issued].filter((id) => !seen.has(id));
  return missing.length
    ? `re-raise or explicitly resolve each prior finding; missing: ${JSON.stringify(missing)}`
    : undefined;
}
