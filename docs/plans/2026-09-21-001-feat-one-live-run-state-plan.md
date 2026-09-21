---
title: One live run state - Plan
type: feat
date: 2026-09-21
status: proposed
artifact_contract: ce-unified-plan/v1
artifact_readiness: implementation-ready
product_contract_source: ce-plan-bootstrap
execution: code
extends: ../decisions/0072-a-run-has-one-live-state-owned-by-the-server-a-closed-set-one-event-one-wording-function-and-every-surface-reads-the-one-field.md
---

# One live run state - Plan

## Goal Capsule

- **Objective**: Build [record 0072](../decisions/0072-a-run-has-one-live-state-owned-by-the-server-a-closed-set-one-event-one-wording-function-and-every-surface-reads-the-one-field.md): one server-owned closed run-state set, one durably ordered state event and `{state, since, bound, detail}` projection, one wording function, every live surface reading that field, and friction and plane judgements reading its intervals and bound rather than spans or silence.
- **Authority**: accepted [record 0072](../decisions/0072-a-run-has-one-live-state-owned-by-the-server-a-closed-set-one-event-one-wording-function-and-every-surface-reads-the-one-field.md), including its 2026-09-21 correctness and cold-reader amendment, is this plan's authority; [record 0064](../decisions/0064-the-plane-owns-every-runs-state-a-refusal-becomes-a-queue-position-an-ending-is-judged-by-the-ledger-that-saw-it-and-a-release-is-a-quiet-window-a-person-closes.md) remains authoritative for admission, endings and plane ownership, [record 0066](../decisions/0066-a-user-meets-twelve-nouns-and-no-others-the-vocabulary-is-a-reference-page-bound-to-the-code-and-the-consistency-check-fails-a-user-surface-that-prints-an-internal-word.md) for printed vocabulary, and the living specs each unit updates with exact proofs.
- **Execution profile**: three code units run in dependency order, each one pull request through the review loop. U1 introduces the state contract and durable source while the existing renderers still work; U2 moves every surface and deletes the rival live-condition sources; U3 moves the two judgements and deletes span/pace inference. No unit needs a production flag: every intermediate head has a complete reader for every field it writes.
- **Stop conditions**: a unit stops and hands back a deviation before changing anything if it needs a new store, Worker, timer, polling loop, user noun, per-surface wording, unbounded detail string, second state owner, accepted-record body edit, or a transition that cannot be committed durably before its source advances. It also stops if an admitted live run cannot be assigned one state, a current wait cannot map to the closed set, a restart test loses any projection member, or the resident callback can outlive the attach attempt that issued it.
- **Tail ownership**: each pull request merges through the plan runner after review and CI. U1's durable replay tests, U2's surface matrix and U3's interval/bound tests are repository-accessible completion facts; the staged-drain cross-surface receipt is human-gated and follows U3 without blocking unattended code completion.

---

## Product Contract

### Summary

A run has exactly one live condition after admission. The server assigns it from a closed union, appends a `run_state` event when the state changes, and materializes one `{state, since, bound, detail}` field on the local summary, durable live row and final record in the same ordered write. The resident client may request only the two waits it alone witnesses; every other transition is assigned by the server. One wording function translates the field for every surface. Friction folds state intervals, and the plane compares the current state to its own bound.

### Problem Frame

Today seven mechanisms answer “what is this run doing”: open span display names, a card-only setup label, `activity`/`inFlight`, retrospective shape buckets, lifecycle notes, plane health flags and friction categories. They disagree exactly when the run is waiting. A deploy drain can be visible to the resident client while the card says only that the workspace is attaching, the plane reports no health fact, the run page has no live cause and friction later records no drain interval. The registry's current in-flight field is process memory, so promoting it without a durable projection would make the new answer disappear on a bot restart.

### Requirements

**The server-owned state and durable projection (U1)**

- R1. `RunLiveStateName` is the closed union `admitted | waiting_deploy | waiting_repository | falling_back | preparing | working | waiting_provider | wrapping_up | ended`. Every admitted run has one member; `ended` is terminal; re-attach and provider recovery may return a run from a wait to `working`; a plane queue row remains a pre-admission request and is not assigned a live state.
- R2. One `RunLiveState` projection carries `{ state, since, bound?, detail? }` with epoch-millisecond `since` and absolute `bound`. Every non-terminal state has a bound from the fact that created it or a named central budget; `ended` has none. `detail` is redacted, capped and already in user words — raw resident codes, provider bodies and internal mechanism names never enter the projection.
- R3. One server operation owns assignment. It validates the transition and expected sequence, stamps `since`, and commits the materialized projection to the durable live row before updating the registry and subscribers. A changed member commits a `run_state` event in that transaction. A same-state refresh commits its newer durable source event with the projection, preserves `since`, may replace `bound` and `detail`, and emits no second state boundary. A stale expected sequence is refused without changing the row. The event sequence is authoritative if a cache and replay disagree.
- R4. `RunSummary`, the cross-generation `RunView`, the durable `LiveRunRow` and `RunRecord` expose the same optional field for backward compatibility. Rehost and record readers reconstruct all four projection values from the durable row/event sequence; no reader uses process-local `inFlight` as authority.
- R5. While `state === working`, existing durable activity events refresh `detail` and `bound` in the same ledger transaction without adding a parallel `run_state` event. For a model run, `tool_call` uses its event time plus declared bound and `tool_result` restores the model turn's detail and bound. For a hosted ship parent, `ship_unit`/`ship_round` refresh safe detail from the folded pipeline stage and use the durable hosting lease's absolute `hosting.until` as the bound.
- R6. The server assigns admitted, fallback, preparation, working, provider wait, wrap-up and ended at the fact's existing boundary. At the ship hand-off, a hosted parent transitions from `admitted` to `working` with safe “pipeline starting” detail and the newly persisted `hosting.until`; every `hostPublish` batch then refreshes that working projection from the resulting pipeline stage and renewed hosting deadline. The `finish` route assigns `wrapping_up` before it seals `ended`. Hosted parents never wait for a model loop or provisioning transition they do not have. Provider transport recovery assigns `waiting_provider` with the current run lease's existing absolute expiry (`lease.endsAt`) and a sanitized detail, then returns to working on `provider_up` or leaves the wait when the lease ends. The provider park has no deadline of its own; no new poll or timer discovers a state.
- R7. The executor seam exposes an awaited resident observation callback narrowed by type to `waiting_deploy | waiting_repository`. The resident supplies the fact's bound and typed reason; the server stamps and assigns it through R3. The callback completes before polling/restore continues, and its attach-attempt sequence prevents a late observation from overwriting fallback, preparation, stop or end.
- R8. `liveStateWords` sits beside `endingCauseWords`, is total over R1 and is the only user wording table. The vocabulary source and generated page list all nine values as live-condition values of the run noun; `vocabulary:check` rejects internal words on a surface.

**Every surface reads the field (U2)**

- R9. The Slack and web card, run-page header and state timeline, runs index, plane run row, unit page, `runs get` and `runs list` render the one projection through `liveStateWords`. A surface may omit a suffix for space but may not reword a state. An older live writer with no field prints one neutral “state not reported” value; it never falls back to a rival derivation.
- R10. The run-page timeline renders `run_state` boundaries as history and continues to render spans as steps. A span name is never promoted to the current state; the state projection is never used to rename a historical span.
- R11. The card-only `onSetupNote`/`setSetupLabel` channel is deleted after the resident observation path is live. `RunSummary.activity`, raw span display names, `inFlight`, run notes and shape buckets stop supplying a live-condition line. Activity may remain as event/timeline content, and shape remains the finished run's retrospective accounting, but neither is a fallback for R9.
- R12. One table-driven surface test covers every state × surface cell and asserts each cell starts with `liveStateWords` for the same projection. Focused page/card tests retain layout, links, elapsed time, stop controls and accessibility while changing only the live-condition source.

**Judgements read state intervals and bounds (U3)**

- R13. `runs friction` folds adjacent `run_state` boundaries into intervals, closed by the next boundary or finish. `waiting_deploy` contributes exactly its interval to `drain_wait`; `waiting_repository` contributes exactly its interval to `infra_failure`. Repeated same-state observations do not reset `since` or double-count; a truncated stream reports incomplete timing rather than inventing an interval.
- R14. The plane's stuck flag and checkpoint steer read the current projection. A run at or before its bound is healthy and receives no stuck/long-call steer regardless of span duration or event silence; after the bound, the existing judgement may fire once under its current dedupe. A state with no bound is invalid while live, not a reason to apply a hidden default at the reader.
- R15. The heartbeat/plane facts carry the projection and its source sequence. The plane no longer derives a run judgement from open spans, `eventsLast5m`, `lastToolCallAt` or `inFlight`; those fields may remain for telemetry only if no user surface or plane decision reads them, otherwise they are deleted with their tests and spec rows.

### Scope Boundaries

- The plane queue remains record 0064's pre-admission model. A queued id keeps its position and conditions; its live-state history begins only when the row becomes admitted.
- Record 0064's ending causes and `endingCauseWords` remain authoritative. `ended.detail` points to that model; this plan does not mint a second outcome vocabulary.
- Spans remain trace/timeline units and shape remains finished-run accounting. The plan removes only their authority over the present live condition and the two named judgements.
- The existing deploy drain, resident restore/wake, provider recovery, tool bounds and hosted-parent lease renewal are unchanged. This plan reports and judges their facts; it does not change how long they wait or retry.
- Pipeline standing remains the hosted parent's unit-stage model. Its current stage is safe `working.detail`, not a tenth live state or a rival surface source; pipeline-specific rows may still render that standing beside the shared live condition.
- No new timer, polling loop, Worker, database or credential. Durable state extends the existing run-ledger row and append transaction.

### Deferred to Follow-Up Work

- A compact historical visualization of state intervals beyond the timeline rows, if the event list proves too verbose after U2.
- State-duration metrics beyond `drain_wait` and `infra_failure`; U3 changes only the two categories and the plane watches named by the record.
- Retiring pace fields from non-user telemetry if U3 proves another operational consumer still needs them; that consumer must remain observational and cannot render or judge live condition.

---

## Planning Contract

### Key Technical Decisions

- **K1. Assignment is a durable operation, not a callback side effect.** The state event and materialized projection share one ledger transaction and sequence. The registry is a cache and fan-out; it is never restart authority.
- **K2. State boundaries and projection refreshes are different facts.** `run_state` records a changed member of the closed union. Existing `tool_call`/`tool_result` events refresh a model run's working detail and bound; hosted-parent `ship_unit`/`ship_round` events refresh working detail and `hosting.until`. Both paths avoid a duplicate event stream while remaining replayable.
- **K3. The resident is a witness with a two-variant protocol.** Its awaited callback can request only deploy and repository-container waits. The server validates, stamps and serializes the request with its own assignments.
- **K4. Absolute bounds cross process boundaries.** Every writer converts a duration to one absolute deadline at assignment. Readers compare `now` to that value and never restart a duration after rehost.
- **K5. Words are data beside the ending words.** `liveStateWords` is total and shared. The projection's detail is safe input to that function, not raw refusal text a surface interpolates.
- **K6. Migration is additive, then substitutive, then judgemental.** U1 adds the source while old renderers remain; U2 switches and deletes rival renderers; U3 changes decisions only after all views expose the field. This keeps every merged head readable and rollback-friendly.

### High-Level Technical Design

`src/core/runLiveState.ts` owns the union, projection, transition validation and pure event fold. `src/core/runEvents.ts` gains `run_state`. The registry keeps the current projection and projects it through `RunSummary`; the run ledger's live row and append transaction keep the projection and sequence beside the event; `RunRecord` materializes the same field at final assembly. Dispatcher, run-loop, provider-recovery and finish boundaries call one assignment interface. The ship hand-off and coordinator host-write path call that interface too: hand-off assigns `working`, each hosted event batch refreshes stage detail and `hosting.until`, and finish advances through wrap-up to ended. The executor factory passes the resident client an awaited callback narrowed to its two observations. `liveStateWords` is exported beside `endingCauseWords`; the vocabulary's typed source renders the values table.

U2 passes that projection through `RunsService` and every seed/API shape, switches cards, commands and Vue pages to the shared words, then deletes the setup label and live uses of activity/span/shape. U3 folds `run_state` intervals in friction and replaces the plane table/heartbeat's pace judgement with state-bound comparison.

### Sequencing

U1 → U2 → U3. U2 requires the durable field and wording function. U3 requires every live row, including cross-generation rows, to expose the field before the plane can fail closed on it.

### Assumptions

- The state Worker's run-ledger mutation already executes under one Durable Object transaction and can append an event plus patch the live row atomically.
- Tool calls/results have durable timestamps and declared bounds; where an older event lacks either, the materialized projection on the live row is the compatibility source.
- Provider recovery has no park-local deadline: its row carries the run, provider and observation time, and the hold already ends on `provider_up` or the run lease. U1 projects the durable lease event's absolute `endsAt` rather than adding a retry clock.
- A hosted parent's `hosting.until` is the durable pipeline lease renewed by the existing coordinator host-write path. U1 folds the same committed `ship_unit`/`ship_round` batch into safe stage detail and updates the working projection with that exact absolute deadline; it does not create a second lease.
- The generated vocabulary page is changed through `src/docs/vocabulary.ts`/`scripts/docs-gen.ts`, never by hand inside its generated region.

---

## Implementation Units

| U-ID | Title | Key files | Depends on |
| --- | --- | --- | --- |
| U1 | The server owns one durable live state | `src/core/runLiveState.ts`, run events/registry/record/ledger, dispatcher/run loop, resident seam, wording/vocabulary | none |
| U2 | Every surface reads the live-state field | card/live views, runs and plane commands, web run/index/plane/unit pages; rival sources | U1 |
| U3 | Friction and plane watches read state intervals and bounds | `src/core/runFriction.ts`, `src/core/plane/table.ts`, `src/core/plane/decide.ts`, heartbeat facts | U2 |

### U1. The server owns one durable live state

- **Goal**: land the closed union, one ordered event, one restart-safe projection, one assignment operation, one wording table and the resident's narrowed witness protocol without changing a surface's current source yet.
- **Requirements**: R1–R8; update the applicable rows in [run-history.md](../reference/specs/run-history.md), [live-view.md](../reference/specs/live-view.md), [execution.md](../reference/specs/execution.md), [resident-repos.md](../reference/specs/resident-repos.md), [model-proxy.md](../reference/specs/model-proxy.md), [orchestration-plane.md](../reference/specs/orchestration-plane.md) and [public-hygiene.md](../reference/specs/public-hygiene.md) with exact proofs.
- **Dependencies**: none.
- **Files**: new `src/core/runLiveState.ts` and `.test.ts`; `src/core/runEvents.ts` and event/line tests; `src/core/runRegistry/state.ts`, `backlog.ts`, `projections.ts`, `src/core/runRegistry.ts` and tests; `src/core/runRecord.ts`, `src/core/dispatch/record.ts`, `src/core/runsService.ts`; `src/core/runLedger/types.ts`, `ledger.ts`, `writeThrough.ts`, `inMemory.ts`, `resume.ts`, `src/core/boot.ts` and nearest tests; `deploy/cloudflare-memory/worker.ts` and its transaction tests; `src/core/dispatch/provision.ts`, `runLoop.ts`, `ship.ts`, provider park/recovery wiring and tests; `src/channels/adminCoordinator.ts` and tests; `src/core/pipelineStanding.ts` and tests; `src/execution/factory.ts`, `resident.ts` and tests; `src/core/plane/decide.ts` for `liveStateWords`; `src/docs/vocabulary.ts`, `scripts/docs-gen.ts`, generated `docs/reference/vocabulary.md` and docs tests; the specs above.
- **Approach**:
  1. Write the union/transition/fold tests red: total state table, ended terminal, legal re-attach/provider cycles, repeated state preserving `since`, stale sequence refused, absolute bounds and capped safe details.
  2. Add `run_state` and the pure fold. Add the projection to registry, ledger row and record shapes as optional on reads, required on current admitted writes.
  3. Add one ledger assignment mutation that atomically appends the event and patches `{liveState, liveStateSeq}`; make registry fan-out happen after its acknowledgement. Route tool events through the same projection refresh transaction.
  4. Prove rehost from a killed registry returns exactly the pre-kill tuple, including an in-flight tool's detail and absolute bound; prove a stale materialized cache loses to the later event sequence.
  5. Wire model-run boundaries in lifecycle order, including the parked-provider hold. Bind `waiting_provider.bound` to the current durable lease event's absolute `endsAt`, never to the park's observation time or a new duration. Keep old renderers during this unit.
  6. Wire the lifecycle that has no model loop: the ship hand-off assigns the hosted parent `working`; `hostPublish` atomically appends its hosted events, renews `hosting.until` and refreshes working detail from `pipelineStandingOf`; finish assigns wrap-up and ended. Define a total stage-to-safe-detail mapper over `Stage`, and preserve `since` across hosted refreshes.
  7. Replace `onSetupNote` at the executor seam with the awaited, narrowed observation protocol while temporarily adapting its accepted state to the old card path if needed for U1 compatibility. Fence observations by attach-attempt sequence and await them before the client proceeds.
  8. Add `liveStateWords` and the generated vocabulary-values table. Run docs generation through the named scripts only.
- **Test scenarios**:
  - A newly admitted model run has `admitted` with its lease bound before workspace attachment begins; a queue row has no live state until admission.
  - A newly hosted ship parent moves `admitted → working` at hand-off without entering preparation; its first detail says the pipeline is starting and its bound exactly equals the durable `hosting.until`.
  - Every `Stage` value is table-tested as safe hosted detail; coding, review, fix, approved, merge-ready, merged, idle and ended events refresh `working.detail` and renew `working.bound` to the same committed `hosting.until` without resetting `since` or appending duplicate `run_state` boundaries; finish orders `working → wrapping_up → ended`.
  - Every state token has one wording; every non-terminal state has a bound; `ended` points to an existing ending cause and cannot transition.
  - A state assignment commits event + row projection before a subscriber sees it; injecting failure before commit exposes neither half.
  - Kill and rehost in each of these moments: deploy wait, repository-container wait, in-flight bounded tool, provider hold, wrapping up and a hosted parent's coding/review stage. `{state, since, bound, detail}` is byte-equal before and after; reclaiming the hosted row preserves its pipeline lease as the bound until the next host event refreshes it.
  - A provider park carrying only run, provider and observation time projects `waiting_provider.bound` exactly equal to the durable lease event's absolute `endsAt`; a repeated park and a rehost preserve it, with no park-local deadline.
  - A `tool_call` refreshes working detail/bound without a second `run_state`; its result restores the model-turn projection; replay produces the same field.
  - Drain refusal → container wake → fallback orders three transitions; a late drain observation carrying the old expected sequence is refused and cannot replace fallback.
  - The resident callback's type cannot emit admitted, working, fallback, provider, wrap-up or ended; the client awaits accepted observations before polling or returning.
  - A raw `image-stale`, `attach-failed`, `parked-provider` or gateway HTML detail never reaches `liveStateWords` output; detail caps and redaction hold.
- **Verification**: `npx vitest run` on the exact touched U1 test files; scoped root TypeScript under `NODE_OPTIONS=--max-old-space-size=6144`; prettier on changed files; `npm run docs:check`; `npm run vocabulary:check`; `npm run hygiene:check`; `npm run specs:check`; CI runs full `verify`.

### U2. Every surface reads the live-state field

- **Goal**: make every named surface render the same projection through `liveStateWords`, then delete the seven rival mechanisms as sources of a live condition while preserving trace history and finished-run accounting.
- **Requirements**: R9–R12; update exact rows in [live-view.md](../reference/specs/live-view.md), [slack-channel.md](../reference/specs/slack-channel.md), [web-chat.md](../reference/specs/web-chat.md), [run-history.md](../reference/specs/run-history.md), [command-registry.md](../reference/specs/command-registry.md), [orchestration-plane.md](../reference/specs/orchestration-plane.md) and [tracing.md](../reference/specs/tracing.md).
- **Dependencies**: U1.
- **Files**: `src/core/statusCardFrame.ts` and tests; `src/core/dispatch/provision.ts`, `reply.ts`, `runLoop.ts` and tests; `src/channels/liveView.ts`, `webSeed.ts`, `planeView.ts` and tests; `src/core/runsService.ts`; `src/core/commands/runs.ts`, `plane.ts` and tests; `src/core/plane/table.ts`; `web/src/pages/RunPage.vue`, `RunsIndexPage.vue`, `PlanePage.vue`, `UnitPage.vue` and their exact test files; hosted-parent fixtures in `src/channels/adminCoordinator.test.ts`, `src/core/runsService.test.ts` and command/page tests; `src/core/trace/displayNames.ts`, `src/core/runRegistry/projections.ts`, `src/core/runShape.ts`, `src/core/runEvents.ts` only for deleting live-source uses; the specs above and changed screenshots/fixtures.
- **Approach**:
  1. Add one table-driven surface fixture whose input is a `RunLiveState`; assert every state × surface cell derives its text from `liveStateWords` and an absent legacy field yields only “state not reported”.
  2. Switch the Slack/web card and live seeds first, then runs commands/index/page, then plane and unit rows. Keep each surface's elapsed time, controls, links and accessibility unchanged.
  3. Render `run_state` boundaries in the timeline as state history. Keep span rows below them as trace steps with `displayNameOf`; never ask an open span for the header.
  4. Delete `setSetupLabel`/`onSetupNote`; remove activity/raw span/in-flight/shape fallbacks from headers and rows. Keep `activity` only if another historical or telemetry contract still names it, and prove no live renderer reads it.
  5. Regenerate every screenshot whose input changed and attach before/after captures to that unit's pull request.
- **Test scenarios**:
  - One fixed projection renders the same leading words on Slack card, web card, run header, runs row, plane row, unit row, `runs get` and `runs list`.
  - A hosted parent in coding, review and idle renders its `working` words and safe stage detail from the one projection on every surface that lists the parent; pipeline standing remains supplemental unit data and is never substituted for a missing live state.
  - All nine states render across the matrix; compact surfaces omit only allowed suffixes and never substitute a synonym.
  - A legacy live row with no projection says “state not reported” on every surface and does not inspect an open span, setup note, activity, shape, note kind or in-flight call.
  - A deploy-wait update repaints the card immediately with its absolute bound; the setup-label API is absent from the card shell, provision context, executor factory and resident client.
  - The run header reads current state while the timeline independently shows prior state boundaries and span rows in sequence.
  - The runs index, plane and unit pages retain stop controls, lineage, links, sorting and accessible labels after their condition source changes.
  - A tree assertion finds no live-condition read of `RunSummary.activity`, `inFlight`, `formatShape`, `displayNameOf` or `RunNoteKind` in the named surface modules.
- **Verification**: `npx vitest run` on the exact touched card/channel/command/page test files; scoped root and web TypeScript under `NODE_OPTIONS=--max-old-space-size=6144`; prettier on changed files; `npm run screenshots:check`; `npm run vocabulary:check`; `npm run hygiene:check`; `npm run specs:check`; CI runs full `verify`. Human-gated: staged drain screenshots show “waiting for the deploy … until about N” on every named surface.

### U3. Friction and plane watches read state intervals and bounds

- **Goal**: derive drain/infra friction from state intervals and make stuck/steer judgements compare the current state with its own bound, then remove span, pace and in-flight derivations from those decisions.
- **Requirements**: R13–R15; update exact rows in [run-friction.md](../reference/specs/run-friction.md), [orchestration-plane.md](../reference/specs/orchestration-plane.md), [run-history.md](../reference/specs/run-history.md) and [live-view.md](../reference/specs/live-view.md).
- **Dependencies**: U2.
- **Files**: `src/core/runFriction.ts` and `.test.ts`; `src/core/plane/table.ts` and `.test.ts`; `src/core/plane/decide.ts` and `.test.ts`; `src/core/runPace.ts` and tests if pace judgement retires completely; `src/core/runLedger/types.ts`, `writeThrough.ts` and heartbeat tests; `src/core/planeService.ts`; `deploy/cloudflare-memory/worker.ts` and plane transaction tests; command/page fixtures whose health output changes; the specs above.
- **Approach**:
  1. Write interval-fold tests red over state boundaries, same-state refreshes, finish and truncation. Replace drain-note and infra-span attribution for the two categories with the interval fold.
  2. Carry `{liveState, liveStateSeq}` on heartbeat facts. Replace `runHealthOf` and checkpoint-steer inputs with a pure `stateBoundJudgement(state, now)`; preserve current dedupe and ending handling.
  3. Delete the plane's reads of spans, pace silence and in-flight bounds. Delete fields whose only remaining consumer was that judgement; if telemetry keeps one, add a negative dependency test proving the plane and surfaces do not import it.
  4. Rebind spec rows from note/span fixtures to state-event and bound fixtures, keeping old-record compatibility explicit: missing state is “no signal”, never stalled.
- **Test scenarios**:
  - `waiting_deploy` from 17:19:58 to 17:26:16 contributes 6m18s to `drain_wait`; `waiting_repository` until 17:37:59 contributes 11m43s to `infra_failure`.
  - Two same-state observations preserve the first `since` and produce one interval; a transition away and back produces two disjoint intervals.
  - A finished stream closes its last interval at finish; a truncated stream that lost an opening boundary marks timing incomplete and does not infer from a span or note.
  - Every live state at `bound - 1`, `bound` and `bound + 1` is table-tested: no stuck flag or steer inside the bound; one existing judgement after it; ended is never judged live.
  - A ten-minute attach span inside a deploy state whose bound is later remains healthy; a short span cannot suppress an over-bound state.
  - A provider hold before or at the run lease's absolute expiry is healthy and unsteered; after that bound it follows the same one-shot dedupe as other over-bound states.
  - A cross-generation heartbeat carries the exact projection and sequence; an older writer with no state reads `no-signal`, never stalled.
  - A tree/dependency assertion proves friction no longer reads `drain_wait` notes for duration and plane decisions no longer read span, `eventsLast5m`, `lastToolCallAt` or `inFlight` facts.
- **Verification**: `npx vitest run` on the exact touched friction/plane/ledger test files; scoped root TypeScript under `NODE_OPTIONS=--max-old-space-size=6144`; prettier on changed files; `npm run vocabulary:check`; `npm run hygiene:check`; `npm run specs:check`; CI runs full `verify`. Human-gated after deploy: replay the record's staged-drain trace and capture the cross-surface wording plus plane/friction outputs.

---

## Verification Contract

| Criterion | Proof |
| --- | --- |
| The closed set is total, every admitted run has one state and ended is terminal | `src/core/runLiveState.test.ts` transition-table scenarios [gap: U1] |
| State event and projection commit together before visibility | run-ledger/Worker transaction test with injected pre-commit failure [gap: U1] |
| `{state, since, bound, detail}` survives restart in every hard state | boot/rehost parameterized test over deploy, repository, tool, provider and wrap-up states [gap: U1] |
| Model working detail uses existing tool events, not duplicate state events | registry/ledger fold test over `tool_call` and `tool_result` [gap: U1] |
| A hosted parent is working across its pipeline lifecycle, with stage detail and its durable lease bound surviving restart | ship hand-off/host-write/finish lifecycle test plus hosted rehost test asserting `bound === hosting.until` [gap: U1] |
| Provider wait reuses the run lease's absolute expiry and creates no park deadline | provider park/lease fold and rehost tests asserting `bound === lease.endsAt` [gap: U1] |
| Resident observations cannot race or assign another state | resident/provision sequence-fence and type-totality tests [gap: U1] |
| One wording function covers every state without internal words | `liveStateWords` totality test; `npm run vocabulary:check` [gap: U1] |
| Every named surface reads the same field and wording, including hosted parents | state × surface matrix plus focused model-run and hosted-parent card/command/page tests [gap: U2] |
| Rival live-condition sources are absent | U2 tree/dependency assertion; `npm run specs:check` over rebound rows [gap: U2] |
| Timeline keeps state history and span steps separate | run-page timeline test with interleaved state and span events [gap: U2] |
| Drain and repository waits become exact friction intervals | `src/core/runFriction.test.ts` minute-by-minute fixture [gap: U3] |
| Plane stuck/steer waits for the state's own bound and never spans | plane table/decider bound-edge matrix and negative dependency assertion [gap: U3] |
| The incident is legible everywhere | human-gated staged-drain replay and screenshots after U3 [gap: U3] |

Every unit runs the fast gates at changed-set scope: `npx vitest run` on touched test files by exact path; the touched tsconfig's `tsc --noEmit` under `NODE_OPTIONS=--max-old-space-size=6144`; `npx prettier --check` on changed files; `npm run hygiene:check`; `npm run specs:check`; and `npm run check:pr-title -- "<title>"`. CI alone runs the full suite, full typecheck and `npm run verify` after the push.

## Definition of Done

- U1, U2 and U3 are merged in order with their exact spec proofs.
- Every admitted live run projects one durable state, including hosted ship parents from hand-off through finish; a restart preserves all four projection values; only the resident's two witnessed waits cross the executor seam, through the awaited sequence-fenced callback.
- Every named surface reads the field through `liveStateWords`; the setup label and live-condition uses of activity, spans, notes, shape and in-flight tracking are gone.
- Friction's two categories equal state intervals, and the plane's stuck/steer judgements compare state bounds without span or silence inference.
- `npm run vocabulary:check`, `npm run hygiene:check`, `npm run specs:check` and CI's full `verify` pass on each unit; the staged-drain receipt shows the same wait and bound on every surface.
