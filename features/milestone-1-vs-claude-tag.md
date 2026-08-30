# Milestone 1 — agents work as designed, obviously better than Claude Tag

**Goal**: the `review`, `general`, and `coding` agents each work exactly as their feature files specify, and a Slack user comparing Switchboard to Claude Tag (Claude in Slack) sees the difference **immediately** — in the first interaction, without being told where to look.

Claude Tag is the baseline: a capable model in Slack with conversation context, but no isolated execution, no repo-authenticated tooling, no per-channel/agent/model routing, no budget discipline, and no PR-shipping loop.

- **Receipts**: https://github.com/coreplanelabs/switchboard/issues/81 — the Claude Tag parity matrix: per-claim receipts, the cold-start A/B scoreboard, and the milestone-closing side-by-side.

## The obvious-difference claims

Each claim must be demonstrable in one interaction. These are the demo moments; if one stops being true, this milestone regresses.

| # | Claim | Demonstration |
|---|---|---|
| 1 | **Ships real PRs** — issue link in, reviewed-quality PR out, authored by the bot identity | [agent-coding.md](agent-coding.md) end-to-end criterion. Claude Tag cannot clone, run tests, or push. |
| 2 | **Reviews with the whole PR in context and executes code to check itself** — findings carry file:line + severity + a concrete failure scenario, and are posted back to the PR | [agent-review.md](agent-review.md) criteria: the bot's review lands on the PR as `coreplane-switchboard[bot]`, having run the suite itself. |
| 3 | **Sandboxed, budgeted execution that fails legibly** — commands run in a per-thread sandbox; long commands stream; timeouts are `exit 124` with guidance, not silence | [execution.md](execution.md) + [run-loop.md](run-loop.md) criteria. |
| 4 | **Routing you can steer** — `agent:` / `model:` per request, per-channel and per-user defaults, threads remember their agent, restricted agents enforced at run time | [routing-and-config.md](routing-and-config.md) criteria (unit-tested end to end). |
| 5 | **Progress you can watch** — live status card with the agent's own checklist, elapsed time, and a guaranteed final message even on budget exhaustion | [slack-channel.md](slack-channel.md) + [run-loop.md](run-loop.md); the budget-exhaustion write-up is unit-proven in `src/runner.test.ts`. |
| 6 | **Instant acceptance receipt** (👀 reaction) | [slack-channel.md](slack-channel.md). |

## Exit criteria for the milestone

1. Every `[unit]` criterion in the three agent files + routing/run-loop files is green in CI (`.github/workflows/ci.yml` runs typecheck, the test suite, the dist-excludes-tests check, and the sandbox-worker typecheck on every PR).
2. Every `[agent]` criterion in [agent-general.md](agent-general.md), [agent-review.md](agent-review.md), [agent-coding.md](agent-coding.md) has a receipt from the production deployment on its receipts issue.
3. Claims 1–6 above each carry a receipt on [#81](https://github.com/coreplanelabs/switchboard/issues/81).
4. A cold-start comparison run: give Claude Tag and Switchboard the same three tasks (a question, a PR review, an issue-to-PR) in parallel channels; the Switchboard result must be visibly superior in the thread itself with no narration needed. The side-by-side is the milestone-closing receipt, recorded on [#81](https://github.com/coreplanelabs/switchboard/issues/81).
