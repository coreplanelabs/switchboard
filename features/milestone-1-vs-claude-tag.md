# Milestone 1 — agents work as designed, obviously better than Claude Tag

**Goal**: the `review`, `general`, and `coding` agents each work exactly as their feature files specify, and a Slack user comparing Switchboard to Claude Tag (Claude in Slack) sees the difference **immediately** — in the first interaction, without being told where to look.

Claude Tag is the baseline: a capable model in Slack with conversation context, but no isolated execution, no repo-authenticated tooling, no per-channel/agent/model routing, no budget discipline, and no PR-shipping loop.

## The obvious-difference claims

Each claim must be demonstrable in one interaction. These are the demo moments; if one stops being true, this milestone regresses.

| # | Claim | Demonstration | Status |
|---|---|---|---|
| 1 | **Ships real PRs** — issue link in, reviewed-quality PR out, authored by the bot identity | [agent-coding.md](agent-coding.md) end-to-end criterion. Reference: [nominal#1347](https://github.com/coreplanelabs/nominal/pull/1347). Claude Tag cannot clone, run tests, or push. | ✅ demonstrated 2026-08-21 |
| 2 | **Reviews with the whole PR in context and executes code to check itself** — findings carry file:line + severity + a concrete failure scenario, and can be posted back to the PR | [agent-review.md](agent-review.md) criteria. Reference: reviews on switchboard PRs #27–#34 (each caught a real blocker or verified SDK source). | ✅ demonstrated |
| 3 | **Sandboxed, budgeted execution that fails legibly** — commands run in a per-thread sandbox; long commands stream; timeouts are `exit 124` with guidance, not silence | [execution.md](execution.md) + [run-loop.md](run-loop.md) criteria. Receipt: [validation thread](https://coreplanelabs.slack.com/archives/C0BQS7KPJHK/p1787341095008729). | ✅ demonstrated |
| 4 | **Routing you can steer** — `agent:` / `model:` per request, per-channel and per-user defaults, threads remember their agent, restricted agents enforced at run time | [routing-and-config.md](routing-and-config.md) criteria (unit-tested end to end). | ✅ unit-proven; live receipt on [#34](https://github.com/coreplanelabs/switchboard/pull/34) |
| 5 | **Progress you can watch** — live status card with the agent's own checklist, elapsed time, and a guaranteed final message even on budget exhaustion | [slack-channel.md](slack-channel.md) + [run-loop.md](run-loop.md). | ✅ shipping |
| 6 | **Instant acceptance receipt** (☎️ reaction) | [slack-channel.md](slack-channel.md) — **blocked on the `reactions:write` scope** (human-gated). | ⏳ deployed, scope pending |

## Exit criteria for the milestone

1. Every `[unit]` criterion in the three agent files + routing/run-loop files is green in CI (`npm test`).
2. Every `[agent]` criterion in [agent-general.md](agent-general.md), [agent-review.md](agent-review.md), [agent-coding.md](agent-coding.md) has a dated receipt (link in the file) from the production deployment.
3. Claims 1–6 above each have a receipt, including #6 once the scope lands.
4. A cold-start comparison run: give Claude Tag and Switchboard the same three tasks (a question, a PR review, an issue-to-PR) in parallel channels; the Switchboard result must be visibly superior in the thread itself with no narration needed. Post the side-by-side as the milestone-closing receipt here.

## Known gaps standing between here and "done"

- `reactions:write` scope (claim 6) — human-gated.
- `[gap]` items in the feature files (trigger-gating unit tests, image fixtures, wrap-up-warning clock injection, quoting suite in CI, GH App token unit tests).
- No CI workflow runs `npm test` yet — the suite exists but only runs locally.
