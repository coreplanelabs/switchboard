import { z } from "zod";
import { checkPrTitle, TITLE_MAX_LENGTH, titleCapProblem } from "./prTitle.mjs";
import PR_TITLE_VOCABULARY from "./prTitleVocabulary.json" with { type: "json" };
import { redactSecrets } from "./redact.js";
import { SWITCHBOARD_REPO } from "./selfDescription.js";

// The PR description as DATA (docs/reference/specs/pr-description.md; the
// shape is docs/decisions/0050). One typed object carries everything a reader
// needs about a change and each surface has its own renderer over it:
// `renderPrDescriptionMarkdown` for the GitHub body today, the run page's
// review panel, whatever replaces GitHub after that. Nothing about the content
// is authored per surface, so there is never a second copy to keep in sync;
// and because anchors are stored as (path, from, to) and rendered against the
// head sha at render time, regenerating the body after a repush is a
// re-render, not a rewrite.
//
// The body has two parts. Above the fold, the MAP — tldr, why, at most seven
// pointers, feedback wanted, risk, verified — every field capped here so the
// map's size does not grow with the diff (an 80-file PR gets the same seven
// rows as a 3-file PR). Below the fold, collapsed: decisions, the validation
// criteria with their proofs, notes for agents — capped too, so the whole body
// is bounded.

/** The caps (docs/decisions/0050 "The cap"): visible characters per field,
 *  a markdown link's target excluded, and the counts. One table, read by the
 *  schema, the prompt and the tool descriptions. */
export const PR_DESCRIPTION_CAPS = {
  /** The squash subject and the changelog line, the whole line counted: the
   *  title gate's own number (`src/core/prTitle.mjs`), read from it so the
   *  two cannot drift. */
  title: TITLE_MAX_LENGTH,
  tldr: 300,
  why: 400,
  pointers: 7,
  pointerLabel: 60,
  pointerText: 160,
  pointerRisk: 100,
  feedbackWanted: 200,
  risk: 300,
  verified: 200,
  decisions: 10,
  decisionRationale: 400,
  criteria: 30,
  criterion: 200,
  proof: 300,
  agentNotes: 2000,
} as const;

/** The characters a reader sees: a markdown link `[label](target)` counts its
 *  label only, so a `why` with three issue links is not punished for their
 *  URLs. */
export function visibleLength(s: string): number {
  return s.replace(/\]\([^)\s]*\)/g, "]").length;
}

/** A markdown link as `visibleLength` reads one — the label with its target —
 *  kept whole by `fitToCap`, so a cut never lands inside `[label](target)`. */
const LINK_RE = /\[[^\]\n]*\]\([^)\s]*\)/;
/** A word for the cut: a maximal run of links and non-space characters, so
 *  `([#1](url)),` is one word and the cut falls only on whitespace. */
const WORD_RE = new RegExp(`(?:${LINK_RE.source}|\\S)+`, "g");
/** What a cut leaves behind at its end: the whitespace before the word that
 *  did not fit and a separator that belonged to that word's clause — a comma,
 *  a semicolon, a colon, a dash, an opening bracket. A period stays: it ends
 *  the sentence before the cut. */
const ORPHANS_RE = /[\s,;:—–([{]+$/u;

/**
 * The longest prefix of `s` whose length under `measure` (`visibleLength` by
 * default: a link's target counts for nothing; the title passes its raw count)
 * is at most `max`, cut at a word boundary — never inside a word and never
 * inside a link: a link that does not fit whole is dropped whole — with the
 * whitespace and the separator the cut orphaned trimmed off. Already-fitting
 * text comes back unchanged. When not even the first word fits the answer is
 * the empty string: a cut inside a word is a worse suggestion than none, and
 * the caps are sixty characters and up, so it takes a sixty-character word.
 */
export function fitToCap(s: string, max: number, measure: (s: string) => number = visibleLength): string {
  if (measure(s) <= max) return s;
  let end = 0;
  for (const m of s.matchAll(WORD_RE)) {
    const candidate = m.index + m[0].length;
    if (measure(s.slice(0, candidate)) > max) break;
    end = candidate;
  }
  return s.slice(0, end).replace(ORPHANS_RE, "");
}

// `line` is single-line by contract: a title, a label or a pointer's sentence
// with an embedded newline would split the renderer's numbered rows — and the
// PR title goes verbatim into POST /pulls. `prose` may span lines.
const line = z
  .string()
  .trim()
  .min(1)
  .refine((s) => !/[\r\n]/.test(s), "must be a single line (no embedded newlines)");
const prose = z.string().trim().min(1);

/** What a cap issue carries beside its message, on the zod issue's `params`:
 *  the cap, the count and the rule that counted — so a refusal can say how
 *  much to remove and quote the prefix that fits without parsing its own
 *  sentence back. */
interface CapIssueParams {
  cap: number;
  got: number;
  counted: "visible" | "raw";
}

const capIssue = (params: CapIssueParams, message: string) => ({ code: z.ZodIssueCode.custom, message, params });

/** `line`/`prose` with a visible-character cap; the message names the cap and
 *  the count so the author knows how much to cut. */
function capped<T extends z.ZodType<string>>(base: T, max: number) {
  return base.superRefine((s, ctx) => {
    const n = visibleLength(s);
    if (n > max)
      ctx.addIssue(capIssue({ cap: max, got: n, counted: "visible" }, `at most ${max} visible characters (got ${n})`));
  });
}

/** `line` with a raw-character cap — for the title, which GitHub never
 *  renders as markdown, so a link's target is characters the reader sees.
 *  Counts exactly what the title gate counts; holds on every repository. */
function cappedRaw<T extends z.ZodType<string>>(base: T, max: number) {
  return base.superRefine((s, ctx) => {
    const n = s.length;
    if (n > max) ctx.addIssue(capIssue({ cap: max, got: n, counted: "raw" }, `at most ${max} characters (got ${n})`));
  });
}

/** The repository whose CI carries the title gate — this project's own. Its
 *  vocabulary (the code map's Areas, the release config's types) is the house
 *  convention of one repository, so only a description bound for it is judged
 *  by it; every other repository keeps the cap alone, as before the gate. */
export const TITLE_GATE_REPOSITORY = SWITCHBOARD_REPO;

/** Whether a description bound for `repo` (`owner/name`, as the dispatcher
 *  resolved it; undefined for a no-repo run) is judged by the title gate. */
export function titleGateApplies(repo: string | undefined): boolean {
  return repo !== undefined && repo.toLowerCase() === TITLE_GATE_REPOSITORY;
}

/** `line` judged as the CI title gate judges it (`checkPrTitle`, the one
 *  predicate `scripts/check-pr-title.mjs` runs, against the generated
 *  vocabulary): the grammar, the type, the scope from the code map's Areas,
 *  no trailing period, and the 72-character cap counted raw with the bots'
 *  scopes and a revert exempt. One issue per problem, in the gate's own
 *  sentence, so a run cuts and resubmits inside its turn instead of learning
 *  from a red `title` check once the PR is open — the last tool call of a
 *  run whose loop was cut has no shell left to ask the gate itself. The
 *  migration note behind `!` needs files only the gate can read, so the gate
 *  alone judges that. An empty title is already `line`'s issue. */
const gatedTitle = line.superRefine((s, ctx) => {
  if (s === "") return;
  const verdict = checkPrTitle(s, PR_TITLE_VOCABULARY);
  if (verdict.ok) return;
  // The gate's cap problem is a cap issue like `cappedRaw`'s — same numbers,
  // the gate's sentence — so the refusal answers it with the cut too.
  const cap = titleCapProblem(s.length);
  for (const message of verdict.problems)
    ctx.addIssue(
      message === cap
        ? capIssue({ cap: TITLE_MAX_LENGTH, got: s.length, counted: "raw" }, message)
        : { code: z.ZodIssueCode.custom, message },
    );
});

/** Between a pointer's text and its risk on the rendered row. */
export const RISK_SEPARATOR = " ⚠ ";

/** The lines a pointer sends the reader to: a path + inclusive 1-based line
 *  range in the PR head. The sha is NOT stored here — it is supplied at render
 *  time. */
export const PrAnchorSchema = z
  .object({
    // Repo-relative: no leading `/`, no `..` SEGMENT (a filename like `a..b.ts` is fine).
    path: z
      .string()
      .trim()
      .min(1)
      .refine((p) => !p.startsWith("/") && !p.split("/").includes(".."), "path must be repo-relative"),
    from: z.number().int().positive(),
    to: z.number().int().positive(),
  })
  .refine((a) => a.to >= a.from, "to must be >= from");

/** One row of "Where to look": a linked label, one sentence, an optional risk
 *  (rendered as ⚠), and the lines the label links to. */
export const PointerSchema = z.object({
  label: capped(line, PR_DESCRIPTION_CAPS.pointerLabel),
  // ` ⚠ ` is the renderer's text/risk separator; a text carrying it would
  // parse back with its tail as the risk.
  text: capped(line, PR_DESCRIPTION_CAPS.pointerText).refine(
    (s) => !s.includes(RISK_SEPARATOR),
    `must not contain "${RISK_SEPARATOR}" (the risk separator)`,
  ),
  risk: capped(line, PR_DESCRIPTION_CAPS.pointerRisk).optional(),
  anchor: PrAnchorSchema,
});

/** A bounded array whose message names the cap and the count
 *  (`at most 7 pointers (got 12)`), never zod's generic element count. */
function boundedArray<T extends z.ZodTypeAny>(item: T, min: number, max: number, what: string) {
  return z.array(item).superRefine((arr, ctx) => {
    if (arr.length < min)
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: `at least ${min} ${what} (got ${arr.length})` });
    if (arr.length > max)
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: `at most ${max} ${what} (got ${arr.length})` });
  });
}

export const PrDescriptionSchema = z.object({
  /** The PR title's single source. Metadata for the PR's own title field —
   *  never rendered into the body (GitHub shows the title itself) — and the
   *  squash subject, so it is capped like every other field; on the
   *  repository that carries the title gate, `prDescriptionSchemaFor` judges
   *  it as the gate does. */
  title: cappedRaw(line, PR_DESCRIPTION_CAPS.title),
  tldr: capped(prose, PR_DESCRIPTION_CAPS.tldr),
  why: capped(prose, PR_DESCRIPTION_CAPS.why),
  pointers: boundedArray(PointerSchema, 1, PR_DESCRIPTION_CAPS.pointers, "pointers"),
  feedbackWanted: capped(prose, PR_DESCRIPTION_CAPS.feedbackWanted),
  risk: capped(prose, PR_DESCRIPTION_CAPS.risk),
  verified: capped(prose, PR_DESCRIPTION_CAPS.verified),
  decisions: boundedArray(
    z.object({ title: line, rationale: capped(prose, PR_DESCRIPTION_CAPS.decisionRationale) }),
    0,
    PR_DESCRIPTION_CAPS.decisions,
    "decisions",
  ),
  validation: z.object({
    criteria: boundedArray(
      z.object({
        criterion: capped(prose, PR_DESCRIPTION_CAPS.criterion),
        proof: capped(prose, PR_DESCRIPTION_CAPS.proof),
      }),
      1,
      PR_DESCRIPTION_CAPS.criteria,
      "criteria",
    ),
  }),
  agentNotes: capped(prose, PR_DESCRIPTION_CAPS.agentNotes).optional(),
});

// The shape lives zod-free in prDescriptionTypes.ts (the run-event contract
// needs it without this module's zod dependency); re-exported here so schema
// consumers keep one import. The annotated return below is what pins the zod
// output to that shape — drift either way is a compile error.
import type { DescriptionIssue, PrAnchor, PrDescription, RecordedJson, RenderedPointer } from "./prDescriptionTypes.js";
export type {
  DescriptionIssue,
  PrAnchor,
  Pointer,
  PrDescription,
  RecordedJson,
  RenderedPrAnchor,
  RenderedPointer,
} from "./prDescriptionTypes.js";

/** Validate untrusted input (a tool call, a JSON file) into a PrDescription.
 *  Throws a zod error naming the offending path — callers surface it. */
/** The schema for a description bound for `repo`: the universal one, with the
 *  title judged as the CI title gate judges it on the repository that carries
 *  the gate (`titleGateApplies`). The gated schema replaces the cap's message
 *  with the gate's own count sentence — one wording per repository, never two. */
export function prDescriptionSchemaFor(repo: string | undefined): typeof PrDescriptionSchema {
  return titleGateApplies(repo) ? PrDescriptionSchema.extend({ title: gatedTitle }) : PrDescriptionSchema;
}

/** The one validating entry point. `target.repo` is the repository the
 *  description is bound for (`ToolContext.repo`); absent, no repository
 *  carries the gate and the universal schema judges. */
export function parsePrDescription(input: unknown, target: { repo?: string } = {}): PrDescription {
  return prDescriptionSchemaFor(target.repo).parse(input);
}

/** The value a zod path names in `input`, when it is a string — the field a
 *  cap issue is about. The schema trims before it counts, so the cut is over
 *  the trimmed text: what the count was taken on. */
function stringAt(input: unknown, path: ReadonlyArray<PropertyKey>): string | undefined {
  let v: unknown = input;
  for (const key of path) {
    if (typeof v !== "object" || v === null || typeof key === "symbol") return undefined;
    v = (v as Record<string | number, unknown>)[key];
  }
  return typeof v === "string" ? v.trim() : undefined;
}

/** The cap params a zod issue carries, when it is one of `capped`'s. */
function capParamsOf(issue: z.ZodIssue): CapIssueParams | undefined {
  if (issue.code !== z.ZodIssueCode.custom) return undefined;
  const p = issue.params as Partial<CapIssueParams> | undefined;
  return p && typeof p.cap === "number" && typeof p.got === "number" && (p.counted === "visible" || p.counted === "raw")
    ? { cap: p.cap, got: p.got, counted: p.counted }
    : undefined;
}

/**
 * Every issue a refused submit had, as the refusal and the record carry them
 * (docs/reference/specs/pr-description.md item 5): the path and the schema's
 * message for each, and for each cap issue the count to remove and the
 * longest prefix that fits (`fitToCap` under the cap's own count — visible
 * for prose, raw for the title), so the next submit can be a copy. One list,
 * every field: zod reports them all at once and the refusal names them all.
 */
export function describeDescriptionIssues(input: unknown, error: z.ZodError): DescriptionIssue[] {
  return error.issues.map((issue) => {
    const path = issue.path.join(".") || "(root)";
    const cap = capParamsOf(issue);
    const value = cap && stringAt(input, issue.path);
    if (!cap || value === undefined) return { path, message: issue.message };
    const prefix = fitToCap(value, cap.cap, cap.counted === "raw" ? (s) => s.length : visibleLength);
    return {
      path,
      message: issue.message,
      remove: cap.got - cap.cap,
      ...(prefix !== "" ? { prefix } : {}),
    };
  });
}

/** One issue as the refusal states it: the schema's own sentence, and for a
 *  cap the count to remove — visible characters, so a shorter URL is not a cut
 *  — and the prefix that fits, quoted whole for the model to take as is. */
export function describeIssueLine(issue: DescriptionIssue): string {
  if (issue.remove === undefined) return `${issue.path}: ${issue.message}`;
  // The title is the one field counted raw (`cappedRaw`, and the gate's cap):
  // every other cap counts visible characters, and the unit says so.
  const unit = issue.path === "title" ? "characters" : "visible characters";
  const cut = issue.prefix === undefined ? "" : `; a prefix that fits: "${issue.prefix}"`;
  return `${issue.path}: ${issue.message} — remove at least ${issue.remove} ${unit}${cut}`;
}

/** How many objects deep `recordedJson` keeps a value: `RecordedJson`'s
 *  levels, one more than a description needs. */
const RECORDED_JSON_DEPTH = 4;

/** `value` as the record can carry it (`RecordedJson`): what survives a JSON
 *  round trip (an `undefined` field is dropped, as the wire would), objects
 *  nested past the fourth level stored as their JSON text — redact BEFORE
 *  this, so that text is already clean. */
export function recordedJson(value: unknown): RecordedJson {
  const clip = (v: unknown, depth: number): unknown => {
    if (v === null || typeof v === "string" || typeof v === "number" || typeof v === "boolean") return v;
    if (Array.isArray(v)) return v.map((item) => clip(item, depth));
    if (typeof v !== "object") return undefined;
    if (depth === 0) return JSON.stringify(v);
    return Object.fromEntries(
      Object.entries(v)
        .map(([key, item]) => [key, clip(item, depth - 1)] as const)
        .filter(([, item]) => item !== undefined),
    );
  };
  return clip(JSON.parse(JSON.stringify(value ?? null)), RECORDED_JSON_DEPTH) as RecordedJson;
}

/** The `description_refused` note's one line: how many fields are over their
 *  cap and which — the incident's shape — or, when none is, how many issues. */
export function describeRefusalSummary(issues: DescriptionIssue[]): string {
  const over = issues.filter((i) => i.remove !== undefined).map((i) => i.path);
  if (over.length === 0)
    return `description refused: ${issues.length} issue${issues.length === 1 ? "" : "s"} — ${issues.map((i) => i.path).join(", ")}`;
  const others = issues.length - over.length;
  const fields = over.length === 1 ? "1 field over its cap" : `${over.length} fields over their cap`;
  const rest = others === 0 ? "" : `; ${others} other issue${others === 1 ? "" : "s"}`;
  return `description refused: ${fields} — ${over.join(", ")}${rest}`;
}

/** The `pr_description` event's payload: every string LEAF passed through
 *  `redactSecrets` by a generic deep walk — numbers/booleans ride unchanged,
 *  structure preserved — so a field added to the schema (or a secret smuggled
 *  into an anchor path) can never dodge redaction by being missed in a
 *  hand-walk. */
export function redactPrDescription(d: PrDescription): PrDescription {
  return mapStringLeaves(d, redactSecrets) as PrDescription;
}

/** `fn` over every string leaf of a JSON-shaped value; numbers, booleans and
 *  the structure ride unchanged. */
export function mapStringLeaves(value: unknown, fn: (s: string) => string): unknown {
  if (typeof value === "string") return fn(value);
  if (Array.isArray(value)) return value.map((v) => mapStringLeaves(v, fn));
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(Object.entries(value).map(([key, v]) => [key, mapStringLeaves(v, fn)]));
  }
  return value;
}

export interface RenderContext {
  /** `owner/name` of the repository the PR is in. */
  repo: string;
  /** The PR head the anchors are rendered against — the full 40-char sha, so
   *  the link lands on the exact lines whatever the branch does next. */
  headSha: string;
  /** Bot-owned request provenance, independent of GitHub identity binding. */
  requestedBy?: RequestedBy;
}

/** Display identity is provenance, not authority to author Git commits. */
export interface RequestedBy {
  name: string;
  threadUrl?: string;
  steeredBy?: string[];
}

/** Names from channel profiles are text, never Markdown or GitHub mentions. */
function requesterText(text: string): string {
  return text
    .trim()
    .replace(/\s+/g, " ")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/[\\`*_{}[\]()#!|~]/g, "\\$&")
    .replace(/@/g, "&#64;");
}

/** The first visible line, shared by ordinary and recovered pull requests. */
export function requestedByLine(by: RequestedBy): string {
  const steered =
    by.steeredBy !== undefined && by.steeredBy.length > 0
      ? `; steered by ${by.steeredBy.map(requesterText).join(", ")}`
      : "";
  const thread = by.threadUrl ? ` · [Thread](${by.threadUrl})` : "";
  return `Requested by **${requesterText(by.name) || "Unknown requester"}**${thread}${steered}`;
}

const REPO_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const SHA_RE = /^[0-9a-f]{40}$/;

export const GENERATED_FOOTER = "🤖 Generated with [Claude Code](https://claude.com/claude-code)";

/** The map's fixed labels and the collapsed blocks' summaries — the contract
 *  the renderer writes and the parser reads. */
export const MAP_LABELS = {
  why: "**Why:**",
  whereToLook: "**Where to look**",
  feedbackWanted: "**Feedback wanted:**",
  risk: "**Risk:**",
  verified: "**Verified:**",
} as const;
export const FOLD_SUMMARIES = {
  decisions: (n: number) => `Decisions (${n})`,
  validation: (n: number) => `Validation (${n} ${n === 1 ? "criterion" : "criteria"})`,
  agents: "For agents",
} as const;

/** Percent-encode each segment of a GitHub URL path piece (a file path, a
 *  branch name) while keeping `/` as the separator — a space or `#` in a
 *  segment would otherwise break the link or start the fragment early. */
export function encodeGithubPathSegments(path: string): string {
  return path.split("/").map(encodeURIComponent).join("/");
}

/** The permalink a pointer's label links to. Rendered INSIDE link syntax, never
 *  bare on its own line: a bare permalink is what GitHub embeds as a code
 *  block, and the map is links, not code. */
export function anchorUrl(ctx: RenderContext, a: PrAnchor): string {
  return `https://github.com/${ctx.repo}/blob/${ctx.headSha}/${encodeGithubPathSegments(a.path)}#L${a.from}-L${a.to}`;
}

/** Markdown cells: a literal `|` would split the row, a newline would end it,
 *  and a backslash must be escaped first so an input `\|` does not become an
 *  escaped escape. */
function cell(s: string): string {
  return s
    .replace(/\\/g, "\\\\")
    .replace(/\|/g, "\\|")
    .replace(/\s*\n\s*/g, " ");
}

/** A link label: a `]` would end the link early. */
function linkLabel(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/\]/g, "\\]");
}

/** One `<details>` block: the summary, a blank line (GitHub renders markdown
 *  inside only after one), the body, the close. */
function details(summary: string, body: string[]): string[] {
  return ["<details>", `<summary>${summary}</summary>`, "", ...body, "", "</details>", ""];
}

/**
 * The GitHub PR body. Shape and order are the contract (docs/reference/specs/pr-description.md
 * item 3): the tldr first with no heading; `**Why:**`; `**Where to look**`
 * and one numbered row per pointer, `N. [label](permalink) text ⚠ risk`;
 * `**Feedback wanted:**`; `**Risk:**`; `**Verified:**`; then the collapsed
 * blocks — `Decisions (N)` as `- **title.** rationale`, `Validation (N
 * criteria)` as a criterion/proof table, `For agents` — each a `<details>`
 * present only when it has content; the generated-with footer last.
 */
export function renderPrDescriptionMarkdown(desc: PrDescription, ctx: RenderContext): string {
  if (!REPO_RE.test(ctx.repo))
    throw new Error(`renderPrDescriptionMarkdown: repo must be owner/name, got "${ctx.repo}"`);
  if (!SHA_RE.test(ctx.headSha))
    throw new Error(`renderPrDescriptionMarkdown: headSha must be a full 40-char lowercase sha, got "${ctx.headSha}"`);

  const out: string[] = [];
  if (ctx.requestedBy) out.push(requestedByLine(ctx.requestedBy), "");
  out.push(desc.tldr, "");
  out.push(`${MAP_LABELS.why} ${desc.why}`, "");
  out.push(MAP_LABELS.whereToLook, "");
  desc.pointers.forEach((p, i) => {
    const row = `${i + 1}. [${linkLabel(p.label)}](${anchorUrl(ctx, p.anchor)}) ${p.text}`;
    out.push(p.risk ? `${row}${RISK_SEPARATOR}${p.risk}` : row);
  });
  out.push("");
  out.push(`${MAP_LABELS.feedbackWanted} ${desc.feedbackWanted}`, "");
  out.push(`${MAP_LABELS.risk} ${desc.risk}`, "");
  out.push(`${MAP_LABELS.verified} ${desc.verified}`, "");
  if (desc.decisions.length > 0) {
    out.push(
      ...details(
        FOLD_SUMMARIES.decisions(desc.decisions.length),
        desc.decisions.map((d) => `- **${d.title.replace(/\.?$/, ".")}** ${d.rationale}`),
      ),
    );
  }
  out.push(
    ...details(FOLD_SUMMARIES.validation(desc.validation.criteria.length), [
      "| Criterion | Proof |",
      "|---|---|",
      ...desc.validation.criteria.map((c) => `| ${cell(c.criterion)} | ${cell(c.proof)} |`),
    ]),
  );
  const agentLines = desc.agentNotes ? [desc.agentNotes] : [];
  if (agentLines.length > 0) out.push(...details(FOLD_SUMMARIES.agents, agentLines));
  out.push(GENERATED_FOOTER, "");
  return out.join("\n");
}

// ---- The inverse: a rendered body back into the object ------------------------
//
// What a review run gets when the PR was described by a person or by the
// renderer above (docs/reference/specs/pr-description.md item 6): the body GitHub holds,
// read back by the same contract the renderer writes — the tldr as the text
// before the first label, the map by its bold labels, pointers by their
// numbered link rows (the permalink's sha rides on the anchor so a reader can
// tell whether it is at the head being reviewed), the collapsed blocks by
// their `<summary>` lines. A body in the PREVIOUS contract (`## TL;DR`, `##
// Tour` with `### N.` steps over bare permalinks, `## Decisions`, `## Risks &
// implications`, `## Validation`) is read by that grammar with `legacy Tour
// shape` as a problem, so every PR already on GitHub still reaches the
// artifact. Strict where the renderer is strict (a pointer is a pointer only
// with a well-formed permalink whose anchor the schema accepts), lenient where
// a person would be (a short sha, a missing label, a plain first paragraph),
// and never a throw: a body without either shape parses to the first paragraph
// as tldr and no pointers, with `problems` saying what was missing. `complete`
// is `problems.length === 0`. Lossy by construction: the PR title is not in
// the body; a decision title that ended in a period loses it (the renderer's
// normalization); a newline inside a validation cell was flattened to a space.

export interface ParsedPrDescription {
  /** Every field the body carried; `pointers` always present (possibly empty). */
  description: Partial<PrDescription> & { pointers: RenderedPointer[] };
  /** Nothing was missing or malformed — equivalent to `problems.length === 0`. */
  complete: boolean;
  /** Human-readable, one per missing field or dropped pointer. */
  problems: string[];
}

/** The permalink shape. A 7–40-hex sha is accepted on the way in — a person
 *  may write a short one — where the renderer insists on 40. */
const PERMALINK_SRC =
  "https://github\\.com/[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+/blob/([0-9a-f]{7,40})/([^#\\s)]+)#L(\\d+)(?:-L(\\d+))?";
const PERMALINK_RE = new RegExp(`^${PERMALINK_SRC}$`);
/** `N. [label](permalink) text ⚠ risk` — the renderer's pointer row. */
const POINTER_ROW_RE = new RegExp(`^(\\d+)\\.\\s+\\[((?:\\\\.|[^\\]])+)\\]\\(${PERMALINK_SRC}\\)\\s*(.*)$`);
const HEADING_RE = /^(#{1,6})\s+(.+?)\s*$/;
const LABEL_RE = /^\*\*([^*]+?):?\*\*\s*(.*)$/;
const SUMMARY_RE = /^<summary>(.+?)<\/summary>$/;
const DECISION_RE = /^-\s+\*\*(.+?)\*\*\s*(.*)$/;
const TABLE_HEADER_RE = /^\|\s*criterion\s*\|\s*proof\s*\|$/i;
const TABLE_RULE_RE = /^\|?\s*:?-{3,}:?\s*\|/;
// The previous contract.
const STEP_RE = /^###\s+(?:(\d+)\.\s+)?(.+?)\s*$/;
const LOOK_FOR_RE = /^\*\*Look for:\*\*\s*(.*)$/;

type MapKey = "why" | "feedbackWanted" | "risk" | "verified";
const LABEL_KEYS: ReadonlyArray<readonly [MapKey, string]> = [
  ["why", "Why"],
  ["feedbackWanted", "Feedback wanted"],
  ["risk", "Risk"],
  ["verified", "Verified"],
];
const WHERE_TO_LOOK = "Where to look";

export function parsePrDescriptionMarkdown(body: string): ParsedPrDescription {
  const problems: string[] = [];
  const lines = body
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .filter((l) => l.trim() !== GENERATED_FOOTER);
  // Attribution is render context, not a model-authored TL;DR. Only consume
  // our leading line; the same words elsewhere remain part of the description.
  if (/^Requested by \*\*(?:\\.|[^*\\])+\*\*(?: · \[Thread\]\([^\s)]+\))?(?:; steered by .*)?$/.test(lines[0] ?? ""))
    lines.shift();
  const fenced = fenceMask(lines);
  const description: ParsedPrDescription["description"] = { pointers: [] };

  if (lines.some((l, i) => !fenced[i] && /^##\s+Tour\s*$/i.test(l))) {
    parseLegacyBody(lines, fenced, description, problems);
    problems.push("legacy Tour shape");
    return { description, complete: false, problems };
  }

  // The map: the tldr is everything before the first bold label; each label
  // owns the lines up to the next label, the pointer list or the first fold.
  const fields = new Map<MapKey | "tldr" | "pointers" | "discard", string[]>();
  let current: MapKey | "tldr" | "pointers" | "discard" = "tldr";
  fields.set("tldr", []);
  fields.set("discard", []);
  const foldLines: string[] = [];
  let foldStart = -1;
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const l = raw.trim();
    if (!fenced[i] && l === "<details>") {
      foldStart = i;
      break;
    }
    if (!fenced[i]) {
      const m = LABEL_RE.exec(l);
      if (m) {
        const name = m[1].trim().toLowerCase();
        if (name === WHERE_TO_LOOK.toLowerCase()) {
          current = "pointers";
          fields.set(current, []);
          continue;
        }
        const key = LABEL_KEYS.find(([, label]) => label.toLowerCase() === name)?.[0];
        if (key) {
          if (fields.has(key)) {
            // A second label's lines are dropped, not appended to whatever came before.
            problems.push(`duplicate \`**${LABEL_KEYS.find(([k]) => k === key)![1]}:**\` — the first one stands`);
            current = "discard";
            continue;
          } else {
            current = key;
            fields.set(key, [m[2]]);
            continue;
          }
        }
      }
    }
    fields.get(current)!.push(raw);
  }
  if (foldStart >= 0) foldLines.push(...lines.slice(foldStart));

  const tldr = paragraphs(fields.get("tldr")!);
  if (tldr) description.tldr = tldr;
  else problems.push("no tldr — the body has no text before its first label");
  for (const [key, label] of LABEL_KEYS) {
    const got = fields.get(key);
    if (!got) {
      problems.push(`no \`**${label}:**\` line`);
      continue;
    }
    const text = got.join("\n").trim();
    if (text === "") problems.push(`\`**${label}:**\` is empty`);
    else description[key] = text;
  }
  const rows = fields.get("pointers");
  if (!rows) problems.push(`no \`**${WHERE_TO_LOOK}**\` list`);
  else {
    description.pointers = parsePointerRows(rows, problems);
    if (description.pointers.length === 0) problems.push("Where to look has no pointers");
  }

  const folds = splitFolds(foldLines, fenced.slice(Math.max(foldStart, 0)), problems);
  const decisions = folds.get("decisions");
  description.decisions = decisions ? parseDecisions(decisions, problems) : [];
  const validation = folds.get("validation");
  if (validation) description.validation = parseValidation(validation, problems);
  else problems.push("no `Validation` fold");
  const agents = folds.get("agents");
  if (agents) {
    const notes = agents.join("\n").trim();
    if (notes) description.agentNotes = notes;
  }
  return { description, complete: problems.length === 0, problems };
}

/** Which lines sit inside a ``` / ~~~ fence — a `## ` or a `**Why:**` there is
 *  code, not structure. */
function fenceMask(lines: string[]): boolean[] {
  let open: string | undefined;
  return lines.map((l) => {
    const m = /^\s*(`{3,}|~{3,})/.exec(l);
    if (m && (open === undefined || m[1][0] === open[0])) {
      const wasOpen = open !== undefined;
      open = wasOpen ? undefined : m[1];
      return true;
    }
    return open !== undefined;
  });
}

/** The lines' text with headings outside fences dropped, blank runs squeezed. */
function paragraphs(lines: string[]): string | undefined {
  const kept = lines.filter((l) => !HEADING_RE.test(l));
  const text = kept
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return text === "" ? undefined : text;
}

function parsePointerRows(rows: string[], problems: string[]): RenderedPointer[] {
  const out: RenderedPointer[] = [];
  for (const raw of rows) {
    const l = raw.trim();
    if (l === "") continue;
    const m = POINTER_ROW_RE.exec(l);
    if (!m) {
      if (/^\d+\.\s/.test(l)) problems.push(`pointer row without a github permalink — dropped: \`${l.slice(0, 60)}\``);
      else problems.push(`Where to look: unrecognized line \`${l.slice(0, 60)}\``);
      continue;
    }
    const [, n, rawLabel, sha, rawPath, from, to, rest] = m;
    const where = `pointer ${n}`;
    let path: string;
    try {
      path = rawPath.split("/").map(decodeURIComponent).join("/");
    } catch {
      problems.push(`${where}: permalink path is not valid percent-encoding — dropped`);
      continue;
    }
    const anchor = PrAnchorSchema.safeParse({
      path,
      from: Number(from),
      to: to === undefined ? Number(from) : Number(to),
    });
    if (!anchor.success) {
      const issue = anchor.error.issues[0];
      problems.push(`${where}: ${["anchor", ...issue.path].join(".")} ${issue.message} — dropped`);
      continue;
    }
    const [text, ...riskParts] = rest.split(RISK_SEPARATOR);
    const risk = riskParts.join(RISK_SEPARATOR).trim();
    out.push({
      label: rawLabel.replace(/\\(.)/g, "$1"),
      text: text.trim(),
      ...(risk ? { risk } : {}),
      anchor: { ...anchor.data, sha },
    });
  }
  return out;
}

type FoldKey = "decisions" | "validation" | "agents";

/** The `<details>` blocks by their summaries; a block this contract does not
 *  know is skipped. */
function splitFolds(lines: string[], fenced: boolean[], problems: string[]): Map<FoldKey, string[]> {
  const out = new Map<FoldKey, string[]>();
  let current: FoldKey | undefined;
  let inDetails = false;
  lines.forEach((raw, i) => {
    const l = raw.trim();
    if (fenced[i]) {
      if (current) out.get(current)!.push(raw);
      return;
    }
    if (l === "<details>") {
      inDetails = true;
      current = undefined;
      return;
    }
    if (l === "</details>") {
      inDetails = false;
      current = undefined;
      return;
    }
    const s = inDetails ? SUMMARY_RE.exec(l) : null;
    if (s) {
      const summary = s[1].trim();
      const key: FoldKey | undefined = /^decisions\b/i.test(summary)
        ? "decisions"
        : /^validation\b/i.test(summary)
          ? "validation"
          : /^for agents$/i.test(summary)
            ? "agents"
            : undefined;
      if (key === undefined) current = undefined;
      else if (out.has(key)) {
        problems.push(`duplicate \`${summary}\` fold — the first one stands`);
        current = undefined;
      } else {
        current = key;
        out.set(key, []);
      }
      return;
    }
    if (current) out.get(current)!.push(raw);
  });
  return out;
}

function parseDecisions(lines: string[], problems: string[]): { title: string; rationale: string }[] {
  const out: { title: string; rationale: string }[] = [];
  for (const raw of lines) {
    const line = raw.trim();
    if (line === "") continue;
    const m = DECISION_RE.exec(line);
    // One trailing period is the renderer's (`- **Title.** …`), never the title's.
    if (m) out.push({ title: m[1].replace(/\.$/, ""), rationale: m[2].trim() });
    else if (!line.startsWith("-") && out.length) out[out.length - 1].rationale += `\n${line}`;
    else problems.push(`Decisions: unrecognized line \`${line}\``);
  }
  return out;
}

function parseValidation(lines: string[], problems: string[]): PrDescription["validation"] {
  const criteria: { criterion: string; proof: string }[] = [];
  let header = false;
  for (const raw of lines) {
    const line = raw.trim();
    if (line === "") continue;
    if (!header) {
      if (TABLE_HEADER_RE.test(line)) header = true;
      else problems.push(`Validation: text before the table is ignored: \`${line.slice(0, 60)}\``);
      continue;
    }
    if (TABLE_RULE_RE.test(line)) continue;
    const cells = splitCells(line);
    if (cells.length >= 2) criteria.push({ criterion: cells[0], proof: cells[1] });
    else problems.push(`Validation: unrecognized table line \`${line}\``);
  }
  if (!header) problems.push("Validation: no `| Criterion | Proof |` table");
  return { criteria };
}

/** A table row's cells, undoing `cell()`: an escaped `\|` is a pipe, `\\` a
 *  backslash; the leading and trailing pipes frame the row. */
function splitCells(row: string): string[] {
  const cells: string[] = [];
  let cur = "";
  const inner = row.replace(/^\|/, "").replace(/\|$/, "");
  for (let i = 0; i < inner.length; i++) {
    const ch = inner[i];
    if (ch === "\\" && i + 1 < inner.length) {
      cur += inner[++i];
    } else if (ch === "|") {
      cells.push(cur.trim());
      cur = "";
    } else cur += ch;
  }
  cells.push(cur.trim());
  return cells;
}

// ---- The previous contract ----------------------------------------------------
//
// `## TL;DR` · `## What & why` · `## Tour` (`### N. title`, prose, optional
// `**Look for:**`, a bare permalink line; a final `### N. Remaining changes`
// list) · `## Decisions` · `## Risks & implications` · `## Validation`
// (optional summary + the criterion/proof table). Read into the current
// shape: What & why → why, each step → a pointer (title → label, description →
// text; a Look for is appended to the text), Risks → risk. Remaining changes
// and the validation summary have no home and are dropped.

type LegacyKey = "tldr" | "whatWhy" | "tour" | "decisions" | "risks" | "validation";
const LEGACY_SECTIONS: ReadonlyArray<readonly [LegacyKey, string]> = [
  ["tldr", "TL;DR"],
  ["whatWhy", "What & why"],
  ["tour", "Tour"],
  ["decisions", "Decisions"],
  ["risks", "Risks & implications"],
  ["validation", "Validation"],
];

function parseLegacyBody(
  lines: string[],
  fenced: boolean[],
  description: ParsedPrDescription["description"],
  problems: string[],
): void {
  const byHeading = new Map(LEGACY_SECTIONS.map(([key, heading]) => [heading.toLowerCase(), key] as const));
  const sections = new Map<LegacyKey, string[]>();
  let current: string[] | undefined;
  const preamble: string[] = [];
  let seenHeading = false;
  lines.forEach((l, i) => {
    const m = fenced[i] ? null : HEADING_RE.exec(l);
    if (m && m[1] === "##") {
      seenHeading = true;
      const key = byHeading.get(m[2].replace(/\s+/g, " ").toLowerCase());
      if (key === undefined || sections.has(key)) current = undefined;
      else {
        current = [];
        sections.set(key, current);
      }
      return;
    }
    if (current) current.push(l);
    else if (!seenHeading) preamble.push(l);
  });
  const tldr = paragraphs(sections.get("tldr") ?? preamble);
  if (tldr) description.tldr = tldr;
  const why = sections.get("whatWhy")?.join("\n").trim();
  if (why) description.why = why;
  const risk = sections.get("risks")?.join("\n").trim();
  if (risk) description.risk = risk;
  const tour = sections.get("tour");
  if (tour) description.pointers = parseLegacySteps(tour, problems);
  const decisions = sections.get("decisions");
  description.decisions = decisions ? parseDecisions(decisions, problems) : [];
  const validation = sections.get("validation");
  if (validation) {
    // The legacy table sat under an optional summary line; skip to the header.
    const start = validation.findIndex((l) => TABLE_HEADER_RE.test(l.trim()));
    description.validation = parseValidation(start >= 0 ? validation.slice(start) : validation, problems);
  }
}

function parseLegacySteps(lines: string[], problems: string[]): RenderedPointer[] {
  const steps: Array<{ label: string; title: string; lines: string[] }> = [];
  for (const line of lines) {
    const m = STEP_RE.exec(line);
    if (m) steps.push({ label: m[1] ?? String(steps.length + 1), title: m[2], lines: [] });
    else if (steps.length) steps[steps.length - 1].lines.push(line);
  }
  const out: RenderedPointer[] = [];
  for (const step of steps) {
    if (/^remaining changes$/i.test(step.title)) continue;
    const where = `step ${step.label} (${step.title})`;
    let link: RegExpExecArray | undefined;
    const text: string[] = [];
    const lookFor: string[] = [];
    let inLookFor = false;
    for (const raw of step.lines) {
      const l = raw.trim();
      const m = PERMALINK_RE.exec(l);
      if (m) {
        if (link) problems.push(`${where}: more than one permalink — the first is the anchor`);
        else link = m;
        inLookFor = false;
        continue;
      }
      const lf = LOOK_FOR_RE.exec(l);
      if (lf) {
        lookFor.push(lf[1]);
        inLookFor = true;
        continue;
      }
      if (inLookFor) {
        if (l === "") inLookFor = false;
        else lookFor.push(l);
        continue;
      }
      text.push(raw);
    }
    if (!link) {
      problems.push(`${where}: no permalink line — dropped`);
      continue;
    }
    let path: string;
    try {
      path = link[2].split("/").map(decodeURIComponent).join("/");
    } catch {
      problems.push(`${where}: permalink path is not valid percent-encoding — dropped`);
      continue;
    }
    const from = Number(link[3]);
    const anchor = PrAnchorSchema.safeParse({ path, from, to: link[4] === undefined ? from : Number(link[4]) });
    if (!anchor.success) {
      const issue = anchor.error.issues[0];
      problems.push(`${where}: ${["anchor", ...issue.path].join(".")} ${issue.message} — dropped`);
      continue;
    }
    const body = text
      .join("\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
    const look = lookFor.join(" ").trim();
    out.push({
      label: step.title,
      text: [body, look ? `Look for: ${look}` : ""]
        .filter(Boolean)
        .join(" ")
        .replace(/\s*\n\s*/g, " "),
      anchor: { ...anchor.data, sha: link[1] },
    });
  }
  return out;
}
