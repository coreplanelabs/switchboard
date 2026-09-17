---
title: The PR body is a fixed-size map for the reader, and everything for agents sits below a fold
status: accepted
date: 2026-09-17
pattern: The human part of a PR description is a capped map (a TL;DR, the why, at most seven linked pointers, the feedback wanted, the risk, one line of verification) whose size is enforced by the schema and does not grow with the diff; pointers are inline links, never embedded code; decisions, proofs and notes for agents render collapsed below the map; anchors stay mechanical and render at the head
---

# The PR body is a fixed-size map for the reader, and everything for agents sits below a fold

**The ask.** Decide (the maintainer, before the code PR is written): replace the Tour with a capped **map** as the PR description contract, across the typed object, its renderer and inverse parser, the tool schemas, the coding prompt, the first-party skill and the specs; rename the skill from `pr-tour` to `pr-description` so it owns the whole body; keep the mechanical anchor rules. Reader: an engineer who knows the coding agent's PR post-step and has not read the PR bodies it produces. Frame assumed from the maintainer's "totally useless for humans, this needs to be rethought from the ground up" and "being able to jump to the code based on some text is useful, but look how long these tours are".

Success criteria: (1) the part of a body a person reads is the same size for a 1-file and an 80-file PR and fits on one screen; (2) a reader can jump from a sentence to the code it describes, at the pushed head, for the main files of the change; (3) nothing in the body is a copy of what the diff already shows; (4) the reviewer agent, the run page and the record keep everything they read today; (5) a body written by a person, or by the previous contract, still parses without a throw.

**Accepted 2026-09-17**, built and live: the contract shipped in one pull request (#1518, release 1.243.0) and every criterion below is bound; the two `[agent]` rows are receipted on that pull request from the first two coding runs under the new shape, where the cap refused a 202-character feedback line once and the map re-rendered at the new head after a follow-up push. The caps stay revisable on the evidence named under What would change our mind; the size stamp stays open.

## TL;DR

The median merged PR body in this repository is 6,800 characters with seven embedded code blocks, and a 1-file, 2-line PR carries 3,600 characters; an 80-file PR in a sibling repository rendered 2,800 words, 20 embedded blocks and a 25-line file catalog, and its author called it useless for humans. The bet is that the human part of the body is a **map** of fixed size, capped by the schema field by field, whose pointers are inline links a reader clicks rather than permalinks GitHub embeds, and that everything agents consume renders collapsed under it. It costs one contract change over the object, the renderer, the inverse parser, two tool schemas, the prompt, the skill and five specs, a golden re-rendered from the code PR itself, and a legacy branch in the parser for the bodies already on GitHub. Decided: the seven fields of the map and their caps, caps on the collapsed half too so the whole body stays under 26,000 characters, inline links over embeds, the fold, the skill rename, anchors unchanged; open: whether the renderer stamps the diff's size on the body. If we do nothing every agent PR keeps growing with its diff, and the literature says that is the shape reviewers skip.

## Today at `65fe74a0f4da`

You would expect the body to be shaped by a template the model follows. It is data: the coding agent submits a typed object and the system renders it, so the shape is enforced by code, and this record changes that code. The design depends on these five facts.

| Fact | Proof |
|---|---|
| The schema requires at least one Tour step and caps nothing: no maximum on steps, no length on any prose field; `remaining` and at least one decision are required. | `src/core/prDescription.ts:56-63` |
| The renderer writes each anchor as a bare permalink on its own line, which GitHub embeds as a code block; the skill instructs the author to keep it bare for that reason and forbids link syntax. | `src/core/prDescription.ts:127-163`; `skills/pr-tour/SKILL.md:34` |
| The inverse parser reads six fixed `##` sections and recognizes a step only by that bare permalink line; the review side and the run page read bodies through it. | `src/core/prDescription.ts:211-223`; `src/core/reviewDescription.ts`; `web/src/lib/prReviewCollector.ts:68` |
| The run page's panel renders the title, the TL;DR and the What & why, and never the Tour; the Tour rides in the `pr_description` artifact as `tour` and `remaining`. | `web/src/lib/prReviewCollector.ts:68`; `src/core/runEvents.ts:29-30` |
| Over the last 40 merged PRs here: median body 6,800 characters, median 7 embedded permalinks, mean 8.5 steps, mean 12.8 files; the smallest PR (1 file, 2 lines) rendered 3,599 characters. | `gh pr list --state merged --limit 40` on this repository, measured while writing this record |

## The shape

The body has two parts. Above the fold, the **map**: the TL;DR, one or two sentences of **why** with the links, one to seven **pointers** in reading order, each a linked label, one sentence and an optional `⚠` risk, then **feedback wanted**, **risk** and **verified**, each one or two sentences. Every field has a character cap in the schema, so the map's worst case is under 3,800 visible characters and its usual case is a few hundred words; an 80-file PR gets the same seven rows as a 3-file PR and the author chooses which files are the main ones. Below the fold, three collapsed blocks: the decisions, the validation criteria with their proofs, and notes for agents. Anchors are what they were: a `(path, from, to)` range at the pushed head, derived mechanically, rendered at render time, so a repush is still a re-render.

This is the change-description convention of a large engineering organization, a paragraph of why and then "start with these files", with one difference: the convention there is held by reviewers, and here by a schema the tool refuses to exceed.

## One trace: an 80-file change

The case most likely to be wrong is the large PR, where the cap forces a choice the author would rather not make.

1. The coding run pushes a branch with 80 files, +4,920 lines, and calls the tool with a TL;DR of two sentences, a why of one, and twelve pointers.
2. The tool answers `pointers: at most 7 (got 12)`; nothing is rendered, the earlier valid submission, if any, stands.
3. The agent, following the skill, keeps the pointers for the main files: the query composer, the adapter, the two fallbacks, the retention skip, the redaction, six in all, and marks three `⚠`.
4. It resubmits; the schema accepts. The post-step observes the pushed head `f6d2d256…` and renders.
5. The body opens with the TL;DR, then `**Why:**` with the stack and record links, then `**Where to look**` as six numbered lines, each `[label](https://github.com/o/r/blob/f6d2d256…/path#L77-L134) sentence ⚠ risk`. GitHub renders them as links, since only a bare URL on its own line embeds.
6. `**Feedback wanted:**` names the two unconfirmed query functions. `**Risk:**` states the new-provider blast radius and, because the diff is over 400 changed lines, its size and the split the author considered. `**Verified:**` is one line: eight suites green, three live checks human-gated.
7. Under it, `<details><summary>Decisions (10)</summary>`, `<details><summary>Validation (20 criteria)</summary>` with the criterion and proof table, `<details><summary>For agents</summary>` with the rebase note, then the footer.
8. The body is about 2,900 characters above the fold. The previous contract rendered this change at 26,600.
9. A review run for that head finds the submitted object in the store and publishes it as the `pr_description` artifact; the panel shows the title, the TL;DR and the why as before.
10. Variant: a person opens a PR by hand with the old Tour shape. The parser sees `## Tour`, reads each step by its permalink line into a pointer, and reports `legacy Tour shape` as a problem, never a throw.
11. Variant: the agent pushes again and lines move. It resubmits with corrected ranges; the same object renders at the new head, exactly as today.

The property the trace proves: the body's human part is bounded by the schema, not by the author's restraint, and every surface that read the old shape still reads.

## The difficulty map

1. **The cap and the choice** ([The cap](#the-cap-seven-pointers-and-the-authors-choice)). Most likely to be wrong: a cap the author games by stuffing three files into one row, or a cap so tight the map misses the file the reviewer needed.
2. **The inverse parser and the bodies already on GitHub** ([The parser](#the-parser-two-shapes-in-one-line-and-a-legacy-branch)). Every review of a hand-written or pre-change PR reads through it; a parse that drops pointers silently loses the panel's data.
3. **Inline links instead of embeds** ([Links](#links-not-embeds)). Small in code, large in tests: the skill, its seven tests and the golden all assert the bare-URL embed.
4. **The fan-out** (most work). About 45 files reference the contract; five specs and the vendored skill change in the same PR.

## The cap: seven pointers and the author's choice

The constraint is that review effort is bounded by the reader, not the diff. Reviewers spend most of their time understanding the change, not finding defects, and past a few hundred lines they fall back to syntactic checking; longer descriptions predict fewer participants and no discussion. A body that grows with the diff spends the reader's attention before the reader chooses where to spend it. The design caps each field in the schema: `tldr` 300 visible characters, `why` 400, each pointer's `label` 60 and `text` 160 and `risk` 100, `pointers` 1 to 7, `feedbackWanted` 200, `risk` 300, `verified` 200. A cap counts visible characters, a markdown link's target excluded, so a why with three links is not punished for their URLs. The tool refuses over the cap naming the field, so the author tightens rather than the reviewer skimming. The skill tells the author how to choose: the files a reviewer would open first, entry point before core logic before tests, one pointer per idea, `⚠` on the rows where a mistake would matter, and when the change exceeds 400 changed lines, say so in the risk with the split considered.

Where the numbers come from. A written sentence runs 100 to 150 characters, so 300 is two sentences and 160 is one; 60 is a label that fits a line beside its sentence. Seven is the maximum, not a target: it is the median file count of the last 40 merged PRs here (median 7, mean 12.8), so the median PR can point at every file it touches and any larger PR must choose, and the choice is the point. Whether anyone follows the pointers is not measured today: 39 of those 40 PRs carry no inline review comment on any file, and the one that does touches one file, so the author is the only one pointing at files and the reviewer agent is the only reader whose behavior the receipts can see. The caps are decided and revisable; the first twenty PRs under them are the evidence (see What would change our mind).

The cap is a refusal, not a truncation. A mean PR (8.5 steps today) fails its first submission and spends one tool round-trip to drop a pointer or shorten a sentence, seconds inside a run that already lasts minutes; the prompt states every cap beside its field so the first submission usually fits, and the existing description turn is the fallback when no valid object arrives. A renderer that folded or cut the surplus instead would publish a map the author never saw, which is the misaligned description the acceptance studies punish.

The collapsed half is bounded too, or the coverage instinct moves there: at most 10 decisions of 400 characters of rationale, at most 30 criteria of 200 plus a proof of 300, agent notes at most 2,000. The whole body is therefore under 26,000 characters in the worst case, against a median of 6,800 and a maximum of 26,600 today with no bound at all; the usual case is a few thousand, most of it under the fold.

Invariants: a rendered map never exceeds 3,800 visible characters, and a rendered body never exceeds 26,000; the number of pointers is independent of the number of files; every pointer resolves at the head it rendered at. Failure modes: an author stuffs a row (the 160-character text cap makes three files in one sentence read badly, and the review agent's diff reading, not the map, is what catches an uncovered file); an author picks the wrong seven (the reviewer has the Files tab, and the loss is the pointer, not the code). The alternative it beat is a soft cap in the prompt: the current template already says "concise, not padded" and produced 6,800-character medians, because an instruction competes with the model's coverage instinct and a schema does not.

## The parser: two shapes in one line, and a legacy branch

The constraint is that the review side reads the body back into the object whenever no submitted object exists for the reviewed head: every hand-written PR, every PR from before this change, every PR from another tool. Two readers are involved, and each gets a legacy branch.

The body parser reads a GitHub body. Today it recognizes a step only by the bare permalink line under a `### N.` heading. The design reads the map by its numbered link lines, `N. [label](permalink) text ⚠ risk`, and keeps the old grammar behind a check: when the body carries a `## Tour` section, each step's permalink line becomes a pointer, the step's title its label and its description its text, and `legacy Tour shape` is recorded as a problem so `complete` is false. A hand-edited body with a step and no permalink, or two permalinks, is handled as today: the step is dropped or the first link wins, with a problem naming it.

The event-line parser reads stored run records. The `pr_description` artifact renames `tour` to `pointers`, adds `why`, and drops `remaining`; a record written before the change still says `tour`, so the line parser accepts either array name and history replays. What the run page shows is unchanged either way, since its panel renders the title, the TL;DR and the why and never rendered the Tour; the pointers ride in the record for the body and for a later surface.

Invariants: `parsePrDescriptionMarkdown` never throws; a map body round-trips through render and parse to the same pointers with each anchor's render sha; a legacy body yields its steps as pointers and `complete: false`. Failure modes: a person writes a numbered list with a non-permalink link (skipped with a problem, as a non-permalink line is today); a body with both shapes (the map wins, the Tour is a problem). The alternative it beat is dropping the legacy branch: the golden and the reading-diff spec both promise that a hand-written PR's Tour anchors reach the artifact, and hundreds of merged PRs carry the old shape.

## Links, not embeds

The constraint is GitHub's rendering rule: a bare permalink on its own line embeds the range as a code block; the same URL inside link syntax renders as a link. The current skill treats the embed as the feature and forbids link syntax. The embed is the cost: seven embeds at a median PR is about 150 lines of code in the body, duplicating the Files tab where the reviewer can comment. The design renders every pointer as `[label](url)`, keeps the anchor range so the click lands on highlighted lines, and rewrites the skill's embed section into a "never embed" rule. Invariant: the rendered body contains no bare `blob/` URL on its own line. Failure mode: a reader who liked seeing the code inline loses it, and gets it one click away at the exact lines. The alternative it beat is embedding only `⚠` rows: three embeds is still 60 lines of code in the body, and a rule with an exception is the rule the model economizes on.

## Why not X

**Why not cap the Tour at seven steps and collapse the rest?** The count is not the cost; the embed is. Seven embedded blocks is still a screen of code before the first decision, and a collapsed tour is a tour nobody opens.

**Why not just make the PRs smaller?** Yes, and the risk field now says so at 400 changed lines. But agents open 80-file PRs today, and the contract has to hold at every size or the large ones are the ones with no description a person reads.

**Why not generate the summary with a second model at PR open?** The author has more context than any second call, and the current pipeline already costs no extra call. The problem was never who writes it; it was the absence of a cap.

**Why not keep the Tour below the fold as well?** It would be a third copy of the diff's content, maintained on every repush, that the parser must also read. Everything the Tour said that mattered is a pointer.

## Boundaries

This record changes the contract for PRs the coding agent opens through the post-step. The maintainer's local PR template and the org skill library carry the same Tour shape and are changed beside this PR, outside this repository. The run page's panel gains no new tab; it keeps the title, the TL;DR and the why. The PR title rule, the honesty rules on validation, the description turn and the open-or-edit pipeline are untouched. Bodies already on GitHub are not rewritten.

## What would change our mind

If the review agent's findings on the first twenty PRs under the new shape name files no pointer covered at a higher rate than under the Tour, the seven-row cap is too tight or the skill's choice rule is wrong; the receipts on those reviews are the evidence, gathered in the first two weeks. Human reading is not measured here and the record does not pretend it is: the bet that a person reads a one-screen map and skips a 6,800-character tour rests on the literature in Sources, and the one number this repository can produce is criterion (1), the map's size. If reviewers ask for the embedded code back, an `embed: true` on a pointer is a one-line renderer change. Reversal is a revert of one PR plus the golden; no stored data is rewritten because the event-line parser reads both artifact shapes.

## Rollout

One PR carries the contract: types and schema, renderer and parser, the two tool schemas, the prompt, the skill renamed and rewritten with its test, the golden replaced by the PR's own description rendered through the pipeline, the artifact rename with the legacy read, and the five specs. It ships in the next release; the first coding run after the bot deploy renders the new shape. The local template and the org skill change the same day.

## Open questions

| Question | Owner | Resolves it | Needed before |
|---|---|---|---|
| Should the post-step stamp the diff's size (`N files, +A −D`) on the body rather than trust the author's risk sentence? | the maintainer | one look at whether the risk field carries the size on the first ten large PRs | second release |

## Validation criteria

Each criterion binds to a proof when the code PR lands; all are `[gap]` here.

1. The schema refuses an eighth pointer and any field over its cap, naming the field and the count. `[gap]` `src/core/prDescription.test.ts`.
2. A rendered body contains no bare permalink line; every pointer renders as `N. [label](url) text`, `⚠` only when a risk is set. `[gap]` `src/core/prDescription.test.ts`.
3. The rendered map is under 3,800 characters for a maximal object. `[gap]` `src/core/prDescription.test.ts`.
4. Decisions, validation and agent notes render inside `<details>` after the map; the footer is last. `[gap]` `src/core/prDescription.test.ts`.
5. Render then parse returns the same pointers with each anchor's render sha; the golden renders byte for byte to the checked-in body, which is the code PR's live body. `[gap]` `src/core/prDescription.test.ts`; `[agent]` `gh pr view --json body` equals the golden.
6. A legacy Tour body parses to pointers with `complete: false` and a `legacy Tour shape` problem; a body without either shape parses to the first paragraph as TL;DR. `[gap]` `src/core/prDescription.test.ts`.
7. The event-line parser accepts a stored artifact with `tour` and one with `pointers`. `[gap]` `src/core/runEventLines.test.ts`.
8. The `pr-description` skill is a first-party coding skill that pins the caps, the choice rule, the inline-link rule, the mechanical anchor rules and the fold. `[gap]` `src/skills/prDescriptionSkill.test.ts`.
9. Both coding prompts name the map's fields and require loading `pr-description` before authoring pointers; `pr-tour` appears nowhere in `src/`, `skills/` or `docs/reference/specs/`. `[gap]` `src/agents/registry.test.ts`.
10. Live: the first agent PR after deploy has a body under one screen with inline links at its head sha, and a review of it carries `pr_description` with `origin: "submitted"`. `[agent]` human-gated.

## Appendix: the map, rendered

The 80-file change from the trace, above the fold, as the renderer would write it (links shortened here).

```markdown
Trigger.dev accounts now get anomaly checks, per-task charts, and run evidence, read from the runs API and TRQL. Every read is gated on what the connected key can reach, so a restricted key gets fewer signals instead of failing ones.

**Why:** PR 2 of the provider stack ([stack](…), on the [skeleton](…)). Implements "Runs as signal" and "Deployments and tasks" from the [design record](…).

**Where to look**

1. [The TRQL composer](…/trql.ts#L77-L134) builds every statement: a one-day cap, `is_test = 0`, status strings read from the schema. ⚠ Nothing may exceed the span constant; longer lookbacks are clipped silently by the plan.
2. [The adapter](…/adapters/triggerdev.ts#L72-L128) serialises one account's queries and turns a 429 into a retryable skip, never a quiet series.
3. [Account checks fall back to the runs list](…/cloud-accounts/triggerdev.ts#L246-L272) when the key cannot query. ⚠ The fallback counts child runs with their parents; the label says "all depths".
4. [TRQL-only checks are dropped at assembly](…/cloud-accounts/triggerdev.ts#L655-L668), not failed every cycle.
5. [Traces skip on retention](…/trace-collector.ts#L337-L365): a 404 past the plan's log retention is `skip: retention`, not an error.
6. [Waitpoint URLs are redacted in the client](…/events.ts#L18-L26) before any evidence path sees them. ⚠ A leaked URL completes the waitpoint for whoever holds it.

**Feedback wanted:** whether `toMinute` and `intDiv` are safe to rely on in TRQL, or the runs-list path should be the default.

**Risk:** New provider path; no existing account is affected. 80 files and 4,920 lines: the client, the checks and the evidence collectors could have been three PRs, kept together because the checks are untestable without the client.

**Verified:** eight package suites green at head, typecheck, import boundaries, dry-run deploys for both stages. Three live checks are human-gated, listed under Validation.

▸ Decisions (10) · ▸ Validation (20 criteria) · ▸ For agents
```

The same change under the previous contract ran 26,600 characters with 20 embedded code blocks.

## Sources

- The measurement: the last 40 merged PRs of this repository at the survey sha (body length, permalink count, file count, inline review comments per file); the 80-file example is a sibling repository's PR opened by a local session under the same template.
- The previous contract: `docs/reference/specs/pr-description.md`, `docs/reference/specs/agent-coding.md` item 3, `skills/pr-tour/SKILL.md`, the golden `src/core/testing/goldenTour.description.json`.
- Reviewer navigation and change descriptions at a large engineering organization: <https://google.github.io/eng-practices/review/reviewer/navigate.html>, <https://google.github.io/eng-practices/review/developer/cl-descriptions.html>, <https://google.github.io/eng-practices/review/developer/small-cls.html>.
- Comprehension dominates review time (ICSE 2013): <https://www.microsoft.com/en-us/research/wp-content/uploads/2016/02/ICSE202013-codereview.pdf>; reviewers past their mental model check syntax, not logic (ICSE SEIP 2018): <https://sback.it/publications/icse2018seip.pdf>.
- Description length predicts poor participation over 196,712 reviews (EMSE 2017): <https://rebels.cs.uwaterloo.ca/journalpaper/2016/08/01/review-participation-in-modern-code-review.html>.
- 33,596 agent-authored PRs: structure speeds response, misaligned descriptions cut acceptance: <https://arxiv.org/html/2602.17084>; explicit statements of desired feedback raise engagement: <https://arxiv.org/pdf/2602.14611>.
- Effective review bounded at 200 to 400 lines per session: <https://smartbear.com/learn/code-review/best-practices-for-peer-code-review/>.
