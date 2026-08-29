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
7. **Fail fast on an unrecoverable sandbox (#92)**: an exec-**infrastructure** failure (the sandbox unreachable, an HTTP/worker error, the sandbox's "Command execution failed" / exitCode-127 signal, a worktree unrecoverable after re-attach) is categorically distinct from a normal nonzero command exit — remote executors throw `ExecInfraError` for it, while a nonzero exit is returned as ordinary output. The runner watches sandbox health through the executor seam (`ExecHealthTracker`): after `MAX_CONSECUTIVE_INFRA_FAILURES` (default 2) infra failures **with no successful op between them**, it stops issuing commands into the dead sandbox and ends through the same guaranteed finale — a tool-less write-up led by the diagnostic *"Execution sandbox unreachable: N consecutive exec-transport failures (the sandbox was wedged, or replaced/redeployed mid-run) — aborting instead of retrying into it. Last error: …"*. The diagnostic is **cause-neutral**: the runner only observes that the transport failed, so it states that and quotes the LAST `ExecInfraError` message verbatim (`ExecHealthTracker.lastInfraError`, redacted + capped) in the answer, the progress note, and the typed `sandbox_dead` note — never a guessed cause (the earlier "likely OOM/disk during a heavy install" wording misled the operator on 2026-08-29, when three `switchboard-resident` deploys recycled the Durable Object under a run whose `npm test` had in fact finished, exit 0). The finale instruction to the model is cause-neutral too, and tells it the last command(s) may have completed without their results being collected. A single successful exec resets the counter, so a one-off blip never aborts, and a normal nonzero exit (output, not a throw) can never trip it. This turns minutes of toil-until-wall-clock into a fast, legible outcome.

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
| K consecutive infra failures → fast abort via the finale with the diagnostic, not toil to the wall clock | `[unit]` `src/runner.test.ts::aborts via the finale after consecutive infra failures instead of toiling into a dead sandbox` — receipt: [CI run](https://github.com/coreplanelabs/switchboard/actions/runs/33143950055) (2026-08-28) |
| The diagnostic is cause-neutral and quotes the last transport error (answer, progress note, `sandbox_dead` note) — no "OOM" guess | `[unit]` `src/runner.test.ts::aborts via the finale after consecutive infra failures instead of toiling into a dead sandbox` (asserts `unreachable`, the failure count, the verbatim last error, and the absence of `OOM`/`unresponsive` in answer + note + finale instruction), `::emits sandbox_dead when consecutive infra failures abort the run` (note summary carries count + last error); `src/execution/executor.test.ts::ExecHealthTracker::remembers the LAST infra error's message for the fail-fast diagnostic and forgets it on success` (red-verified 2026-08-29) |
| A normal nonzero command exit never aborts (agent keeps handling it) | `[unit]` `src/runner.test.ts::does NOT abort on ordinary nonzero command exits` — receipt: [CI run](https://github.com/coreplanelabs/switchboard/actions/runs/33143950055) (2026-08-28) |
| A single infra failure followed by a success does not abort (counter resets) | `[unit]` `src/runner.test.ts::does NOT abort when a single infra failure is followed by a success` — receipt: [CI run](https://github.com/coreplanelabs/switchboard/actions/runs/33143950055) (2026-08-28) |
| Infra-vs-exit classification + consecutive-failure counting at the executor seam | `[unit]` `src/execution/executor.test.ts::ExecHealthTracker` (counts consecutive `ExecInfraError`, resets on success, non-infra throw untouched, nonzero-exit output resets) — receipt: [CI run](https://github.com/coreplanelabs/switchboard/actions/runs/33143950055) (2026-08-28) |
