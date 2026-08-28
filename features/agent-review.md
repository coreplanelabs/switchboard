# Agent: review

Reviews a PR with the full change in context and reports ranked, evidence-anchored findings. Gather once, analyze once — a review takes minutes, not an hour.

- **Code**: `src/agents/registry.ts` (`REVIEW_SYSTEM`; resident-path variant `REVIEW_SYSTEM_RESIDENT`; shared methodology in `REVIEW_METHODOLOGY`); post-step in `src/core/dispatcher.ts` + `src/core/reviewPost.ts` + `src/execution/githubComments.ts`
- **Docs**: [README — Agents](../README.md#agents); vendored skill reference [docs/skills/code-review-and-quality.md](../docs/skills/code-review-and-quality.md)
- **Budgets**: 30 turns (backstop) / 25 min / 64k tokens · effort `medium` · toolset `readonly` (bash + read; read-only by convention)

## Review methodology (adopted skill)

The review judgement is the **code-review-and-quality** skill from [addyosmani/agent-skills](https://github.com/addyosmani/agent-skills/blob/main/skills/code-review-and-quality/SKILL.md), distilled into `REVIEW_METHODOLOGY` and shared verbatim by both prompts (only the per-prompt GATHER steps differ — `gh` vs `git`). The full upstream text is vendored for provenance at [docs/skills/code-review-and-quality.md](../docs/skills/code-review-and-quality.md). What the prompt bakes in:

- **Five-axis framework** — correctness, readability & simplicity, architecture, security, performance — walked across every changed file, tests read first.
- **Process** — understand context → review tests first → review implementation across the five axes → verify the author's verification (tests ran? build passed? screenshots / before-after?).
- **Severity scheme as the output format** — `Critical:` (blocks) · *(no prefix)* = Required · `Optional:`/`Consider:` · `Nit:` · `FYI`; lead with impact (correctness & security first, one structural problem outweighs ten nits) and end with a one-line verdict (Approve / Request changes).
- **Structural remedies + presumptive blockers** — propose the specific fix when flagging structure; surface complexity-relocating refactors, feature logic in shared modules, near-duplicate helpers, silent fallbacks, and files pushed past size boundaries.
- **Honesty** (no rubber-stamping, no softening real issues, quantify, push back, accept override gracefully), **dead-code hygiene** (list orphans, ask before deleting), **dependency discipline** (justify new deps; changelog/isolation/lockfile rigor on upgrades).

Skipped as human-workflow-only (not baked into the agent): review-speed SLAs, PR-splitting strategies, and authoring the change description — though "verify the verification" is kept.

## Behavior

1. **Gather once** (2–4 batched calls): PR meta + full diff + full current contents of changed files; enormous PRs print risky files in full and say what was skimmed.
2. **Analyze once** with everything in context, across the five-axis methodology (above): read the tests first, then walk each changed file for correctness, readability, architecture, security, and performance — each correctness/security bug with a concrete failure scenario. At most 2–3 targeted follow-up reads.
3. **Report everything found** with a severity label from the adopted scheme, confidence, and `file:line`, ordered by leverage (most-severe first), ending with a one-line verdict. A correct change gets a plain "looks correct" — no manufactured findings.
4. Maintains the status-card checklist; never pre-marks reporting steps.
5. Leads the final message with a one-line verdict.
6. **Posts the review back to the PR by default** (issue [#69](https://github.com/coreplanelabs/switchboard/issues/69)): the user never has to add "and post to the PR". A deterministic dispatcher post-step (`decideReviewPost` in [`reviewPost.ts`](../src/core/reviewPost.ts)) fires whenever the resolved agent is `review` AND a PR was resolved (`RepoContext.pr`, from a PR URL or `owner/name#N` in the current message); the bot then posts the agent's final review text to that PR as a **comment** — never an approval or a merge. This is a system-level guarantee (code, not model memory), so it holds identically on the sandbox and resident paths.
   - **Mechanism + auth**: the post runs in the bot process via the GitHub REST API (`POST /repos/{repo}/issues/{n}/comments`, [`githubComments.ts`](../src/execution/githubComments.ts)) with the GitHub App installation token (App needs `pull_requests:write`) — the same REST-with-App-token path repo/PR resolution uses, never a `gh` shell-out and never from inside the sandbox/resident ([AGENTS.md](../AGENTS.md) invariant 5). Best-effort: a post failure is logged but never fails the run (the review already landed in Slack).
   - **The agent never self-posts — enforced at the token, not just the prompt**: `REVIEW_SYSTEM`/`REVIEW_SYSTEM_RESIDENT` instruct the model to just produce the review and NOT run `gh pr comment` or any comment-creating call — but the prompt is the weak guard. The strong guard is least-privilege: the `readonly` toolset's sandbox gets a **read-scoped** GitHub App installation token (`contents:read`, `pull_requests:read`, `metadata:read` — [`githubApp.ts`](../src/execution/githubApp.ts) `resolveGithubToken("read")`, wired in [`factory.ts`](../src/execution/factory.ts) `githubEnvs` by `toolset`). So even though the review sandbox has `gh` + the credential helper, it can `gh pr view`/`gh pr diff` and clone a private repo but **physically cannot** comment, review, or push — closing the double-post and prompt-injection (untrusted diff) hole at the token. The `full` (coding) toolset keeps a write-scoped token; the bot-process post (above) uses its own write token, so the deterministic post is unaffected. There is exactly one comment, and it comes from the bot.
   - **Opt-out**: an explicit "don't post" / "slack only" (or `post:off`) in the request suppresses the GitHub post; the review still replies in Slack.
   - **Only for PR reviews**: a review with no resolved PR (pasted code, or a repo mention with no PR) posts nowhere — no crash, just the Slack reply.
7. **Resident-path variant** ([resident-repos.md](resident-repos.md) §31): in a resident repo environment the dispatcher swaps in `REVIEW_SYSTEM_RESIDENT` via `RunOptions.system` — same gather-once discipline, but against the ready worktree (already on the branch under review, deps installed; no cloning) using git directly, since `gh` is not in the resident image.

## Validation criteria

| Criterion | Proof |
|---|---|
| Budgets and toolset as specified | `[unit]` `src/agents/registry.test.ts::review`; budget mechanics proven in `src/runner.test.ts`. |
| Resident variant: ready worktree, git-based gather, no clone/gh instructions; fallback prompt unchanged | `[unit]` `src/agents/registry.test.ts::resident prompt variants`; selection wiring in `src/core/dispatcher.test.ts::repo/ref resolution + resident prompt selection (U7)`. |
| Both prompts adopt the code-review-and-quality methodology (five axes + severity scheme) | `[unit]` `src/agents/registry.test.ts::review prompts adopt the code-review-and-quality methodology` — five axes named, full severity scheme present, lead-with-impact + verdict, and the tests-first/structural-remedy/honesty/dead-code/dependency disciplines carried in both prompts. Reference text vendored at `docs/skills/code-review-and-quality.md`. |
| Real PR review lands within budget with verdict-first output | `[agent]` `@switchboard agent:review <PR URL>` on a real PR (~<2k changed lines). Expect: status checklist, completion well under 25 min, one-line verdict first, findings with file:line + severity + confidence. |
| Findings are real (spot-check) | `[agent]` For the top finding, open the cited file:line and confirm the described failure scenario is coherent with the code. A fabricated citation is a critical failure. |
| Posts review to GitHub by default for PR reviews (opt-out available) | `[unit]` `src/core/reviewPost.test.ts` (decision + opt-out parse), `src/core/dispatcher.test.ts::review post-step (issue #69)` (posts on a resolved PR, suppressed on opt-out, no-op with no PR, non-review never posts, post failure swallowed), `src/core/repoContext.test.ts` (PR number carried on `RepoContext.pr`). `[agent]` `agent:review <PR URL>` with NO "post" phrasing → a review comment appears on the PR authored by the App (requires App `pull_requests:write`; mechanism confirmed on PR [#68](https://github.com/coreplanelabs/switchboard/pull/68)). Opt-out: add "don't post" / "slack only" → no comment appears, Slack still gets the review. |
| Quality bar (see milestone 1) | `[agent]` Reviews on this repo's own PRs #27–#34 each caught ≥1 real blocker or verified root causes against vendored SDK source — that's the bar to hold. |
