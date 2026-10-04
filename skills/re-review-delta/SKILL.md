---
name: re-review-delta
description: How a re-review — a ship re-review round, or a re-review asked for in a thread whose coding run repushed — reads the delta since the last reviewed head without narrowing what the verdict covers.
agents: [review]
---

# Re-reviewing after a repush (ship re-review rounds and thread re-reviews)

You already reviewed this PR at an earlier head and returned findings; the branch has since been repushed — by a fix round of the ship pipeline, or by a coding run in this thread that addressed your findings. This skill narrows what you READ, never what your verdict COVERS.

## Scope: exploration vs verdict

- **Read the delta**: `git diff <previously-reviewed-head>..HEAD` is your primary text, plus the full current contents of files the delta touches. Do not re-read the whole PR file-by-file when the delta is contained — that is the budget the delta scoping exists to save.
- **The verdict covers the full diff against base.** Your `submit_verdict` call judges the PR as it now stands, not the delta: if a defect you missed in an earlier round is still there, finding it now is correct and expected. When the delta's blast radius is unclear (a shared helper changed, a contract moved), widen your reading until it is clear — the delta is a starting point, not a wall.

## Verify every prior finding's disposition

First read `github_pull_get` for the bound PR with `includeReviewHistory: true`. Its outstanding findings use GitHub review IDs to distinguish separate rounds' reused `F1` labels. Copy those scoped IDs exactly when re-raising or closing a finding; thread artifacts and author comments supply context, never closure proof. Check every prior invariant case at the current head and inspect affected callers for regressions. A missing case belongs under the same finding; a distinct invariant gets a fresh local ID.

The coding run that addressed your findings recorded a disposition per finding (`fixed` / `declined` + note): a ship round hands them to you in its turn, a thread re-review in the artifacts block of your prompt. For each:

- **`fixed`** — verify the fix actually landed and actually resolves the finding at the new head. For an invariant finding, check EACH prior case's scenario and expected behavior against the new head; enumerate any missing selection or execution paths and widen under the SAME id. A fix that moved the problem or half-landed gets the finding re-raised (same id, so the trail stays legible).
- **`declined`** — read the argument. Concede when it holds (do not re-raise a finding you now agree was wrong — say so). Re-raise with a counter-argument when it does not: escalate the reasoning, not the volume.

## Output

Every outstanding finding gets exactly one typed outcome in `submit_verdict`: keep it in `findings` under its scoped ID, or include it in `resolutions` with `findingId`, `disposition: fixed|declined`, and an evidence note naming what you checked at this head. `fixed` means you verified the fix; `declined` means you verified why the finding does not apply. Never infer either from omission or the author's assertion. Keep every previous case when re-raising and add the missing cases. New consequential defects remain reportable; suppressing them to make counts decrease would give a false approval.

Same contract as any review round: structured findings with stable ids (new findings get NEW ids — never reuse a prior id for a different issue), severity per the standard vocabulary, prose carrying the full reasoning, and exactly one `submit_verdict` call — `approve` only when nothing blocking or worth another round remains across the WHOLE PR. Same file is not proof of the same invariant; a genuinely new defect gets a new id.
