import { z } from "zod";

// The PR description as DATA (features/pr-description.md). One typed object
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
import type { TourAnchor, PrDescription } from "./prDescriptionTypes.js";
export type { TourAnchor, TourStep, PrDescription } from "./prDescriptionTypes.js";

/** Validate untrusted input (a tool call, a JSON file) into a PrDescription.
 *  Throws a zod error naming the offending path — callers surface it. */
export function parsePrDescription(input: unknown): PrDescription {
  return PrDescriptionSchema.parse(input);
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
 * agent's template describes in prose (features/agent-coding.md item 3):
 * every section a `##` heading, TL;DR first; Tour steps as `### N. title` →
 * description → optional **Look for:** → permalink last; a final
 * `### N. Remaining changes` list; decisions as `- **title.** rationale`;
 * validation as an optional summary line + a criterion/proof table; the
 * generated-with footer.
 */
export function renderPrDescriptionMarkdown(desc: PrDescription, ctx: RenderContext): string {
  if (!REPO_RE.test(ctx.repo)) throw new Error(`renderPrDescriptionMarkdown: repo must be owner/name, got "${ctx.repo}"`);
  if (!SHA_RE.test(ctx.headSha)) throw new Error(`renderPrDescriptionMarkdown: headSha must be a full 40-char lowercase sha, got "${ctx.headSha}"`);

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
