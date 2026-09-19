---
title: A hosted pipeline run is an orchestrator on every surface - Plan
type: feat
date: 2026-09-19
status: proposed
artifact_contract: ce-unified-plan/v1
artifact_readiness: implementation-ready
product_contract_source: ce-plan-bootstrap
execution: code
extends: ../decisions/0065-a-hosted-pipeline-run-is-an-orchestrator-every-surface-reads-its-standing-from-its-own-events-never-from-a-model-runs-signals.md
---

# A hosted pipeline run is an orchestrator on every surface - Plan

## Goal Capsule

- **Objective**: Build [record 0065](../decisions/0065-a-hosted-pipeline-run-is-an-orchestrator-every-surface-reads-its-standing-from-its-own-events-never-from-a-model-runs-signals.md): one pure fold of a hosted parent's `ship_unit` and `ship_round` events yields the pipeline's standing, carried by the registry summary, the ledger view and the record; the runs index draws a hosted head as a pipeline row with its children behind a caret and a pace cell that borrows or reads `waiting`; the run page and the home turn draw a hosted run as a pipeline page (board, stage buckets, runner's log, waiting row); the card and the unit page adopt the stage words.
- **Authority**: record 0065 (proposed; this plan is the artifact its acceptance is judged on) over [live-view.md](../reference/specs/live-view.md) items 12, 13, 19, 20, 21, 22, 25, 28, 32, 33 and the two items this plan opens, [agent-ship.md](../reference/specs/agent-ship.md) items 12 and 17 and the standing item it opens, [run-history.md](../reference/specs/run-history.md) item 19 and the record's field rows, [tracing.md](../reference/specs/tracing.md) item 5, [web-chat.md](../reference/specs/web-chat.md) item 2, [command-registry.md](../reference/specs/command-registry.md) for the `runs get` fixtures.
- **Execution profile**: six code units in this repository, each one pull request through the review loop, tests first in every unit. U1 is the remainder of #1960 and touches the web bundle alone. U2 is invisible to a person: the fold, the field on three carriers, the route fix #1968, `runs get`, the shadow diff. U3 to U5 are the visible surfaces, each with regenerated screenshots. U6 adopts the words elsewhere and takes the record notes. No infrastructure change, no configuration key, no new event type, no runner behaviour change beyond the route's accepted list.
- **Stop conditions**: a unit that needs a new run event type, a store read on the index's upsert path or on the live seed, a timer, or a change to the card's shape hands back a deviation before changing anything.
- **Tail ownership**: each pull request merges through the review loop under the freeze's rules in force; the before and after screenshots are the maintainer's to approve on U3, U4 and U5; the shadow diff's count is posted on the receipts issue of live-view.md.

---

## Product Contract

### Summary

Record 0060 made a ship pipeline's parent a live run for its whole life; both surfaces that show runs still render it as a model run, so its page reads `22m 51s — Switchboard overhead` and `Ruminating…` for a run whose whole life was a coding child's work, and its index row, since #1939 no longer falsely stalled, says nothing at all about the stage the work is in. The record holds the survey, the measurements, the trace and the argument; this plan holds the units.

### Problem Frame

A hosted parent runs no model, so the pace rule, the thinking verbs, the model chip and the thinking and tools buckets are empty or false on it. The runner's `ship_round` and `ship_unit` events, which say exactly what stage each unit is in, are drawn twice or not at all by the page's fold, `ship_round` names no unit, and the record stores no standing.

### Requirements

**The hosted row's pace cell (record 0065, "The pipeline row and the collapsed index"; U1)**

- R1. `inheritedPace(group, now)` in `web/src/lib/indexRow.ts` returns the pace text of the group's newest live child on the page; with none it returns `waiting on the runner` when the head's standing is `approved` (U1 lacks the standing and returns it whenever no child is live; U3 gates it) and nothing otherwise; the pipeline row's pace cell renders it for a live hosted head; a finished head renders nothing.
- R2. The tooltip on the borrowed cell names the child; on `waiting` it says the runner is between children and nobody judges the gap here.
- R3. live-view.md item 32 gains the borrowing rule in one sentence.

**The standing fold and its carriers (record 0065, "The standing fold"; U2)**

- R4. `src/core/pipelineStanding.ts` is node-free and pure: `pipelineStandingOf(events)` returns `{ units: PipelineUnit[], unnamedRounds: RoundRow[], changes: StandingChange[] }`, a unit being `{ unit, stage, round, segment, since, pr?, threadKey?, detail? }` with `stage` from the closed union `coding | review | fix | approved | merge-ready | merged | idle | ended`; the mapping, the adjacency binding (a round binds to the `ship_unit` published next at the same stamp; that companion contributes only `pr` and `threadKey`, never a stage), the reopen rule for idle and continued units and the totality rule are the record's; the plan's unit total is not derivable and is not returned.
- R5. `summaryOfStanding(standing)` gives `PipelineSummary { current: PipelineUnit[], counts: Record<Stage, number>, total: number }`; the registry folds in `appendToBacklog` beside `instanceId`, so `publish()` and the re-host replay both carry `RunSummary.pipeline`; `ledgerView()` in `runsService.ts` folds the mirrored events into `RunView.pipeline`; `assembleRunRecord` stores `RunRecord.pipeline` and `RunRecord.hosted` at the seal, the record validator accepts both, and `RunsService` projects them onto the record's row; a record without the fields projects neither.
- R6. `ROUND_OUTCOMES` in `adminCoordinator.ts` gains `continued` and `idle` and is pinned to `ShipRoundOutcome` by a type-level exhaustiveness check; a test posts a `continued` round and asserts 200 with `at` (#1968; the `idle` outcome has no emitter until record 0051's wake).
- R7. `runs get` prints the standing under the meta block on every surface; the command's fixtures and run-history.md item 19's field list take the rows; nothing a dashboard reader sees changes in U2.
- R8. `scripts/pipeline-standing-diff.ts`, run by hand over the records the MCP lists, folds each finished record and compares every unit's final stage with the card's ending or idle word for it under the record's mapping (the only state the instance store holds independently of the events); its count is posted on the receipts issue before U3 is seeded.

**The pipeline row and the collapsed groups (record 0065, "The pipeline row and the collapsed index"; U3)**

- R9. A hosted row carrying `pipeline` renders the standing in the count cell's place: `U1 coding · round 1 · #412`, `no PR yet` before a pull request, `U3 · 2 merged · coding` for a plan (the units seen, never the plan's total), `round 2 · review` for an unnamed round; the cell links to the unit's page; a hosted row without `pipeline` renders as today.
- R10. The `waiting on the runner` text renders only when the head's standing is `approved`; a child-bearing stage with no live child on the page renders an empty cell.
- R11. A head with children carries a caret, a `<button aria-expanded>` with its own pointer events and a count (`▸ 2 runs`, `· 1 leaving` when a child is inside the expiry window); children render only while open; a group with a stalled child renders open; the open state is component state; the narrow layout gives the caret and the standing cell the count cell's slots.
- R12. A nested child row hides its source, requester and repository cells and leads with the agent chip.
- R13. `runsIndex.test.ts`'s nested contract is rewritten for the collapsed default; live-view.md items 20, 21 and 33 take their rows (item 33's invariant sentence per the record) and a new item states the pipeline row; the runs index screenshots regenerate.

**The pipeline page and the home turn (record 0065, "The pipeline page"; U4)**

- R14. `RunLiveSeed` gains `hosted` from the registry meta and `RunHistorySeed` from `RunRecord.hosted`; `RunPage.vue` and `AssistantTurn.vue` branch on it instead of the missing `stopUrl`.
- R15. The header draws the agent chip, the label, `pipeline` in the model's slot and the elapsed; no model, no effort, no stop control.
- R16. `RunUnitsBlock` draws live and finished from the fold: one row per unit in order of appearance with its stage chip and `since` elapsed, round, pull request, thread and, for a live child on this registry, its link with its pace; the live seed's children filter gains `s.parentInstanceId === summary.instanceId`; titles, branches, idle facts and the plan's not-yet-started units (`queued`) come from `GET /api/runs.unit`, fetched after mount and on each `ship_unit` or `ship_round` event, never on the seed; a board without the listing (a viewer holding only the run's capability token, or a process without the coordinator's records) draws the fold's units and says so in one line.
- R17. `runTimeline.ts` gains its `ship_round` case and the adjacency binding; the runner's log replaces the steps list: the intake spans folded into one row with a disclosure, then one row per fold change with its stamp and link; the heading's count counts changes.
- R18. `liveWait` gains the kind `child`; the last row reads `waiting on <unit> <stage> · <elapsed> ›` or `waiting on the runner · <elapsed>`; `thinkingVerb` is never called for a hosted seed, on the page or the home turn.
- R19. On a live hosted run every `answer` is a log row; the Reply card draws once the run is finished, with the last `answer`.
- R20. live-view.md items 12, 13, 19 and 22 take their hosted rows, web-chat.md item 2 its sentence, and a new live-view item states the pipeline page; record 0060 takes its dated note replacing the assumption that the page draws `ship_unit` as steps without a view model; the run page and home screenshots gain a hosted fixture.

**Stage buckets (record 0065, "The pipeline page"; U5)**

- R21. `buildTimeline` in hosted mode buckets the window by stage from the fold's stamps, one unit at a time, plus `Switchboard` for the intake and any gap before the first unit's start and `idle` as its own bucket, through `printedShape` generalized over a variable term list (today it takes a six-field partition and names the residual itself); live, the open stage is the drill-down; a truncated record's early gap lands in `not loaded`.
- R22. `PrintedTerm`, `TERM_PAINT` and `TERM_DEFINITIONS` gain the stage words; live-view.md item 25 and tracing.md item 5 take their hosted sentences; the pipeline page screenshot regenerates.

**Adoption of the words and the record notes (record 0065, "Boundaries"; U6)**

- R23. `unitLines` in `adminCoordinator.ts` and the unit page's standing chip use the stage words; the card's shape does not change; agent-ship.md item 12 and live-view.md item 28 take the rows.
- R24. Record 0063 takes a dated note that a hosted record's point stores its wall as `overhead` until the schema record 0064 claims; record 0064 takes a dated note that the plane's unit health words are a different axis from the stage and that its table's stall read is moot for hosted rows after #1939; record 0065 flips to `accepted` with the shadow diff's count and the screenshots as receipts.

### Scope Boundaries

- No new event type, no new store, no configuration key, no timer; the page's re-read is event-driven and the live seed stays store-free.
- No change to the unit page's layout, the card's shape, the conductor's stall rule, or the runner's behaviour beyond the route's accepted list.
- Judging a childless gap and the person's merge after a merge-by-a-person ending are record 0064's.

### Deferred to Follow-Up Work

- Persisting the caret's open state across reloads (decided not; revisable after a week on U3).
- The runner's poll count on the `waiting on checks` cell, if a month of records puts the wait's 90th percentile past the review lease.

### Open Questions

None open; two decided with a default and revisable in the record's row section: caret persistence (not persisted), the standing cell's link target (the unit page).

---

## Planning Contract

### Key Technical Decisions

- **One fold, three carriers.** `pipelineStandingOf` is the only reader of `ship_round` and `ship_unit` for standing; the registry (`appendToBacklog`), the ledger view and the record assembly call it, as each carries `instanceId` today. Rationale: the row must read the same on every row source, and only the parent's events are present on all three; the record stores the result because its row is metadata the store lists without events.
- **Key on `ship_unit`, bind `ship_round` by adjacency.** The round names no unit; the unit event published next in the same batch does (161 of 161 in the sample).
- **Withhold, do not fake.** A hosted row and seed get no pace, stall, model, verb or model bucket, rather than a substitute another reader could mistake for a measurement.
- **The board's stage never waits on the listing.** Stage, round and pull request are the fold's; title, branch, idle facts and the plan's queued units are the listing's, fetched after mount and per event; the seed stays store-free.
- **Units are sequential.** The driver runs one unit at a time, so each instant belongs to one stage and the buckets sum by the existing floor-and-residual rule.

### High-Level Technical Design

`src/core/pipelineStanding.ts` (new, node-free) exports `Stage`, `PipelineUnit`, `StandingChange`, `pipelineStandingOf`, `summaryOfStanding`. `src/core/runRegistry/backlog.ts` folds in `appendToBacklog`; `projections.ts` projects `pipeline`. `src/core/runsService.ts`: `ledgerView()` folds mirrored events; the record row projects `RunRecord.pipeline`. `src/core/dispatch/record.ts` stores `pipeline` and `hosted` at assembly; `src/core/runRecord.ts` validates them. `src/channels/adminCoordinator.ts`: `ROUND_OUTCOMES` pinned; `unitLines` adopts the words (U6). `src/channels/webSeed.ts`: `hosted` on both seeds; `src/channels/liveView.ts`: the children filter. `web/src/lib/indexRow.ts`: `inheritedPace`, `rowStandingText`, `groupOpen`; `RunRow.vue`, `RunsIndexPage.vue`: caret, standing cell, nested trims. `web/src/lib/runPageModel.ts`: the `child` wait, the hosted log, the Reply rule; `src/channels/runTimeline.ts`: `ship_round`; `web/src/lib/timelineVm.ts`, `termPaint.ts`: hosted buckets; `RunPage.vue`, `AssistantTurn.vue`, `RunUnitsBlock.vue`: the hosted branch. `web/src/pages/UnitPage.vue`: the words (U6).

### Assumptions

- The registry meta carries `hosted` on every hosted parent (record 0060 unit three; `runsService.ts` line 191 reads it) and the seeds can copy it.
- `GET /api/runs.unit` admits the Access actor's `runs:read` grant (`src/core/commands/runs.ts` lines 359 to 372; `src/channels/commandHttp.ts`), not the run's capability token, and costs two store reads plus two thread listings per call, acceptable at the runner's event cadence; a token-only viewer gets the fold's board.
- The runner publishes a round's `ship_round started` on the spawn's answer, so a child may appear on the index a moment before its parent's stage says so; the row borrows its pace regardless.

## Implementation Units

| U-ID | Title | Key files | Depends on |
|---|---|---|---|
| U1 | The hosted row's pace cell borrows its live child's pace and reads `waiting` | `web/src/lib/indexRow.ts`, `web/src/components/runs/RunRow.vue`, `web/src/pages/RunsIndexPage.vue`, `docs/reference/specs/live-view.md` | — |
| U2 | The standing fold, the field on three carriers, the route fix, `runs get`, the shadow diff | `src/core/pipelineStanding.ts`, `src/core/runRegistry/backlog.ts`, `src/core/runRegistry/projections.ts`, `src/core/runsService.ts`, `src/core/dispatch/record.ts`, `src/core/runRecord.ts`, `src/channels/adminCoordinator.ts`, `src/core/commands/runs.ts`, `scripts/pipeline-standing-diff.ts`, `docs/reference/specs/agent-ship.md`, `docs/reference/specs/run-history.md` | — |
| U3 | The pipeline row and the collapsed groups | `web/src/lib/indexRow.ts`, `web/src/components/runs/RunRow.vue`, `web/src/pages/RunsIndexPage.vue`, `web/src/pages/runsIndex.test.ts`, `docs/reference/specs/live-view.md`, screenshots | U1, U2 |
| U4 | The pipeline page and the home turn | `src/channels/webSeed.ts`, `src/channels/liveView.ts`, `src/channels/runTimeline.ts`, `web/src/pages/RunPage.vue`, `web/src/components/home/AssistantTurn.vue`, `web/src/lib/runPageModel.ts`, `web/src/components/run/RunUnitsBlock.vue`, `docs/reference/specs/live-view.md`, `docs/reference/specs/web-chat.md`, `docs/decisions/0060-*.md`, screenshots | U2 |
| U5 | Stage buckets in Where the time went | `web/src/lib/timelineVm.ts`, `web/src/lib/termPaint.ts`, `src/core/trace/partition.ts`, `web/src/components/run/TimelineSection.vue`, `docs/reference/specs/live-view.md`, `docs/reference/specs/tracing.md`, screenshots | U4 |
| U6 | The card and the unit page adopt the stage words; the record notes | `src/channels/adminCoordinator.ts`, `web/src/pages/UnitPage.vue`, `docs/reference/specs/agent-ship.md`, `docs/reference/specs/live-view.md`, `docs/decisions/0063-*.md`, `docs/decisions/0064-*.md`, `docs/decisions/0065-*.md` | U2, U3, U4, U5 |

### U1. The hosted row's pace cell borrows its live child's pace and reads `waiting`

- **Scope**: R1 to R3. Tests first: `indexRow.test.ts` asserts `inheritedPace` returns the newest live child's text, `waiting on the runner` with none, and nothing for a finished head; `runsIndex.test.ts` asserts the cell on a hosted head. Then the code and item 32's sentence.
- **Blast radius**: the index only; a hosted head under another generation whose children carry no pace facts reads `waiting`, as its children's own cells are empty.
- **Validation**: the two tests, run by name with the changed set's typecheck and formatting; the live receipt is the index cell on a pipeline in flight, posted on #1960.

### U2. The standing fold, the field on three carriers, the route fix, `runs get`, the shadow diff

- **Scope**: R4 to R8. Tests first: `pipelineStanding.test.ts` pins both unions (a compile-time exhaustive switch and a runtime table), the adjacency binding with two units interleaved, a companion whose state is an ending word (`aborted`, `continued`) leaving the stage alone, the reopen after idle and continued, the unnamed rounds of an older record, a unit adopted at review with no round 0, the `since` stamps; `runsService.test.ts` feeds one event list through the registry summary (publish and replay), the ledger view and an assembled record and asserts one standing; `adminCoordinator.test.ts` posts a `continued` round; the `runs get` fixtures on every surface. Then the spec rows: agent-ship.md gains the standing item; run-history.md item 19 and the record's field rows.
- **Blast radius**: additive fields; the route accepts two more words; `runs get` output gains a block (fixtures update); nothing a dashboard reader sees changes.
- **Validation**: the tests; the shadow diff's count over the sampled records, posted on the receipts issue; a class of disagreements amends the record before U3 is seeded.

### U3. The pipeline row and the collapsed groups

- **Scope**: R9 to R13. Tests first: `indexRow.test.ts` for `rowStandingText` on one unit, a plan, an unnamed round and a row without `pipeline`; `runsIndex.test.ts` rewritten for the caret, the count, children absent until opened, a stalled child's group open, nested cells hidden, the button's `aria-expanded`. Then the components, the spec rows, `npm run screenshots:gen` for the runs index surfaces.
- **Blast radius**: every group on the index, conductors included, collapses by default.
- **Validation**: the tests; before and after screenshots on the pull request (human-gated).

### U4. The pipeline page and the home turn

- **Scope**: R14 to R20. Tests first: `runPage.test.ts` with a hosted fixture (the record's trace as events) asserts the header's slot, the board's rows and stage chips before and after the listing arrives, the log's rows one per change, the `child` waiting row, every live `answer` as a log row and the finished last `answer` as the Reply, and the absence of a model chip and thinking verb; `assistantTurn.test.ts` (new) the same for the home turn; `runTimeline.test.ts` for the `ship_round` case and the binding; `liveView.test.ts` for `hosted` on both seeds and the children filter. Then the code, the spec rows, record 0060's note, the hosted fixtures in `screenshots:gen`.
- **Blast radius**: `RunPage.vue` and `AssistantTurn.vue` branch on `hosted`; a model run's page and turn are unchanged (their snapshots pin them).
- **Validation**: the tests; before and after screenshots (human-gated); a live receipt on a pipeline in flight, posted on the receipts issue.

### U5. Stage buckets in Where the time went

- **Scope**: R21 and R22. Tests first: `timelineVm.test.ts` for the hosted mode: buckets sum to the total, the idle bucket, the live drill-down, the truncated record's `not loaded`. Then the paint tokens, the spec sentences, the screenshot.
- **Blast radius**: the timeline section on hosted pages only; `PrintedTerm` widens for every consumer.
- **Validation**: the tests; the screenshot (human-gated).

### U6. The card and the unit page adopt the stage words; the record notes

- **Scope**: R23 and R24. Tests first: `adminCoordinator.test.ts` for `unitLines`' words and `unitPage.test.ts` for the chip. Then the spec rows and the three record notes, and record 0065's acceptance with its receipts.
- **Blast radius**: the words on the card's unit lines; the unit page's chip.
- **Validation**: the tests; the card's live receipt on a unit thread, posted on the receipts issue.

## Verification Contract

The record's validation criteria, each bound to the test its unit lands:

| Criterion | Proof |
|---|---|
| A live hosted head borrows its newest live child's pace, reads `waiting on the runner` when approved with none, and stays empty otherwise | `web/src/lib/indexRow.test.ts::a hosted head borrows its newest live child's pace or waits on the runner` [gap: unit one] |
| The fold binds rounds by adjacency, takes no stage from a companion, is total over both unions, keeps idle and continued units open | `src/core/pipelineStanding.test.ts::the fold binds rounds by adjacency, ignores a companion's state and is total over the unions` [gap: unit two] |
| The three carriers hold one standing for one event list, replay included | `src/core/runsService.test.ts::the registry summary, the ledger view and the record carry one standing` [gap: unit two] |
| The fold's final stages agree with the card's ending words over the sampled records | agent-runnable: `scripts/pipeline-standing-diff.ts`, its count posted on the receipts issue [gap: unit two] |
| The round route accepts every `ShipRoundOutcome` | `src/channels/adminCoordinator.test.ts::the round route accepts continued and idle` [gap: unit two] |
| Groups collapse behind an accessible caret, a stalled child opens its group, every run is one click away | `web/src/pages/runsIndex.test.ts::a group collapses behind its caret and a stalled child opens it` [gap: unit three] |
| The pipeline page and the home turn draw no model-run signal and draw the board from the fold alone | `web/src/pages/runPage.test.ts::a hosted seed draws the board, the runner's log and the waiting row and no model-run signal`; `web/src/components/home/assistantTurn.test.ts::a hosted turn draws no model or verb` [gap: unit four] |
| Stage buckets sum to the header's total, live and finished, idle included | `web/src/lib/timelineVm.test.ts::hosted buckets are the stages and sum to the total` [gap: unit five] |
| The card's unit lines and the unit page's chip use the stage words | `src/channels/adminCoordinator.test.ts::a unit line wears its stage word` [gap: unit six] |
| Before and after screenshots of the index, the pipeline page and the home turn | human-gated, on the pull requests of units three, four and five |

- Every unit: the changed set's own gates — `npx vitest run` on the touched test files by name, `npm run typecheck` (or `tsc --noEmit -p` the touched tsconfig), `npm run format:check` on the changed files, `npm run specs:check` — plus the fixtures it touches regenerated by their `gen`, `npm run hygiene:check`, `npm run check:pr-title`; the full suite and `npm run verify` are CI's on the push.
- U3 to U5: `npm run screenshots:check` clean after `screenshots:gen`; before and after pairs on the pull request.
- Record 0065's validation table binds each criterion to the test id each unit lands; the shadow diff count and the screenshots are its acceptance receipts.

## Definition of Done

- The six pull requests are merged and live; a hosted pipeline on `/runs` reads its unit, stage, round and pull request on one row with its runs behind a caret and a pace cell that borrows or waits; its page and its home turn read the board, the stage buckets and the runner's log with no model-run signal; the card and the unit page say the stage words; records 0060, 0063 and 0064 carry their notes and record 0065 is `accepted` with its receipts.
