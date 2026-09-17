// Deterministic review verdict → GitHub comment body.
//
// Downstream automation (a repository's opt-in `auto-approve-review-lgtm.yml`
// workflow) approves a PR when the review App's review body STARTS WITH the
// exact token `LGTM:`. That token must therefore never depend on how the model happens to
// phrase its opening line. The model states its judgement through the
// structured `submit_verdict` tool (src/tools/submit.ts); this module turns
// that structured value into the first line of the posted body:
//
//   approve          → "LGTM: <summary>"
//   request_changes  → "Changes requested: <summary>"
//   (no verdict)     → "No verdict submitted — not approving." (fail-closed)
//
// The model's prose follows after a blank line. Whatever the prose says, only
// an explicit `approve` verdict can produce a body that begins with "LGTM".
//
// The verdict also carries typed findings (docs/reference/specs/agent-ship.md item 6):
// one compact entry per issue, rendered as a list under the verdict line, so
// a fix round can reference each finding by its stable id and answer it with
// a typed disposition (`parseDispositionsInput` below). Findings validate
// fail-closed PER finding — a malformed finding drops with a note, a
// malformed array drops the whole field.
//
// THE SEVERITY GATE (docs/reference/specs/agent-review.md item 5a): an
// `approve` carrying a finding at or above the severity to address — the
// level in force for the run, `minor` by default — is downgraded to
// `request_changes` HERE, where the verdict is parsed, so the posted body can
// never begin with `LGTM:` over a finding the loop would have to act on. The
// gate is keyed on the RAW entries' declared severity, so a finding that
// fails validation for another reason still poisons the approve. The same
// ladder is what ship's coordinator holds a posted approve to (agent-ship.md
// item 9) — that check is now defense in depth behind this one.

import { normalizeHead } from "./reviewedHead.js";
import { redactSecrets } from "./redact.js";

export type ReviewVerdictKind = "approve" | "request_changes";

/** The severity ladder, most to least severe. One list serves the findings a
 *  reviewer submits and the level the loop addresses: a finding's severity is
 *  compared to the level in force on this ladder, so nothing outside it can
 *  reach a gate — the parser drops an entry with any other severity (`fyi`,
 *  none) with a note. */
export const FINDING_SEVERITIES = ["blocking", "major", "minor", "nit"] as const;
export type FindingSeverity = (typeof FINDING_SEVERITIES)[number];

/** The severity to address (the loop's gate on a round): an approve carrying a
 *  finding at or above this level is not an approve. Resolved once per run —
 *  the request's `severity:` directive over the user's scope over the
 *  channel's over the org's `review.addressSeverity` — and handed to the
 *  verdict parser and ship's coordinator alike. */
export const ADDRESS_SEVERITIES = FINDING_SEVERITIES;
export type AddressSeverity = FindingSeverity;
/** Where the level in force came from, most specific wins: a `severity:`
 *  directive on the request (`run`), the user's or the channel's config scope,
 *  the org's `review.addressSeverity` (or its default). */
export type AddressSeveritySource = "org" | "channel" | "user" | "run";
export const DEFAULT_ADDRESS_SEVERITY: AddressSeverity = "minor";
export const isAddressSeverity = (v: unknown): v is AddressSeverity =>
  (ADDRESS_SEVERITIES as readonly unknown[]).includes(v);

const severityRank = (s: AddressSeverity): number => ADDRESS_SEVERITIES.indexOf(s);
/** Whether a declared severity sits at or above the level in force on the
 *  ladder — the one comparison every gate makes. A value outside the ladder is
 *  never at or above anything. */
export function severityAtOrAbove(severity: unknown, level: AddressSeverity): severity is AddressSeverity {
  return isAddressSeverity(severity) && severityRank(severity) <= severityRank(level);
}
/** The findings a gate acts on at `level`: at or above it. */
export function findingsAtOrAbove(findings: readonly Finding[], level: AddressSeverity): Finding[] {
  return findings.filter((f) => severityAtOrAbove(f.severity, level));
}

/** The level in force and the layer that set it: the request's
 *  `severity:` directive wins, then the user's scope, the channel's, the org's
 *  `review.addressSeverity` — the default counts as the org's. Resolved once
 *  per run by the dispatcher (every review's verdict parser reads it) and once
 *  per ship request by the hand-off, which writes it on the instance beside
 *  `merge` and hands it to each review child as its `severity:` directive. */
export function resolveAddressSeverity(layers: {
  org?: AddressSeverity;
  channel?: AddressSeverity;
  user?: AddressSeverity;
  run?: AddressSeverity;
}): { level: AddressSeverity; source: AddressSeveritySource } {
  if (layers.run !== undefined) return { level: layers.run, source: "run" };
  if (layers.user !== undefined) return { level: layers.user, source: "user" };
  if (layers.channel !== undefined) return { level: layers.channel, source: "channel" };
  return { level: layers.org ?? DEFAULT_ADDRESS_SEVERITY, source: "org" };
}

/** The gate's one sentence — `finding(s) <id> (<severity>)[, …] at or above
 *  <level>, the severity to address` — as the downgraded summary carries it into
 *  the posted body and the tool's ack repeats it to the model. */
export function downgradeNote(d: { findings: readonly string[]; level: AddressSeverity }): string {
  return `finding${d.findings.length === 1 ? "" : "s"} ${d.findings.join(", ")} at or above ${d.level}, the severity to address`;
}

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
  /** Parse note: the approve was downgraded by the severity gate — the gated
   *  findings as `id (severity)` and the level in force. Surfaced in the tool
   *  ack so the model knows its verdict changed; the summary carries the same
   *  words into the posted body, so this never rides a record. */
  downgraded?: { findings: string[]; level: AddressSeverity };
}

export const LGTM_TOKEN = "LGTM:";
export const CHANGES_TOKEN = "Changes requested:";
export const NO_VERDICT_LINE = "No verdict submitted — not approving.";

/** Parse an arbitrary tool input into a verdict, or null when it is not one.
 *  `addressSeverity` is the level in force for the run (default `minor`): an
 *  approve carrying a finding at or above it is parsed as `request_changes`. */
export function parseVerdictInput(
  input: Record<string, unknown>,
  opts: { addressSeverity?: AddressSeverity } = {},
): ReviewVerdict | null {
  const verdict = input.verdict;
  if (verdict !== "approve" && verdict !== "request_changes") return null;
  const level = opts.addressSeverity ?? DEFAULT_ADDRESS_SEVERITY;
  const summary = typeof input.summary === "string" ? oneLine(input.summary) : "";
  const head = normalizeHead(input.head);
  const out: ReviewVerdict = { verdict, summary };
  if (head) out.head = head;
  if (input.findings !== undefined) {
    const parsed = parseFindings(input.findings, level);
    if (parsed.findings) out.findings = parsed.findings;
    if (parsed.dropped.length) out.droppedFindings = parsed.dropped;
    // The severity gate, fail-closed: an approve carrying a finding at or
    // above the level in force downgrades, so the posted body can never start
    // with `LGTM:` over a finding the loop has to address. Keyed on the RAW
    // entries' declared severity, not the validated survivors — a gated entry
    // that itself failed validation and dropped still poisons the approve.
    if (out.verdict === "approve" && parsed.gated.length > 0) {
      out.verdict = "request_changes";
      out.downgraded = { findings: parsed.gated, level };
      out.summary = oneLine(`${out.summary} [downgraded from approve: ${downgradeNote(out.downgraded)}]`);
    }
  }
  return out;
}

/** Fail-closed per finding: each malformed entry drops with a note naming its
 *  index (and id when readable); a non-array drops the whole field. `gated`
 *  labels every raw entry whose declared severity sits at or above `level` —
 *  valid or not — as `id (severity)`, for the approve downgrade above. */
function parseFindings(
  value: unknown,
  level: AddressSeverity,
): { findings?: Finding[]; dropped: string[]; gated: string[] } {
  if (!Array.isArray(value)) {
    return { dropped: ["findings: dropped — not an array"], gated: [] };
  }
  const findings: Finding[] = [];
  const dropped: string[] = [];
  const gated: string[] = [];
  value.forEach((raw, i) => {
    const parsed = parseFinding(raw);
    if (parsed.finding) {
      findings.push(parsed.finding);
    } else {
      dropped.push(`findings[${i}]${parsed.id ? ` (${parsed.id})` : ""}: dropped — ${parsed.reason}`);
    }
    const label = parsed.finding?.id ?? parsed.id ?? `findings[${i}]`;
    const r = typeof raw === "object" && raw !== null ? (raw as Record<string, unknown>) : undefined;
    if (severityAtOrAbove(r?.severity, level)) gated.push(`${label} (${r?.severity})`);
  });
  return { findings, dropped, gated };
}

function parseFinding(
  raw: unknown,
): { finding: Finding; id?: never; reason?: never } | { finding?: never; id?: string; reason: string } {
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

/** One compact disposition line — `id: fixed|declined[ — note]` — the coding
 *  side's answer to a finding, as ship's re-review turn and the thread's
 *  artifacts block both render it. */
export function formatDisposition(d: FindingDisposition): string {
  return `${d.findingId}: ${d.disposition}${d.note ? ` — ${d.note}` : ""}`;
}

/** Where the posted body's file links point: the PR's repository and the
 *  head the review is pinned to (the post-step's `commitId`). */
export interface ReviewBodyTarget {
  /** `owner/name` */
  repo: string;
  /** The pinned head, full sha. */
  head: string;
}

/** The verdict word the callout carries, per verdict kind (or its absence). */
function verdictWord(verdict: ReviewVerdict | undefined): string {
  if (!verdict) return "No verdict";
  return verdict.verdict === "approve" ? "Approved" : "Changes requested";
}

/** GitHub's alert callout kind per verdict: an approve is a note, changes
 *  requested a warning, a missing verdict a caution. */
function calloutKind(verdict: ReviewVerdict | undefined): "NOTE" | "WARNING" | "CAUTION" {
  if (!verdict) return "CAUTION";
  return verdict.verdict === "approve" ? "NOTE" : "WARNING";
}

/** `2 findings: 1 minor, 1 nit` — counted on the ladder, most severe first;
 *  an empty array is `no findings`, no array `findings not itemized`. */
function findingCounts(findings: readonly Finding[] | undefined): string {
  if (findings === undefined) return "findings not itemized";
  if (findings.length === 0) return "no findings";
  const by = FINDING_SEVERITIES.map((sev) => [sev, findings.filter((f) => f.severity === sev).length] as const)
    .filter(([, n]) => n > 0)
    .map(([sev, n]) => `${n} ${sev}`)
    .join(", ");
  return `${findings.length} finding${findings.length === 1 ? "" : "s"}: ${by}`;
}

/** A table cell: pipes escaped so the row holds, already one line. */
const cell = (text: string): string => oneLine(text).replace(/\|/g, "\\|");

/** Whether a finding's `file` is a path a blob URL can point at: no
 *  whitespace, no backtick, not a URL. */
const isRepoPath = (file: string): boolean => /^[^\s`]+$/.test(file) && !/^[a-z][a-z0-9+.-]*:\/\//i.test(file);

/** The `Where` cell: the location in code, linked at the pinned head when the
 *  file is a path and a target is known. */
function whereCell(f: Finding, target: ReviewBodyTarget | undefined): string {
  const location = f.line !== undefined ? `${f.file}:${f.line}` : f.file;
  const label = `\`${cell(location)}\``;
  if (!target || !isRepoPath(f.file)) return label;
  const path = encodeURI(f.file).replace(/#/g, "%23").replace(/\?/g, "%3F");
  const url = `https://github.com/${target.repo}/blob/${target.head}/${path}${f.line !== undefined ? `#L${f.line}` : ""}`;
  return `[${label}](${url})`;
}

/** The machine-readable marker the body ends with — the verdict, the head and
 *  the findings index as JSON inside an HTML comment, for a scanner that would
 *  otherwise parse the token line. `-->` can never occur inside it. */
function verdictMarker(verdict: ReviewVerdict | undefined, target: ReviewBodyTarget | undefined): string {
  const head = target?.head ?? verdict?.head;
  const payload = {
    verdict: verdict?.verdict ?? "none",
    ...(head ? { head } : {}),
    ...(verdict?.findings
      ? {
          findings: verdict.findings.map((f) => ({
            id: f.id,
            severity: f.severity,
            file: f.file,
            ...(f.line !== undefined ? { line: f.line } : {}),
          })),
        }
      : {}),
  };
  return `<!-- switchboard:verdict ${JSON.stringify(payload).replace(/-->/g, "--\\u003e")} -->`;
}

/**
 * Build the body posted to GitHub, rendered from the typed verdict
 * (docs/reference/specs/agent-review.md item 5b): the deterministic verdict
 * line first (the auto-approve contract — never `LGTM:` unless the verdict is
 * `approve`), a GitHub alert callout with the verdict word, the pinned head
 * and the finding counts, the findings as a table (severity, id + title, the
 * file linked at the head), the model's text folded under `Full review`, and
 * the machine-readable marker last. The prose decides nothing above the fold.
 */
export function buildReviewPostBody(
  answer: string,
  verdict: ReviewVerdict | undefined,
  target?: ReviewBodyTarget,
): string {
  const facts = [
    `**${verdictWord(verdict)}**`,
    ...(target ? [`head \`${target.head.slice(0, 7)}\``] : []),
    verdict ? findingCounts(verdict.findings) : "the run ended without a submit_verdict call",
  ];
  const parts: string[] = [verdictLine(verdict), `> [!${calloutKind(verdict)}]\n> ${facts.join(" · ")}`];
  const findings = verdict?.findings ?? [];
  if (findings.length > 0) {
    parts.push(
      [
        "| Severity | Finding | Where |",
        "| --- | --- | --- |",
        ...findings.map((f) => `| ${f.severity} | **${cell(f.id)}** ${cell(f.title)} | ${whereCell(f, target)} |`),
      ].join("\n"),
    );
  }
  const prose = answer.trim();
  if (prose) parts.push(`<details>\n<summary>Full review</summary>\n\n${prose}\n\n</details>`);
  parts.push(verdictMarker(verdict, target));
  return parts.join("\n\n");
}

/**
 * The channel reply for a review run, rendered from the typed verdict
 * (agent-review.md item 5b): the verdict line, one bullet per finding, then
 * where the review was posted and the run link. The model's write-up rides
 * along only when it landed nowhere else — no GitHub post (Slack-only, an
 * opt-out, a guard refusal) or findings not itemized (a list that says
 * nothing is no substitute) — so the review's text is always somewhere a
 * person reads it. No verdict → the bare answer with the link, as before.
 */
export function buildReviewChannelReply(input: {
  answer: string;
  verdict: ReviewVerdict | undefined;
  /** The PR the post landed on, or undefined when nothing was posted. */
  posted: { repo: string; number: number } | undefined;
  liveUrl: string | undefined;
}): string {
  const { answer, verdict, posted, liveUrl } = input;
  const tail = [
    ...(posted && verdict ? [`Posted to ${posted.repo}#${posted.number}`] : []),
    ...(liveUrl ? [`[Live run](${liveUrl})`] : []),
  ].join(" · ");
  const blocks: string[] = [];
  if (!verdict) blocks.push(answer);
  else {
    blocks.push([verdictLine(verdict), ...(verdict.findings ?? []).map((f) => `- ${formatFinding(f)}`)].join("\n"));
    const compact = posted !== undefined && verdict.findings !== undefined;
    if (!compact && answer.trim()) blocks.push(answer.trim());
  }
  if (tail) blocks.push(tail);
  return blocks.join("\n\n");
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
      dropped.push(
        `dispositions[${i}] (${findingId}): dropped — invalid disposition ${JSON.stringify(r.disposition)} (expected fixed|declined)`,
      );
      return;
    }
    const note = typeof r.note === "string" ? oneLine(r.note) : "";
    dispositions.push({ findingId, disposition, note });
  });
  return { dispositions, dropped };
}

// ---- the stored shapes (docs/reference/specs/run-history.md items 2 and 3) ---------------------------

const VERDICT_KINDS: readonly string[] = ["approve", "request_changes"];
const DISPOSITION_KINDS: readonly string[] = ["fixed", "declined"];

const isRecordLike = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null;

function isFindingShape(v: unknown): v is Finding {
  if (!isRecordLike(v)) return false;
  return (
    typeof v.id === "string" &&
    (FINDING_SEVERITIES as readonly string[]).includes(v.severity as string) &&
    typeof v.file === "string" &&
    typeof v.title === "string" &&
    (v.line === undefined || typeof v.line === "number")
  );
}

/** Structural check on a verdict read back from a stored record: the kind, a
 *  string summary, an optional string head, findings each with an id, a known
 *  severity, a file and a title. Shape only, no bounds — what a record carries
 *  was validated by `parseVerdictInput` on the way in and redacted since. */
export function isReviewVerdictShape(v: unknown): v is ReviewVerdict {
  if (!isRecordLike(v)) return false;
  if (!VERDICT_KINDS.includes(v.verdict as string) || typeof v.summary !== "string") return false;
  if (v.head !== undefined && typeof v.head !== "string") return false;
  if (v.findings !== undefined && !(Array.isArray(v.findings) && v.findings.every(isFindingShape))) return false;
  return true;
}

/** How a review run's post-step ended, as the run's record carries it
 *  (docs/reference/specs/agent-review.md item 18; run-history item 2): the verdict
 *  landed on a named pull request pinned to `head` (the verdict kind rides when
 *  one was submitted — a review that posted without a verdict posts the
 *  no-verdict line), or nothing landed and `reason` says why — a guard's
 *  refusal, an opt-out, no pull request, GitHub's own error. A coordinator's
 *  `read-record` answers `reviewPosted` from this before it asks GitHub, whose
 *  review list can lag a post it accepted a second ago. */
export type ReviewPost =
  | { posted: true; target: { repo: string; number: number }; head: string; verdict?: ReviewVerdictKind }
  | { posted: false; reason: string };

const REVIEW_POST_HEAD = /^[0-9a-f]{7,40}$/;

/** Structural check on a review post read back from a stored record: a posted
 *  outcome names its pull request and a 7-to-40-hex head, its verdict (when
 *  present) a known kind; a skipped one carries a string reason. */
export function isReviewPostShape(v: unknown): v is ReviewPost {
  if (!isRecordLike(v)) return false;
  if (v.posted === false) return typeof v.reason === "string";
  if (v.posted !== true) return false;
  const target = v.target;
  if (
    !isRecordLike(target) ||
    typeof target.repo !== "string" ||
    typeof target.number !== "number" ||
    !Number.isInteger(target.number) ||
    target.number <= 0
  )
    return false;
  if (typeof v.head !== "string" || !REVIEW_POST_HEAD.test(v.head)) return false;
  return v.verdict === undefined || VERDICT_KINDS.includes(v.verdict as string);
}

/** The skip's reason through the redaction seam (it may carry GitHub's own
 *  words); a posted outcome has no free text and is returned as it is. */
export function redactReviewPost(post: ReviewPost, redact: (s: string) => string = redactSecrets): ReviewPost {
  return post.posted ? post : { posted: false, reason: redact(post.reason) };
}

/** Structural check on a disposition set read back from a stored record. */
export function isFindingDispositionsShape(v: unknown): v is FindingDisposition[] {
  return (
    Array.isArray(v) &&
    v.every(
      (d) =>
        isRecordLike(d) &&
        typeof d.findingId === "string" &&
        DISPOSITION_KINDS.includes(d.disposition as string) &&
        typeof d.note === "string",
    )
  );
}

/** Every string leaf of the verdict through the redaction seam — the summary,
 *  each finding's file and title — the input untouched: what the one record
 *  assembly writes. `droppedFindings` are parse notes for the model and never
 *  ride a record. */
export function redactVerdict(v: ReviewVerdict, redact: (s: string) => string = redactSecrets): ReviewVerdict {
  return {
    verdict: v.verdict,
    summary: redact(v.summary),
    ...(v.head !== undefined ? { head: v.head } : {}),
    ...(v.findings !== undefined
      ? { findings: v.findings.map((f) => ({ ...f, file: redact(f.file), title: redact(f.title) })) }
      : {}),
  };
}

export function redactDispositions(
  dispositions: readonly FindingDisposition[],
  redact: (s: string) => string = redactSecrets,
): FindingDisposition[] {
  return dispositions.map((d) => ({ findingId: d.findingId, disposition: d.disposition, note: redact(d.note) }));
}
