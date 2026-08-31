---
name: pr-tour
description: How to write the PR body's Tour — the reader-first, hunk-anchored walkthrough of a change. Load before writing any PR description.
agents: [coding]
---

# The PR Tour

The Tour is the `tour` field of every PrDescription you submit through `submit_pr_description`: an ordered walkthrough where each step names a change, explains it, and then shows the code — Switchboard renders it as the PR body's `## Tour` section. It replaces any prose list of changes — a walkthrough that never points at the code is what makes PR bodies hard to consume. You write it right after implementing, when you have more context about the change than anyone will ever have again; it costs no extra model call.

## Reading order

Order the steps the way a reader should meet the change: entry point → core logic → tests → docs. Not file order, not diff order.

## The step shape (fixed, reader-first)

Each step is one Tour entry `{ title, description, lookFor?, anchor }`, rendered in this order:

1. `title` — a short noun phrase naming the change (e.g. "The manifest — what we vendor, from where"), rendered as the `### N. <what this change is>` heading. The reader must know what they are looking at before the code appears.
2. `description` — one short paragraph on what the hunk does and why it matters.
3. `lookFor` (optional) — the one thing the reviewer should scrutinize there, rendered as a bold **Look for:** line.
4. `anchor` — the `{ path, from, to }` line range for the hunk; the renderer places its permalink LAST.

Never code first: a reader who sees code before knowing what it is for has to read it twice.

## Anchor rules

- An anchor is a line range `{ path, from, to }` at your pushed head — `path` repo-relative, `to ≥ from`. Switchboard renders it as the permalink https://github.com/<owner>/<repo>/blob/<head sha>/<path>#L<from>-L<to>, supplying the FULL 40-char head sha it observes from your pushed branch at render time — you never write a blob URL or a sha anywhere. GitHub renders that link as an embedded code block inside the body.
- Keep each anchor to the lines that matter (≲25 lines). Split a large hunk into two steps rather than anchoring 80 lines.
- Never write an anchor from memory — line numbers guessed from recall of the file are usually wrong, and a wrong range embeds the WRONG code under a correct explanation, which is worse than no anchor. Derive every anchor mechanically against the commit you pushed (`git rev-parse HEAD` after pushing): locate the hunk with `grep -n <landmark> <path>`, then verify with `git show <sha>:<path> | sed -n '<from>,<to>p'` — the printed lines must be the exact code the step's prose describes. If they are not, fix the range, not the prose.

## Embed conditions (why a rendered permalink falls back to a plain link)

GitHub only embeds the rendered permalink when the path exists at the head sha and the range is inside the file — otherwise the reader gets a bare URL instead of the code. Check `git cat-file -e <sha>:<path>` when in doubt; a renamed or misremembered path is the most common cause of a dead anchor. The markdown side is the renderer's job, already handled: it emits each permalink standing on its own line, with a blank line before and after — never inside a bullet, blockquote, or heading, and never wrapped in markdown link syntax. Your job is keeping the anchor true.

## The catch-all

Every touched file the steps did not cover goes in `remaining` as `{ path, note }`, one entry per file — rendered as the final `### N. Remaining changes` step. Nothing in the diff goes unmentioned.

## Resubmit on every repush that moves the code

An anchor is a line range at the pushed head: on every push that changes the head (amend, rebase, force-push, review fix-ups), any step whose lines moved starts pointing at the wrong code — stale anchors are a lie about the PR. When a later push changes what the steps point at, re-verify the ranges and resubmit the description through `submit_pr_description` with corrected anchors — the last valid submission wins and Switchboard re-renders the body at the new head, editing the existing PR; never edit the PR body directly. (A push that moves no ranges needs no corrected anchors — anchors hold no sha, so the same description renders correctly at the new head.)

## Information architecture

The renderer owns the body's structure — headings for steps, bold labels, bullet lists — so the reader never faces a wall of prose. Keep each field plain unwrapped prose; the structure comes from the fields you fill, never from markdown you author.
