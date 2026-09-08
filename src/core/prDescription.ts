import { z } from "zod";
import { redactSecrets } from "./redact.js";

// The PR description as DATA (docs/reference/specs/pr-description.md). One typed object
// carries everything a reader needs about a change — the PR title, TL;DR,
// what & why, the Tour (hunk-anchored walkthrough), decisions, risks,
// validation criteria with their proofs — and each surface has its own
// renderer over that object:
// `renderPrDescriptionMarkdown` for the GitHub body today, the run page's
// review panel next, whatever replaces GitHub after that. Nothing about the
// content is authored per surface, so there is never a second copy to keep in
// sync; and because Tour anchors are stored as (path, from, to) and rendered
// against the head sha at render time, regenerating the body after a repush is
// a re-render, not a rewrite.

// `line` is single-line by contract: a title or path with an embedded newline
// would split the renderer's `### N.` headings — and the PR title goes
// verbatim into POST /pulls. `prose` may span lines.
const line = z
  .string()
  .trim()
  .min(1)
  .refine((s) => !/[\r\n]/.test(s), "must be a single line (no embedded newlines)");
const prose = z.string().trim().min(1);

/** A hunk the reader is pointed at: a path + inclusive 1-based line range in
 *  the PR head. The sha is NOT stored here — it is supplied at render time. */
export const TourAnchorSchema = z
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

/** One Tour step, reader-first: heading (what the change is), the explanation,
 *  an optional "look for" pointer, then the code. */
export const TourStepSchema = z.object({
  title: line,
  description: prose,
  lookFor: prose.optional(),
  anchor: TourAnchorSchema,
});

export const PrDescriptionSchema = z.object({
  /** The PR title's single source. Metadata for the PR's own title field —
   *  never rendered into the body (GitHub shows the title itself). */
  title: line,
  tldr: prose,
  whatWhy: prose,
  tour: z.array(TourStepSchema).min(1),
  /** Every touched file the Tour steps did not cover, one line each. */
  remaining: z.array(z.object({ path: line, note: prose })),
  decisions: z.array(z.object({ title: line, rationale: prose })).min(1),
  risks: prose,
  validation: z.object({
    summary: prose.optional(),
    criteria: z.array(z.object({ criterion: prose, proof: prose })).min(1),
  }),
});

// The shape lives zod-free in prDescriptionTypes.ts (the run-event contract
// needs it without this module's zod dependency); re-exported here so schema
// consumers keep one import. The annotated return below is what pins the zod
// output to that shape — drift either way is a compile error.
import type { TourAnchor, PrDescription, RenderedTourStep } from "./prDescriptionTypes.js";
export type {
  TourAnchor,
  TourStep,
  PrDescription,
  RenderedTourAnchor,
  RenderedTourStep,
} from "./prDescriptionTypes.js";

/** Validate untrusted input (a tool call, a JSON file) into a PrDescription.
 *  Throws a zod error naming the offending path — callers surface it. */
export function parsePrDescription(input: unknown): PrDescription {
  return PrDescriptionSchema.parse(input);
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
   *  GitHub embeds each permalink as code (a branch name renders as a link). */
  headSha: string;
}

const REPO_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const SHA_RE = /^[0-9a-f]{40}$/;

export const GENERATED_FOOTER = "🤖 Generated with [Claude Code](https://claude.com/claude-code)";

/** Percent-encode each segment of a GitHub URL path piece (a file path, a
 *  branch name) while keeping `/` as the separator — a space or `#` in a
 *  segment would otherwise break the link or start the fragment early. */
export function encodeGithubPathSegments(path: string): string {
  return path.split("/").map(encodeURIComponent).join("/");
}

/** The permalink GitHub renders as an embedded code block inside a PR body. */
export function anchorUrl(ctx: RenderContext, a: TourAnchor): string {
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

/**
 * The GitHub PR body. Section order and shape are the contract the coding
 * agent's template describes in prose (docs/reference/specs/agent-coding.md item 3):
 * every section a `##` heading, TL;DR first; Tour steps as `### N. title` →
 * description → optional **Look for:** → permalink last; a final
 * `### N. Remaining changes` list; decisions as `- **title.** rationale`;
 * validation as an optional summary line + a criterion/proof table; the
 * generated-with footer.
 */
export function renderPrDescriptionMarkdown(desc: PrDescription, ctx: RenderContext): string {
  if (!REPO_RE.test(ctx.repo))
    throw new Error(`renderPrDescriptionMarkdown: repo must be owner/name, got "${ctx.repo}"`);
  if (!SHA_RE.test(ctx.headSha))
    throw new Error(`renderPrDescriptionMarkdown: headSha must be a full 40-char lowercase sha, got "${ctx.headSha}"`);

  const out: string[] = [];
  out.push("## TL;DR", "", desc.tldr, "");
  out.push("## What & why", "", desc.whatWhy, "");
  out.push("## Tour", "");
  desc.tour.forEach((step, i) => {
    out.push(`### ${i + 1}. ${step.title}`, "", step.description, "");
    if (step.lookFor) out.push(`**Look for:** ${step.lookFor}`, "");
    out.push(anchorUrl(ctx, step.anchor), "");
  });
  out.push(`### ${desc.tour.length + 1}. Remaining changes`, "");
  if (desc.remaining.length === 0) out.push("- none — every touched file is covered by a step above", "");
  else {
    for (const r of desc.remaining) out.push(`- \`${r.path}\` — ${r.note}`);
    out.push("");
  }
  out.push("## Decisions", "");
  for (const d of desc.decisions) out.push(`- **${d.title.replace(/\.?$/, ".")}** ${d.rationale}`);
  out.push("");
  out.push("## Risks & implications", "", desc.risks, "");
  out.push("## Validation", "");
  if (desc.validation.summary) out.push(desc.validation.summary, "");
  out.push("| Criterion | Proof |", "|---|---|");
  for (const c of desc.validation.criteria) out.push(`| ${cell(c.criterion)} | ${cell(c.proof)} |`);
  out.push("", GENERATED_FOOTER, "");
  return out.join("\n");
}

// ---- The inverse: a rendered body back into the object ------------------------
//
// What a review run gets when the PR was described by a human or by the
// renderer above (docs/reference/specs/pr-description.md item 6): the body GitHub holds,
// read back by the same contract the renderer writes — sections by their fixed
// `##` headings, Tour steps by `### N. title` + prose + optional
// `**Look for:**` + the bare permalink line, the `Remaining changes` catch-all
// by its `- \`path\` — note` lines. Strict where the renderer is strict (a step
// is a step only with a well-formed permalink whose anchor the schema accepts;
// the permalink's sha rides on the anchor so a reader can tell whether it is
// at the head being reviewed), lenient where a human would be (a short sha, a
// missing section, a TL;DR paragraph without its heading), and never a throw:
// a body without the shape parses to the first paragraph as tldr and an empty
// tour, with `problems` saying what was missing. `complete` is `problems.length
// === 0`. Lossy by construction: the PR title is not in the body; a decision
// title that ended in a period loses it (the renderer's normalization); a
// newline inside a validation cell was flattened to a space when rendered.

export interface ParsedPrDescription {
  /** Every section the body carried; `tour` always present (possibly empty). */
  description: Partial<PrDescription> & { tour: RenderedTourStep[] };
  /** Nothing was missing or malformed — equivalent to `problems.length === 0`. */
  complete: boolean;
  /** Human-readable, one per missing section or dropped step. */
  problems: string[];
}

/** The six `##` sections in contract order, keyed by the field they fill. */
const SECTIONS: ReadonlyArray<readonly [keyof PrDescription, string]> = [
  ["tldr", "TL;DR"],
  ["whatWhy", "What & why"],
  ["tour", "Tour"],
  ["decisions", "Decisions"],
  ["risks", "Risks & implications"],
  ["validation", "Validation"],
];

/** The bare permalink line the renderer emits (`anchorUrl`). A 7–40-hex sha is
 *  accepted on the way in — GitHub embeds an unambiguous short sha too, and a
 *  human may write one — where the renderer insists on 40. */
const PERMALINK_RE =
  /^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/blob\/([0-9a-f]{7,40})\/([^#\s]+)#L(\d+)(?:-L(\d+))?$/;
const HEADING_RE = /^(#{1,6})\s+(.+?)\s*$/;
const STEP_RE = /^###\s+(?:(\d+)\.\s+)?(.+?)\s*$/;
const LOOK_FOR_RE = /^\*\*Look for:\*\*\s*(.*)$/;
const REMAINING_LINE_RE = /^-\s+`([^`]+)`\s+—\s*(.*)$/;
const REMAINING_NONE_RE = /^-\s+none\b/i;
const DECISION_RE = /^-\s+\*\*(.+?)\*\*\s*(.*)$/;
const TABLE_HEADER_RE = /^\|\s*criterion\s*\|\s*proof\s*\|$/i;
const TABLE_RULE_RE = /^\|?\s*:?-{3,}:?\s*\|/;

export function parsePrDescriptionMarkdown(body: string): ParsedPrDescription {
  const problems: string[] = [];
  const lines = body
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .filter((l) => l.trim() !== GENERATED_FOOTER);
  const fenced = fenceMask(lines);
  const sections = splitSections(lines, fenced, problems);
  const description: ParsedPrDescription["description"] = { tour: [] };

  const tldr = sections.get("tldr");
  if (tldr) setProse(description, "tldr", tldr, problems);
  else {
    problems.push("no `## TL;DR` section — the tldr is the body's first paragraph");
    const first = firstParagraph(lines, fenced);
    if (first) description.tldr = first;
  }
  const whatWhy = sections.get("whatWhy");
  if (whatWhy) setProse(description, "whatWhy", whatWhy, problems);
  const tour = sections.get("tour");
  if (tour) {
    const parsed = parseTour(tour.lines, fenced.slice(tour.start, tour.start + tour.lines.length), problems);
    description.tour = parsed.tour;
    if (parsed.remaining) description.remaining = parsed.remaining;
  }
  const decisions = sections.get("decisions");
  if (decisions) description.decisions = parseDecisions(decisions.lines, problems);
  const risks = sections.get("risks");
  if (risks) setProse(description, "risks", risks, problems);
  const validation = sections.get("validation");
  if (validation) description.validation = parseValidation(validation.lines, problems);

  for (const [key, heading] of SECTIONS) {
    if (key === "tldr" || sections.has(key)) continue;
    problems.push(`no \`## ${heading}\` section`);
  }
  return { description, complete: problems.length === 0, problems };
}

interface Section {
  /** Index of the first content line in the body's line array. */
  start: number;
  lines: string[];
}

/** Which lines sit inside a ``` / ~~~ fence — a `## ` there is code, not a heading. */
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

function splitSections(lines: string[], fenced: boolean[], problems: string[]): Map<keyof PrDescription, Section> {
  const byHeading = new Map(SECTIONS.map(([key, heading]) => [heading.toLowerCase(), key] as const));
  const out = new Map<keyof PrDescription, Section>();
  let current: Section | undefined;
  lines.forEach((line, i) => {
    const m = fenced[i] ? null : HEADING_RE.exec(line);
    if (m && m[1] === "##") {
      const key = byHeading.get(m[2].replace(/\s+/g, " ").toLowerCase());
      if (key === undefined)
        current = undefined; // a section this contract does not know: skipped
      else if (out.has(key)) {
        problems.push(`duplicate \`## ${SECTIONS.find(([k]) => k === key)![1]}\` section — the first one stands`);
        current = undefined;
      } else {
        current = { start: i + 1, lines: [] };
        out.set(key, current);
      }
      return;
    }
    current?.lines.push(line);
  });
  return out;
}

/** The first paragraph that is not a heading and not inside a fence. */
function firstParagraph(lines: string[], fenced: boolean[]): string | undefined {
  const para: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (l.trim() === "") {
      if (para.length) break;
      continue;
    }
    if (fenced[i] || (para.length === 0 && HEADING_RE.test(l))) continue;
    para.push(l.trim());
  }
  return para.length ? para.join("\n") : undefined;
}

function setProse(
  description: ParsedPrDescription["description"],
  key: "tldr" | "whatWhy" | "risks",
  section: Section,
  problems: string[],
): void {
  const text = section.lines.join("\n").trim();
  if (text === "") problems.push(`\`## ${SECTIONS.find(([k]) => k === key)![1]}\` section is empty`);
  else description[key] = text;
}

function parseTour(
  lines: string[],
  fenced: boolean[],
  problems: string[],
): { tour: RenderedTourStep[]; remaining?: { path: string; note: string }[] } {
  const steps: Array<{ label: string; title: string; lines: string[] }> = [];
  let preamble = "";
  lines.forEach((line, i) => {
    const m = fenced[i] ? null : STEP_RE.exec(line);
    if (m) steps.push({ label: m[1] ?? String(steps.length + 1), title: m[2], lines: [] });
    else if (steps.length) steps[steps.length - 1].lines.push(line);
    else preamble += line;
  });
  if (preamble.trim() !== "") problems.push("Tour: text before the first `### N.` step is ignored");
  const isRemaining = (title: string) => /^remaining changes$/i.test(title);
  const tour: RenderedTourStep[] = [];
  let remaining: { path: string; note: string }[] | undefined;
  for (const step of steps) {
    if (isRemaining(step.title)) {
      remaining = parseRemaining(step.lines, problems);
      continue;
    }
    const parsed = parseStep(step, problems);
    if (parsed) tour.push(parsed);
  }
  if (!steps.some((s) => !isRemaining(s.title))) problems.push("Tour has no steps");
  if (remaining === undefined) problems.push("Tour has no `Remaining changes` step");
  return { tour, ...(remaining ? { remaining } : {}) };
}

function parseStep(
  step: { label: string; title: string; lines: string[] },
  problems: string[],
): RenderedTourStep | undefined {
  const where = `step ${step.label} (${step.title})`;
  let link: RegExpExecArray | undefined;
  const descLines: string[] = [];
  const lookForLines: string[] = [];
  let inLookFor = false;
  for (const line of step.lines) {
    const m = PERMALINK_RE.exec(line.trim());
    if (m) {
      if (link) problems.push(`${where}: more than one permalink — the first is the anchor`);
      else link = m;
      inLookFor = false;
      continue;
    }
    const lf = LOOK_FOR_RE.exec(line.trim());
    if (lf) {
      lookForLines.push(lf[1]);
      inLookFor = true;
      continue;
    }
    if (inLookFor) {
      if (line.trim() === "") inLookFor = false;
      else lookForLines.push(line.trim());
      continue;
    }
    descLines.push(line);
  }
  if (!link) {
    problems.push(`${where}: no permalink line — dropped`);
    return undefined;
  }
  let path: string;
  try {
    path = link[2].split("/").map(decodeURIComponent).join("/");
  } catch {
    problems.push(`${where}: permalink path is not valid percent-encoding — dropped`);
    return undefined;
  }
  const from = Number(link[3]);
  const anchor = TourAnchorSchema.safeParse({ path, from, to: link[4] === undefined ? from : Number(link[4]) });
  if (!anchor.success) {
    const issue = anchor.error.issues[0];
    problems.push(`${where}: ${["anchor", ...issue.path].join(".")} ${issue.message} — dropped`);
    return undefined;
  }
  const lookFor = lookForLines.join("\n").trim();
  return {
    title: step.title,
    // A parsed step may carry an empty description (a human's heading +
    // permalink): this is a read-back, not a submission the schema gates.
    description: descLines
      .join("\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim(),
    ...(lookFor ? { lookFor } : {}),
    anchor: { ...anchor.data, sha: link[1] },
  };
}

function parseRemaining(lines: string[], problems: string[]): { path: string; note: string }[] {
  const out: { path: string; note: string }[] = [];
  for (const raw of lines) {
    const line = raw.trim();
    if (line === "" || REMAINING_NONE_RE.test(line)) continue;
    const m = REMAINING_LINE_RE.exec(line);
    if (m) out.push({ path: m[1], note: m[2].trim() });
    else if (!line.startsWith("-") && out.length) out[out.length - 1].note += `\n${line}`;
    else problems.push(`Remaining changes: unrecognized line \`${line}\``);
  }
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
  const summary: string[] = [];
  const criteria: { criterion: string; proof: string }[] = [];
  let header = false;
  for (const raw of lines) {
    const line = raw.trim();
    if (!header) {
      if (TABLE_HEADER_RE.test(line)) header = true;
      else summary.push(raw);
      continue;
    }
    if (line === "" || TABLE_RULE_RE.test(line)) continue;
    const cells = splitCells(line);
    if (cells.length >= 2) criteria.push({ criterion: cells[0], proof: cells[1] });
    else problems.push(`Validation: unrecognized table line \`${line}\``);
  }
  if (!header) problems.push("Validation: no `| Criterion | Proof |` table");
  const text = summary.join("\n").trim();
  return { ...(text ? { summary: text } : {}), criteria };
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
