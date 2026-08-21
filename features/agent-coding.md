# Agent: coding

Takes a task from Slack, scopes fast, implements the change in its sandbox, and ships a PR. Its unit of delivery is a PR URL, not prose.

- **Code**: `src/agents/registry.ts` (`CODING_SYSTEM`)
- **Docs**: [README — Agents](../README.md#agents)
- **Budgets**: 60 turns / 45 min / 64k tokens · toolset `full`

## Behavior

1. **Scope first, hard rule (≤5 tool calls)**: identify the target repo and surface; genuinely ambiguous → ask ONE question and stop the turn. Never clones multiple repos or maps the org to avoid asking.
2. Workflow: clone (≤1 repo/task) → branch → implement matching surrounding style → run quick tests/linters if present → commit → push → `gh pr create` with an explanatory body.
3. Reads task context itself (`gh issue view`, `gh pr view`) — requires the GitHub App's Issues permission (see [execution.md](execution.md) §5).
4. Maintains the status-card checklist (outcomes, never commands; nothing pre-marked).
5. Reports faithfully: failing tests and skipped steps are stated plainly; final message leads with outcome + PR link.

## Validation criteria

| Criterion | Proof |
|---|---|
| Budgets and toolset as specified | `[unit]` `src/agents/registry.test.ts::coding`; budget mechanics in `src/runner.test.ts`. |
| End-to-end: issue → PR | `[agent]` `@switchboard agent:coding investigate and fix <issue URL>` on a small real issue. Expect: it reads the issue itself (no 403, no asking you to paste it), one repo cloned, a PR opened whose diff addresses the issue, final message = outcome + PR link. Reference run: [nominal#1347](https://github.com/coreplanelabs/nominal/pull/1347) from [issue #1346](https://github.com/coreplanelabs/nominal/issues/1346), 2026-08-21. |
| Ambiguity → one question, then stop | `[agent]` Give a task naming no repo with several plausible candidates; expect exactly one clarifying question and a stopped turn — not a survey of the org. |
| Honest failure reporting | `[agent]` Ask for a change in a repo whose tests are broken at HEAD; the final message must state the failure plainly rather than claim success. |
| No placeholder narration | `[agent]` Replies must never contain bracketed placeholders (e.g. "[title and details from the issue]") in place of real command output. Regression observed 2026-08-21 when a follow-up mis-routed to `general`; guarded by thread stickiness ([routing-and-config.md](routing-and-config.md)). |
