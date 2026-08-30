---
name: pr-tour
description: How to write the PR body's Tour — the reader-first, hunk-anchored walkthrough of a change. Load before writing any PR description.
agents: [coding]
---

# The PR Tour

The Tour is the `## Tour` section of every PR body you write: an ordered walkthrough where each step names a change, explains it, and then shows the code. It replaces any prose list of changes — a walkthrough that never points at the code is what makes PR bodies hard to consume. You write it right after implementing, when you have more context about the change than anyone will ever have again; it costs no extra model call.

## Reading order

Order the steps the way a reader should meet the change: entry point → core logic → tests → docs. Not file order, not diff order.

## The step shape (fixed, reader-first)

Each step is, in this order:

1. A `### N. <what this change is>` heading — a short noun phrase naming the change (e.g. "The manifest — what we vendor, from where"). The reader must know what they are looking at before the code appears.
2. One short paragraph on what the hunk does and why it matters.
3. Optionally, a bold **Look for:** line naming the one thing the reviewer should scrutinize there.
4. The permalink to the hunk LAST.

Never code first: a reader who sees code before knowing what it is for has to read it twice.

## Anchor rules

- The permalink is https://github.com/<owner>/<repo>/blob/<head sha>/<path>#L<from>-L<to> with the FULL 40-char head sha from `git rev-parse HEAD` after pushing. GitHub renders that link as an embedded code block inside the body; a branch name does not render.
- Keep each anchor to the lines that matter (≲25 lines). Split a large hunk into two steps rather than anchoring 80 lines.

## The catch-all

End with a `### N. Remaining changes` step listing every touched file the steps did not cover, one line each (`- \`path\` — note`). Nothing in the diff goes unmentioned.

## Regenerate on every repush

A permalink pins a sha: on every push that changes the head (amend, rebase, force-push, review fix-ups) every anchor starts pointing at a commit that is no longer the PR head — stale anchors are a lie about the PR. Regenerate the Tour with the new sha and update the PR body in the same step as the push, every time.

## Information architecture

Use markdown structure throughout the body — headings for steps, bold labels, bullet lists — never a wall of prose.
