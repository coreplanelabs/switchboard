# Feature specs

The behavioral contract of Switchboard, versioned with the code. Every file in this directory states what a feature is supposed to do, why, and **how to prove it still does** — so at any git SHA, the validation criteria describe exactly the code at that SHA, and an agent (or human) can verify behavior for any moment in history.

## The rules

1. **Same-PR updates.** A PR that changes behavior updates the matching feature file in that PR — new criteria for new behavior, edits for changed behavior, deletions for removed behavior. A feature file that describes code that no longer exists is a bug.
2. **TDD from the spec.** New behavior starts as validation criteria here, then failing tests, then implementation to green. Unit tests are the preferred proof; each criterion names its test (`file::test name`).
3. **Agent-runnable validation for the rest.** Criteria that genuinely can't be unit-tested (live Slack flows, sandbox infrastructure, deploy-gated behavior) carry explicit `[agent]` instructions an agent can execute — the exact commands/messages to run and the expected observable result.
4. **Grow and prune.** Files are added when features ship and deleted when features are removed. History lives in git, not in dead prose.
5. **Link, don't duplicate.** Feature files own *behavioral expectations*; the technical *how* lives in [README.md](../README.md) (architecture, diagrams) and [AGENTS.md](../AGENTS.md) (invariants, map). Each feature file links to its code and docs.

## Criterion labels

- `[unit]` — proven by a named test in the suite (`npm test`).
- `[agent]` — proven by following the written validation instructions against a live deployment.
- `[gap]` — known-untested; a criterion we hold but haven't yet encoded. Gaps are work items, not decoration.

## Index

| Feature | What it covers |
|---|---|
| [routing-and-config.md](routing-and-config.md) | Directives, config layers, thread stickiness, permission gates, config commands |
| [slack-channel.md](slack-channel.md) | Triggers (mention/DM/follow-up), ack reaction, status cards, formatting, attachments |
| [run-loop.md](run-loop.md) | Turn/time budgets, wrap-up behavior, forced write-up, refusal/truncation handling |
| [execution.md](execution.md) | Per-thread workspaces, sandbox timeouts (exit 124), heartbeat streaming, session recovery, GitHub identity |
| [resident-repos.md](resident-repos.md) | Resident repo environments: auth scopes, atomic cap, lifecycle engine, thread data plane, bot-side selection, `repo onboard/offboard/rebuild/list` chat commands (fail-closed gate, --dry-run plans) |
| [agent-general.md](agent-general.md) | Default passthrough agent |
| [agent-review.md](agent-review.md) | Code review agent |
| [agent-coding.md](agent-coding.md) | Coding agent (ships PRs) |

## Milestones

| # | Goal | Status |
|---|---|---|
| 1 | [Review, general, and coding agents work as designed and are obviously better than Claude Tag](milestone-1-vs-claude-tag.md) | in progress |
