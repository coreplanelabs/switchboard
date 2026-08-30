# PR description as data

Everything a reader needs about a change — TL;DR, what & why, the hunk-anchored **Tour**, decisions, risks, validation criteria with their proofs — is one typed object, `PrDescription`, and every surface that shows it (the GitHub PR body today; the run page's review panel next; whatever replaces GitHub after that) is a **renderer over that object**. There is never a second copy of the content to keep in sync, and because Tour anchors are stored as `(path, from, to)` and rendered against the PR head at render time, regenerating a body after a repush is a re-render, not a rewrite.

This is the data half of the coding agent's templated PR description ([agent-coding.md](agent-coding.md) item 3 describes the same contract as prose for the prompt). It was motivated by [#325](https://github.com/coreplanelabs/switchboard/pull/325) (a body nobody could consume) and shaped on Ramp Inspect's Tour (`competitive-research/ramp-inspect`), with the step shape reversed to reader-first.

- **Code**: `src/core/prDescription.ts` (`PrDescriptionSchema` / `parsePrDescription`, `renderPrDescriptionMarkdown`, `anchorUrl`); `scripts/render-pr-description.ts`; fixture + golden `src/core/testing/pr329.description.json` / `pr329.body.md`.
- **Tests**: `src/core/prDescription.test.ts`.
- **Receipts**: https://github.com/coreplanelabs/switchboard/issues/222 (the coding agent's receipts issue — the description is its deliverable)

## Behavior

1. **The object.** `PrDescription = { tldr, whatWhy, tour: TourStep[], remaining: {path, note}[], decisions: {title, rationale}[], risks, validation: { summary?, criteria: {criterion, proof}[] } }`. A `TourStep` is `{ title, description, lookFor?, anchor: { path, from, to } }` — the heading naming the change, the explanation, an optional pointer at what to scrutinize, and the hunk. Every text field is non-empty after trimming; `tour`, `decisions` and `criteria` need at least one entry; an anchor's `path` is repo-relative (no leading `/`, no `..`), lines are positive with `to ≥ from`. `parsePrDescription(unknown)` is the one validating entry point (zod; a violation throws naming the path) — the future `submit_pr_description` tool and any JSON file go through it.
2. **The sha is a render-time input.** `renderPrDescriptionMarkdown(desc, { repo, headSha })` refuses anything but `owner/name` and a full 40-char lowercase sha: GitHub embeds a `blob/<sha>/<path>#L<a>-L<b>` link as a code block only for a commit ref — a branch name renders as a bare link. Because the object holds no sha, re-rendering at a new head is the whole repush story.
3. **The GitHub rendering.** Sections in fixed order, each a `##` heading, `## TL;DR` first: TL;DR · What & why · Tour · Decisions · Risks & implications · Validation. Tour steps render as `### N. <title>`, the description, `**Look for:** …` when present, then the permalink **last** (the reader knows what they are looking at before the code appears). A final `### N+1. Remaining changes` lists every uncovered file as `` - `path` — note `` (or one line saying none is left). Decisions render `- **Title.** rationale` (exactly one trailing period on the title). Validation is the optional summary line then a `| Criterion | Proof |` table with `|` escaped and newlines flattened inside cells. The body ends with the generated-with footer.
4. **The golden is a real PR.** `src/core/testing/pr329.description.json` is [#329](https://github.com/coreplanelabs/switchboard/pull/329)'s description as data; `pr329.body.md` is its rendering at #329's head; the suite asserts they are byte-identical, and that file is what `gh pr edit --body-file` put on the PR — the PR body, the golden and the test are one artifact by construction. `scripts/render-pr-description.ts <json> --repo <owner/name> --head <sha>` prints the rendering for the operator path.

## Roadmap (gaps)

- `[gap]` **The coding agent submits the object, the system renders it.** A `submit_pr_description` tool (validated with `parsePrDescription`, like `submit_verdict`) replaces the prompt's markdown template as the agent's output; the dispatcher renders the body at the pushed head, opens/edits the PR, re-renders on every head-moving push, and publishes the object as a run artifact for the run page's review panel.
- `[gap]` **The panel renderer.** The run page renders the same object beside the reading diff (the review-panel work), never a second authoring path.

## Validation criteria

| Criterion | Proof |
|---|---|
| Schema: complete object accepted, lines trimmed; empty tour / decisions / criteria, missing sections and blank strings rejected naming the field | `[unit]` `src/core/prDescription.test.ts::parsePrDescription (the schema)` (2) |
| Anchors: absolute or traversing path, non-positive line, `to < from` rejected | `[unit]` `::rejects a bad anchor…` |
| Every section a `##` heading in contract order, TL;DR first, footer last | `[unit]` `::renders every section as a ## heading…` |
| Step shape: `### N. title` → description → optional Look for → permalink last; numbered from 1; Remaining changes is step N+1 | `[unit]` `::a Tour step is …` |
| Sha is a render input: same object, different head → different anchors; `anchorUrl` shape | `[unit]` `::anchors take the sha from the render context…` |
| Short sha / branch ref / non `owner/name` refused | `[unit]` `::refuses a short sha or a non owner\/name repo…` |
| Remaining changes: per-file lines, or the none line | `[unit]` `::Remaining changes lists each file…` |
| Decisions punctuation; validation summary + table; cell escaping | `[unit]` `::decisions read …` |
| #329's description renders byte-for-byte to the checked-in body, which is the PR's live body | `[unit]` `::golden: PR #329 rendered through the pipeline`. `[agent]` `gh pr view 329 --json body --jq .body` equals `src/core/testing/pr329.body.md` (modulo GitHub's trailing-newline normalization) |
| Agent submits the object; panel renderer | `[gap]` (roadmap) |
