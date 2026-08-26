# Agent run loop & budgets

The runner is provider-blind: complete → execute tools → append results → repeat. Budgets guarantee a run always ends with a useful message — never a silent death.

- **Code**: `src/runner.ts`, budgets on `src/agents/registry.ts`
- **Docs**: [README — Agent loop](../README.md#architecture)
- **Tests**: `src/runner.test.ts`

## Behavior

1. **Wall clock is the real budget; turns are a backstop.** Each agent defines `maxMinutes` (hard deadline) and `maxTurns` (runaway guard). `update_status`-only turns don't consume turns; an absolute iteration cap of `maxTurns × 2` bounds the loop regardless.
2. **Wrap-up warning**: once, as the deadline approaches (≤3 min or 25% left), the model is told how long remains and to consolidate rather than explore.
3. **Forced write-up**: on budget exhaustion the model gets one final tool-less call to report findings so far + what a follow-up should do; the answer is prefixed `⚠️ Hit the <N>-minute/-turn budget…`. An empty write-up still produces a user-facing message.
4. **Refusals** surface as a clear user-facing message suggesting rephrase/model-switch; **token-limit truncation** is labeled, never silent.
5. Current budgets: general 1 turn/5 min · review 30 turns/25 min · coding 60 turns/45 min. Changing them is a feature change — update this file and the registry together.
6. **Per-run system override**: `RunOptions.system` replaces `agent.system` for a single run — every provider call in the run, including the forced write-up, uses it. The dispatcher can choose an effective prompt after executor resolution (resident-repo context, later milestones) without ever mutating the shared `AgentDef` (concurrent dispatches share it). No override → `agent.system`, unchanged.

## Validation criteria

| Criterion | Proof |
|---|---|
| Within-budget runs return the model's answer verbatim | `[unit]` `src/runner.test.ts::returns the model's answer` |
| Turn exhaustion → tool-less forced write-up labeled `N-turn` | `[unit]` `src/runner.test.ts::forces a write-up…turns run out` |
| Deadline exhaustion → write-up labeled `N-minute` | `[unit]` `src/runner.test.ts::labels the write-up with the minute budget` |
| Status-only turns don't consume the turn budget | `[unit]` `src/runner.test.ts::update_status-only turns` |
| Refusal and truncation surfaced legibly | `[unit]` `src/runner.test.ts::refusals / truncated` |
| Wrap-up warning fires once near the deadline | `[unit]` `src/runner.test.ts::emits the wrap-up warning` (runner takes an injectable `now` clock). |
| `RunOptions.system` override reaches every provider call; absent → `agent.system` | `[unit]` `src/runner.test.ts::a system override in RunOptions reaches the provider request`, `::the system override also governs the forced write-up call`, `::without an override the agent's own system prompt is used` |
