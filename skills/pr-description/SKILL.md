---
name: pr-description
description: How to write the PR description — a fixed-size map for the reader (TL;DR, why, at most seven linked pointers, feedback wanted, risk, verified) with everything for agents below a fold. Load before submitting any PR description.
agents: [coding]
---

# The PR description

The description is the `PrDescription` object you submit through `submit_pr_description`; Switchboard renders the GitHub body from it at your pushed head. The body has two parts. Above the fold, the **map**: what a person reads in a minute and clicks from. Below the fold, collapsed: what agents and the record need. You write it right after implementing, when you have more context about the change than anyone will ever have again.

The map is the same size for a 3-file and an 80-file PR. The schema enforces that: every field has a cap and the tool refuses an object over it, naming the field. Caps count visible characters; a markdown link's target is not counted, so link freely.

## The title

`title` (72): the changelog line and the squash subject, `type(scope): what a reader can now do or expect`, the whole line counted. One change, one clause, present tense; the type and the scope spend the same budget as the description, so the description is short and the body carries the rest. Judge it with `npm run check:pr-title -- "<title>"` before submitting: the same gate refuses the PR in CI, and the schema refuses a longer title naming the count.

## The map (above the fold, in this order)

1. `tldr` (300): two sentences for a reader with zero context, what this PR does and why it matters.
2. `why` (400): the problem and the motivation, with the triggering issue, the record and the stack position hyperlinked. Why, never what: the diff shows what.
3. `pointers` (1 to 7): **Where to look**, in reading order. Each is `{ label, text, risk?, anchor }`: `label` (60) names the thing, `text` (160) is one sentence on what it does or why it is shaped so, `risk` (100) is set only where a mistake would matter and renders as `⚠`, `anchor` is the `{ path, from, to }` line range at your pushed head. Rendered as `N. [label](permalink) text ⚠ risk`, a link, never embedded code.
4. `feedbackWanted` (200): the one or two things you want the reviewer's judgement on. An explicit ask gets engagement; "please review" gets none.
5. `risk` (300): what breaks if this is wrong, the blast radius, how to roll back. When the change exceeds 400 changed lines, say so here and name the split you considered.
6. `verified` (200): one line for a person: which suites ran and passed, what is still human-gated.

## Choosing the pointers

Point at the files a reviewer would open first: the entry point, then the core logic, then the test that pins the invariant, then the doc that changed. One pointer per idea, never per file; a helper and its caller that share one idea share one pointer. When the change has more than seven ideas, keep the seven whose mistake would cost most and let the Files tab carry the rest; the reviewer has the diff. Never stuff three files into one sentence to beat the cap.

## Anchors

- An anchor is a line range `{ path, from, to }` at your pushed head, `path` repo-relative, `to ≥ from`, at most about 25 lines: the click lands on highlighted lines, so point at the lines that matter. Switchboard renders the permalink `https://github.com/<owner>/<repo>/blob/<head sha>/<path>#L<from>-L<to>` with the FULL 40-char sha it observes from your pushed branch; you never write a URL or a sha.
- Never write an anchor from memory. Line numbers recalled from a file are usually wrong, and a wrong range sends the reader to the wrong code under a correct sentence, which is worse than no pointer. Derive every anchor mechanically against the commit you pushed (`git rev-parse HEAD` after pushing): locate the lines with `grep -n <landmark> <path>`, then verify with `git show <sha>:<path> | sed -n '<from>,<to>p'`. The printed lines must be the code the sentence describes. If they are not, fix the range, not the prose. Check `git cat-file -e <sha>:<path>` when a rename is possible.
- Never embed. A bare permalink on its own line makes GitHub inline the code as a block; the renderer writes every pointer as a link so the body stays a map. Do not paste code or permalinks into any prose field.

## Below the fold (collapsed by the renderer)

- `decisions` (0 to 10, rationale 400 each): the non-obvious choices, each `{ title, rationale }`: the alternative rejected and the fact that decided it. A two-line fix has none.
- `validation.criteria` (1 to 30, criterion 200, proof 300): what you ran and the real result, one row per criterion, the proof a test id or a command with its outcome. Never fabricate; a criterion you could not prove says so and is marked human-gated.
- `agentNotes` (2,000, optional): what a reviewing agent needs that a person does not: the rebase you did, the generated files to skip, the command that reproduces the bug.

## Resubmit on every repush that moves the code

An anchor is a line range at the pushed head. On every push that changes the head (amend, rebase, force-push, review fix-ups), any pointer whose lines moved points at the wrong code; stale anchors are a lie about the PR. Re-verify the ranges and resubmit the description; the last valid submission wins and Switchboard re-renders the body at the new head. Never edit the PR body directly. A push that moves no ranges needs no new anchors: the same object renders correctly at the new head.

## What not to write

No section that restates the diff: no file catalog, no per-hunk walkthrough, no "Changes" list. No embedded code. No hedges in `verified`: a suite either ran and passed or it did not. No jargon a stranger to the package cannot follow in the map; the map is for a reader who has never opened the package.
