# Agent: review

Reviews a PR with the full change in context and reports ranked, evidence-anchored findings. Gather once, analyze once — a review takes minutes, not an hour.

- **Code**: `src/agents/registry.ts` (`REVIEW_SYSTEM`; resident-path variant `REVIEW_SYSTEM_RESIDENT`)
- **Docs**: [README — Agents](../README.md#agents)
- **Budgets**: 30 turns (backstop) / 25 min / 64k tokens · effort `medium` · toolset `readonly` (bash + read; read-only by convention — bash can still run `gh pr comment` etc.)

## Behavior

1. **Gather once** (2–4 batched calls): PR meta + full diff + full current contents of changed files; enormous PRs print risky files in full and say what was skimmed.
2. **Analyze once** with everything in context: correctness bugs first, each with a concrete failure scenario; then design/simplification notes. At most 2–3 targeted follow-up reads.
3. **Report everything found** with severity, confidence, and `file:line`, most-severe first. A correct change gets a plain "looks correct" — no manufactured findings.
4. Maintains the status-card checklist; never pre-marks reporting steps.
5. Leads the final message with a one-line verdict.
6. **Resident-path variant** ([resident-repos.md](resident-repos.md) §31): in a resident repo environment the dispatcher swaps in `REVIEW_SYSTEM_RESIDENT` via `RunOptions.system` — same gather-once discipline, but against the ready worktree (already on the branch under review, deps installed; no cloning) using git directly, since `gh` is not in the resident image.

## Validation criteria

| Criterion | Proof |
|---|---|
| Budgets and toolset as specified | `[unit]` `src/agents/registry.test.ts::review`; budget mechanics proven in `src/runner.test.ts`. |
| Resident variant: ready worktree, git-based gather, no clone/gh instructions; fallback prompt unchanged | `[unit]` `src/agents/registry.test.ts::resident prompt variants`; selection wiring in `src/core/dispatcher.test.ts::repo/ref resolution + resident prompt selection (U7)`. |
| Real PR review lands within budget with verdict-first output | `[agent]` `@switchboard agent:review <PR URL>` on a real PR (~<2k changed lines). Expect: status checklist, completion well under 25 min, one-line verdict first, findings with file:line + severity + confidence. |
| Findings are real (spot-check) | `[agent]` For the top finding, open the cited file:line and confirm the described failure scenario is coherent with the code. A fabricated citation is a critical failure. |
| Posts review to GitHub when asked | `[agent]` `agent:review review <PR> and post the review as a PR comment` — expect `gh pr comment` to succeed and the comment to appear (requires app `pull_requests:write`; validated after the sandbox-timeout chain, PRs [#27](https://github.com/coreplanelabs/switchboard/pull/27)–[#33](https://github.com/coreplanelabs/switchboard/pull/33)). |
| Quality bar (see milestone 1) | `[agent]` Reviews on this repo's own PRs #27–#34 each caught ≥1 real blocker or verified root causes against vendored SDK source — that's the bar to hold. |
