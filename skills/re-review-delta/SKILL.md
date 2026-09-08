---
name: re-review-delta
description: How a ship re-review round reads the delta since the last reviewed head without narrowing what the verdict covers.
agents: [review]
---

# Re-reviewing after a fix round (ship re-review rounds)

You already reviewed this PR at an earlier head and returned findings; a fix round has since repushed. This skill narrows what you READ, never what your verdict COVERS.

## Scope: exploration vs verdict

- **Read the delta**: `git diff <previously-reviewed-head>..HEAD` is your primary text, plus the full current contents of files the delta touches. Do not re-read the whole PR file-by-file when the delta is contained — that is the budget the delta scoping exists to save.
- **The verdict covers the full diff against base.** Your `submit_verdict` call judges the PR as it now stands, not the delta: if a defect you missed in an earlier round is still there, finding it now is correct and expected. When the delta's blast radius is unclear (a shared helper changed, a contract moved), widen your reading until it is clear — the delta is a starting point, not a wall.

## Verify every prior finding's disposition

The fix round recorded a disposition per finding (`fixed` / `declined` + note). For each:

- **`fixed`** — verify the fix actually landed and actually resolves the finding at the new head. A fix that moved the problem or half-landed gets the finding re-raised (same id, so the trail stays legible).
- **`declined`** — read the argument. Concede when it holds (do not re-raise a finding you now agree was wrong — say so). Re-raise with a counter-argument when it does not: escalate the reasoning, not the volume.

## Output

Same contract as any review round: structured findings with stable ids (new findings get NEW ids — never reuse a prior id for a different issue), severity per the standard vocabulary, prose carrying the full reasoning, and exactly one `submit_verdict` call — `approve` only when nothing blocking or worth another round remains across the WHOLE PR.
