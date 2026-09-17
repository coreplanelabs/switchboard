---
title: Budgets are leases - the module, the fit and the wind-down inside the lease - Plan
type: feat
date: 2026-09-17
status: proposed
artifact_contract: ce-unified-plan/v1
artifact_readiness: implementation-ready
product_contract_source: ce-plan-bootstrap
execution: code
extends: ../decisions/0046-a-budget-is-a-lease-carved-from-its-parent-and-one-module-proves-the-leases-fit.md
---

# Budgets are leases - the module, the fit and the wind-down inside the lease - Plan

## Goal Capsule

- **Objective**: Units one and two of [record 0046](../decisions/0046-a-budget-is-a-lease-carved-from-its-parent-and-one-module-proves-the-leases-fit.md): one module owns every wall-clock number as a lease carved from its parent, one fit is asserted at verify, at config load and at the fork, and a run's lease covers its loop, its write-up and its post-steps, enforced at the model proxy, with the pushed head recorded on the row. Unit three of the record (the grant and renewal) is out of scope and held as direction.
- **Authority**: record 0046 (accepted for units one and two) over the specs it touches; the specs over this plan where they disagree on today's behavior; this plan over the executing agent on sequencing and file boundaries.
- **Execution profile**: eight units in two phases, each one pull request through the review loop, in dependency order. Tests first in every unit. Every unit updates the spec rows it changes in the same pull request and binds them (`file::describe::it`). The maintainer chose the session, not the ship runner, as the executor.
- **Stop conditions**: a unit that cannot pass `npm run verify` within its listed files hands back a deviation. Nothing here adds a Worker, a binding, a credential or a config key beyond the fit's refusal. A unit that would change a preset's ask, or turn renewal on, stops and asks. The shell-kill unit does not start until the abort probe has an answer.

---

## Product Contract

### Summary

Every wall-clock number that bounds a run, a round, a wait or a leaf call becomes a row of `src/core/budgets.ts` or a value derived from one. A child round's minutes are carved from the parent's remainder minus a reserve derived over the longest loop the config allows, and refused under the round's floor. One fit predicate is asserted three times over that one table. A run's lease is the whole promise: the loop ends early enough for the write-up and the post-step to finish inside it, the proxy admits only the write-up and the post-step turns after the loop's end, the shell in flight is killed, and the pushed head is recorded with its sha.

### Problem Frame

Production set the ship pipeline to 40 minutes while the coding preset asked 45 and nothing compared the two; twelve ship children in a day ended at a clipped budget with finished, unpushed work. The numbers live in six files with no stated relation, the deadline is a negotiation of three constants rather than a stop, pi's shell has no clip, and the row records no pushed sha for a continuation to read. The record's audit and measurements are recorded on the tracker issue for the wind-down abort.

### Requirements

**The module and the fit (record unit one)**

- R1. `src/core/budgets.ts` declares the preset asks, the per-round floors and the named allowances, and is node-free and registry-free: the agent registry imports it, never the reverse, so the Workflow-driven coordinator can import it too.
- R2. A round's reserve is derived, not tabled: the floors plus provisioning of every round that must follow it in the longest loop the config allows, plus the merge wait's floor.
- R3. `carve(remainingMs, round, loop)` is the only place a round's minutes are computed, where `round` is the round's position in the loop, its kind and its index, so the reserve is the rounds after that index; it returns the minutes with what bounded them and what the parent held back, or a refusal under the floor. The ship coordinator, the fork and the conductor's spawn call it.
- R4. The fit `maxMinutes ≥ provision + ask(coding) + reserve(coding)` is asserted over the one table at three sites: a verify-time test over the registry's pipelines, `validateShip` at config load replacing the floor of 14, and the ship fork over a request whose minutes a boundary or `budget:` clipped, which refuses with the sum on the card.
- R5. The merge wait is a round with an ask and a floor, carved like any other; the dispatch gate, the wait margin and the wait chunks are module rows.
- R6. A child's card names the carve: what it was carved from and what the parent held back.
- R7. Every preset's `maxTurns` equals `runawayTurnCap(ask)` with ship's structural 1 exempt, asserted where the fit is.
- R8. A duration-literal ratchet, a second class beside the wall-clock-read ratchet, lists every minutes-scale literal outside the module and only shrinks.

**The lease covers everything the run does (record unit two)**

- R9. A run's loop ends at `deadline − (writeUp + postStep(preset))`, where a preset with no post-step turn has a post-step allowance of 0; the wind-down warning derives from that loop end; the write-up and the post-step turn run inside the lease; the bearer's grace past the deadline is one minute.
- R10. After the loop's end the model proxy admits only a request whose tool table is empty or a subset of the run's post-step tools (the description and verdict submit tools the grant lists) and refuses a request offering a workspace tool with a typed `time_budget_exhausted` note, on both harnesses; the harness strips the tool table from the write-up turn so the rule holds for the real calls, not a synthetic body.
- R11. At the loop's end a shell command in flight is ended without killing the harness process that must still write up; the pushed work from the wind-down note is not lost to the kill.
- R12. A coding run's push is recorded on the row as a typed event with ref and sha, whether or not a pull request opens, and the record's pushed-branch reads use it.
- R13. The floors for coding and the merge wait, the post-step allowance and today's `review pending` rate are read from the ledger before the numbers that depend on them ship.

### Scope Boundaries

- Out of scope: the grant, renewal and segments (record unit three); the cost cap's enforcement (the orchestration plan's row); any change to a preset's ask.
- Landed already and built upon, not re-planned: the wind-down owning the ending and the salvage push (`salvageBudgetPush`, the `budget_salvage` note, the `budgetBeforeModelCall` and `failModelCall` conformance hooks), and the checks-by-cost rule with the contract's push-early first instruction.
- In scope through U2: the conductor's spawn, the third carve caller the record names, takes the floor refusal and the provisioning allowance with no reserve, since a conductor runs no fixed loop.
- Deferred to follow-up work: retargeting the hand-written budget copies in `docs/explanation/agents-and-toolsets.md` and the how-to pages once the asks are read from the module (no check catches their drift today); a `budgets` scope in the code map if the module grows a second file.

---

## Planning Contract

### Key Technical Decisions

- KTD1. The module is node-free and registry-free, and the dependency runs `registry.ts → budgets.ts` (session-settled: user-directed — chosen over a registry-side table: the coordinator is Worker-importable and reaches nothing node-bound, so the tables must live below the registry; `src/execution/bashTimeout.ts` is the precedent).
- KTD2. `bashTimeout.ts`'s constants (`RUN_DEADLINE_RESERVE_MS`, `EXEC_CALL_MARGIN_MS`, the bash caps) move into the module as the `commandWriteUp` and `execCall` allowances; `bashTimeout.ts` imports them. One module, not two in embryo.
- KTD3. The coordinator imports the asks and floors from the module and `UnitPipelineInput.childMinutes` is removed, because the module is node-free (chosen over keeping the numbers in the input: two sources for one number is the defect this plan removes; the instance record's `caps` stays).
- KTD4. The fork refuses a clipped ship request under the fit with the sum on the card (session-settled: user-directed — chosen over clip-and-warn: a pipeline that cannot hold its loop is a misconfiguration, and the person widens the budget or picks `agent:coding`).
- KTD5. The duration ratchet is a second predicate list, allowlist, scan and script beside the wall-clock-read ratchet, with its own ESLint block exempting `src/core/budgets.ts`; the existing `clockAllowlist.json` stays `{}` (chosen over widening the existing scanner: its scan collapses to one integer per file and its allowlist is asserted empty).
- KTD6. The pushed head is a typed run event, `pushed_head { ref, sha }`, published from the post-step's push facts (chosen over a row field: the row's pushed-branch reads derive from events, and the event replays on the run page).
- KTD7. Post-steps run inside the lease by carving from the remaining lease through `HarnessRun` and `FollowUpTurnInput`, not by lowering their caps (chosen over a smaller constant: a constant is the shape the record retires).
- KTD8. The proxy learns the loop's end from the bearer store (`markLoopEnded(runId)`) set by the harness, and tests a request's tool table by reading its body beside `pinRequest`; after the loop's end a request offering any tool outside the grant's post-step tool list is 403 with a `time_budget_exhausted` note (chosen over a header from the harness: the store is the source of truth the door already consults). The mark rides the run's row so `adopt` on a bot generation change carries it forward like the bearer hash.
- KTD9. Unit two sequences after the merged wind-down and checks-by-cost changes and builds on them (session-settled: user-directed — chosen over an independent landing).
- KTD10. The floors are `review 5` (measured), `coding 10` and `merge 10` (guesses), the allowances `provision 3`, `writeUp 3`, `postStep 5` for coding, `3` for review and `0` for every preset that runs no post-step turn (general, research, explore, conductor), `commandWriteUp 1`, `execCall 0.5`, `bearerGrace 1`; the guesses ship in unit one behind the fit and are re-read in the measurement unit before the wind-down ships.

### High-Level Technical Design

```mermaid
flowchart LR
  B[src/core/budgets.ts<br/>asks · floors · allowances<br/>reserve(round, loop) · carve · fit]
  R[agents/registry.ts<br/>maxMinutes, maxTurns filled from B] --> B
  C[ship/coordinator.ts<br/>carve per round · floor refusal · merge wait carved] --> B
  V[config/validate.ts validateShip<br/>fit over the deployment] --> B
  F[dispatch/ship.ts fork<br/>fit over a clipped request] --> B
  P[dispatch/provision.ts card<br/>budget N min carved from X; holds Y] --> B
  T[budgets.check.test.ts<br/>fit · reserve sum · stack · turns] --> B
  D[trace/durationScan<br/>second ratchet, shrinks only] -.exempts.-> B
```

The wind-down's clocks, all carved from one lease:

```mermaid
sequenceDiagram
  participant H as harness (pi / OpenCode)
  participant X as model proxy
  participant S as shell in flight
  participant L as run loop post-steps
  Note over H: lease starts after attach; row records leaseStartedAt
  H->>H: warnAt = loopEnd − writeUp
  H->>S: at loopEnd: end the command (shape from the probe)
  H->>X: markLoopEnded(runId)
  X-->>H: tool-carrying call → 403 time_budget_exhausted
  X-->>H: tool-less write-up call → admitted
  H->>L: answer; description turn carved from remaining lease
  L->>L: pushed_head {ref, sha} published from the push facts
  Note over X: bearer expires deadline + bearerGrace (1 min)
```

### Sequencing

Phase A (record unit one): U1 → U2 → U3, each a pull request; U3 may land after Phase B starts. Phase B (record unit two): U4 first (measurements and the abort probe; no product code; its ledger reads may start as soon as U1 merges, beside U2 and U3), then U5 → U6 → U7 → U8. U7's shape depends on U4's answer. Every unit rebases onto the merged wind-down and checks-by-cost changes.

### Risks and Dependencies

- The ratchet's starting allowlist is 146 literals in 83 files; U3 lists them, it does not clean them. A unit that tries to also relocate them balloons.
- Test titles encode the asks (`coding 270 in 45 …`); no ask moves in this plan, so the titles stand. A later ask change is a spec change by the existing rule in harness-pi item 15.
- Whether pi's abort ends its tool's process group is unknown; U7 is shaped by U4's answer and does not start before it.
- `shipPipeline.ts`'s exact export list is pinned by `src/core/ship/surface.test.ts`; moving `SHIP_LOOP_RESERVE_MS` and `SHIP_MIN_MAX_MINUTES` updates that scan in the same commit.
- Adding a run event kind ripples to every exhaustive switch (`runEventLines.ts`'s validator drops an unvalidated kind silently); U8 lists the sites.
- `agents:check` refuses an undescribed npm script: any new script lands with its `project.json` description.

---

## Implementation Units

### U1. The module, the registry filled from it, and the verify-time fit

- **Goal**: `src/core/budgets.ts` exists with the asks, floors, allowances, the derived reserve, `carve` and `fit`; the registry and `bashTimeout.ts` read from it; a verify-time test asserts the fit, the reserve sum, the stack and the turn derivation.
- **Requirements**: R1, R2, R3, R7, KTD1, KTD2, KTD10 (harness-pi item 15; tracing has no row yet). The fit's verify-time scenario covers the ship and conductor pipelines.
- **Dependencies**: none.
- **Files**: `src/core/budgets.ts` (new), `src/core/budgets.check.test.ts` (new), `src/agents/registry.ts` (`loopBudget` reads the ask from the module; `RUNAWAY_TURNS_PER_MINUTE` and `runawayTurnCap` move to the module and are re-exported), `src/execution/bashTimeout.ts` (imports `commandWriteUp` and `execCall`), `src/execution/bashTimeout.test.ts`, `src/core/shipPipeline.ts` (re-exports `SHIP_MIN_MAX_MINUTES` from the module's fit floor), `src/core/ship/surface.test.ts` (the export list), `src/core/frictionProposals.ts` (the four proposal strings point at the module), `src/agents/registry.test.ts` (the turn-cap describe imports from the module), `docs/reference/specs/harness-pi.md` item 15, `docs/reference/specs/agent-ship.md` `Code:` header (names the module), `docs/reference/code-map.md` (a Modules row).
- **Approach**:
  1. Tests first, red against today: the fit over `{ ship: 120, maxRounds 3 }` holds at 108 and fails at 4 rounds naming 129; every reserve equals its derivation; `writeUp + postStep + execCall ≤` every ask; every loop-running preset's `maxTurns` is `runawayTurnCap(ask)`, ship exempt.
  2. Tidy first: move the constants (asks, `RUNAWAY_TURNS_PER_MINUTE`, `runawayTurnCap`, the bash reserve and margin) into the module with no behavior change; registry, `bashTimeout.ts`, `shipPipeline.ts` and the surface scan follow in the same commit.
  3. Add floors, allowances, `reserve(round, loop)`, `carve`, `fit`, each typed, each with a doc comment naming the record's section.
  4. Spec rows: harness-pi item 15 names the module as the owner of the asks and the derivation; agent-ship's `Code:` header gains the module so `specs:coverage` covers it.
- **Execution note**: the relocation commit and the behavior commit are separate commits in one pull request.
- **Patterns to follow**: `loopBudget` and the turn-cap describe in `src/agents/registry.ts` and `registry.test.ts`; the node-free header of `src/execution/bashTimeout.ts`; `src/core/ship/surface.test.ts` for the pinned export list.
- **Test scenarios**:
  - `budgets.check.test.ts`: the fit holds for the registry's ship at 3 rounds and names the sum when `maxRounds` is 4; a floor above its ask fails; the reserve before the coding round equals `3 × (5 + 3) + 2 × (10 + 3) + 10` at 3 rounds and moves when review's floor moves; `writeUp + postStep(preset) + execCall ≤ ask(preset)` holds for every preset, general's with a post-step of 0; every loop-running preset's `maxTurns` equals `runawayTurnCap(ask)` and ship's is 1.
  - `budgets.check.test.ts`: `carve(118 min, {kind: coding, index: 0}, 3 rounds)` gives 45 bounded by the ask holding 60; `carve(46, {kind: fix, index: 1}, 3 rounds)` is refused under the floor of 10; `carve(35, {kind: review, index: 3}, 3 rounds)` gives 25 holding 10 and `carve(35, {kind: review, index: 1}, 3 rounds)` is refused, since 35 − 52 is under review's floor; the conductor's pipeline passes the fit with no loop.
  - `bashTimeout.test.ts`: `bashBudgetWithinRun` behaves byte for byte as before with the constants imported.
  - `surface.test.ts`: the export list matches after the move.
- **Verification**: the test files green, red first; `npm run specs:check`; `npm run verify`.

### U2. The coordinator, the validator and the fork carve from the module

- **Goal**: the ship coordinator carves every round through `carve`, refuses a round under its floor instead of clamping to 2, carves the merge wait as a round, and reads the asks from the module; `validateShip` asserts the fit; the fork asserts the fit over a clipped request and refuses with the sum; the child card names the carve.
- **Requirements**: R3, R4, R5, R6, KTD3, KTD4 (agent-ship items 8, 9, 15; routing-and-config items 2, 4).
- **Dependencies**: U1.
- **Files**: `src/core/ship/coordinator.ts` (`budgetMinutesFor`, `reserveFor`, the reserve constants, the dispatch gate, `MERGE_WAIT_MAX_MS` and the wait rows, `UnitPipelineInput.childMinutes`), `src/core/coordinator/driver.ts` and `src/core/coordinator/driver.test.ts` (the `childMinutes` validation and its ten fixtures go), `src/channels/adminCoordinator.ts` and `src/channels/adminCoordinator.test.ts` (the `plan` route's `childMinutes`), `src/core/dispatch/resolve.ts` and `src/core/dispatch/spawn.ts` (`boundedByParent` carves a conductor child through the module with the floor refusal), `src/core/dispatch/resolve.test.ts`, `src/config/validate.ts` (`validateShip`), `src/config.test.ts` (the ship caps describe), `src/core/dispatch/ship.ts` (the fit at the fork), `src/core/dispatch/ship.test.ts`, `src/core/dispatch/provision.ts` (`budgetClipLabel`), `src/core/dispatch/provision.test.ts`, `src/core/ship/coordinator.test.ts`, `src/core/shipPipeline.ts` (the four reserve re-exports go), `src/core/ship/surface.test.ts` (the pinned export list), `docs/reference/specs/agent-ship.md` items 8, 9, 15 and the `Budgets` bullet, `docs/reference/specs/routing-and-config.md` items 2 and 4, `docs/reference/specs/http-ingress.md` item 9 (the `plan` step's answer no longer carries `childMinutes`), `docs/reference/specs/agent-conductor.md` (the child's carve).
- **Approach**:
  0. Before the refusal ships, read every channel and user boundary in the production config document for a `maxMinutes` under the fit's sum; any found is raised or removed with the maintainer first.
  1. Tests first, red against today: a round whose carve falls under its floor ends the unit `review pending` naming the round (today a 2-minute child is dispatched); the merge wait's timeout is `min(60, remainder)`; `validateShip` refuses `maxMinutes: 40` at 3 rounds naming 108; the fork refuses a ship request clipped to 40 by a channel boundary with the sum on the card and starts no instance; the card reads `budget 45 min (carved from ship's 120; holds 60 for three reviews, two fixes and the merge)`.
  2. Replace `budgetMinutesFor` and `reserveFor` with `carve`; the dispatch gate becomes the floor refusal; `SHIP_ROUND_RESERVE_MS`, `SHIP_LOOP_RESERVE_MS`, `SHIP_FIX_RESERVE_MS` and `SHIP_MIN_MAX_MINUTES` go, their readers import the module.
  3. `validateShip` calls `fit` with the deployment's `maxMinutes` and `maxRounds`; the message names both numbers and the sum.
  4. The fork computes the fit over `profile.minutes` and `maxRounds` before opening the instance, from the round the instance starts at (round 0 for a fresh task, the fix round for a re-issue that resumes at the review); a refusal is the card's ending with the sum, no instance, no thread claim.
  4b. A conductor child's minutes come from `carve(parentRemainingMs, {kind: child preset, index: 0}, no loop)`: the floor refusal replaces the bare `floor(parentRemainingMs / 60_000)`, and the card names the carve.
  5. `budgetClipLabel` renders the carve's provenance from `carve`'s return; the directive-clip wording stays for a `budget:` a person typed.
  6. Spec rows: agent-ship item 8 (the fit at the fork, the floor refusal), item 9 (the merge wait carved), item 15 (`openUnitPipeline`'s input without `childMinutes`), the `Budgets` bullet (the module, the reserve derivation); routing-and-config item 2 (the floor replaces the 2-minute reserve), item 4 (the card's carve line); http-ingress item 9; agent-conductor's child budget row.
- **Patterns to follow**: the `caps` sibling test in `src/core/dispatch/ship.test.ts` (`maxMinutes is the profile's minutes`); the ship caps describe in `src/config.test.ts`; the `enterRound` cap ending in `coordinator.ts`.
- **Test scenarios**:
  - `coordinator.test.ts`: round-0 child carved 45 from 118 at 3 rounds; a fix child at remainder 46 is refused under the floor and the unit ends `review pending` naming the fix round; the merge wait at remainder 20 waits at most 20; the pipeline's `childMinutes` input is gone and the asks come from the module.
  - `config.test.ts`: `ship: { maxMinutes: 40, maxRounds: 3 }` is refused naming 40 and 108; `120` at 3 rounds loads; `120` at 4 rounds is refused naming 129.
  - `ship.test.ts`: a channel boundary of 40 refuses at the fork with the sum, opens no instance and claims no thread; a boundary of 110 opens the instance with 110 as the pipeline's minutes.
  - `provision.test.ts`: the card line for a carved child names the source and the held amount; a person's `budget:30` on a coding request still reads `budget 30 min (budget directive; preset asks 45)`.
  - `resolve.test.ts`: a conductor with 7 minutes left spawning a coding child is refused under the floor with the card naming it; one with 30 left carves 30 bounded by the parent.
- **Verification**: the four test files green, red first; `npm run specs:check`; `npm run verify`.

### U3. The duration-literal ratchet

- **Goal**: a second ratchet lists every minutes-scale duration literal outside `src/core/budgets.ts` and only shrinks; `verify` runs it.
- **Requirements**: R8, KTD5 (tracing item 8).
- **Dependencies**: U1.
- **Files**: `src/core/trace/durationReads.mjs` (new predicate list), `src/core/trace/durationScan.mjs` (new; reuses `productionFiles`), `src/core/trace/durationAllowlist.json` (new), `src/core/trace/durationAllowlist.test.ts` (new), `scripts/duration-allowlist.mts` (new, `duration:gen` and `duration:check`), `package.json` (`duration:check` under `check:consistency`, `duration:gen` under `fix`) and `project.json` (the two scripts described), `eslint.config.mjs` (a second block exempting the module), `docs/reference/specs/tracing.md` item 8, `AGENTS.md` (regenerated by `agents:gen`).
- **Approach**:
  1. Tests first: the scanner counts `N * 60_000`, `N * MIN`-shaped and bare `_000`-minute literals per file; the module is exempt; an allowlist entry above the tree's count is a stale entry; a file over its entry fails naming the file.
  2. Generate the starting allowlist from the tree; check that `verify` is green with it and red with one literal added to a file at its cap.
  3. Spec rows: tracing item 8 gains the duration class beside the wall-clock class.
- **Execution note**: this unit lists, it does not relocate; a literal that should become a module row is a follow-up per file.
- **Patterns to follow**: `src/core/trace/clockReads.mjs`, `clockScan.mjs`, `clockAllowlist.test.ts`, `scripts/clock-allowlist.mts`, the `clock-ban` block in `eslint.config.mjs`.
- **Test scenarios**:
  - `durationAllowlist.test.ts`: the scanner and the ESLint rule name the same predicates; `src/core/budgets.ts` is exempt; a file under its entry passes and the stale entry is reported; a file over its entry fails by name; the allowlist and the tree agree at head.
- **Verification**: `npm run duration:check` green at head; a deliberate added literal reds it; `npm run agents:check`; `npm run verify`.

### U4. The measurements and the abort probe

- **Goal**: the floors for coding and the merge wait, the post-step allowance and the `review pending` baseline are read from the ledger, and one live run answers whether pi's abort ends its tool's process group.
- **Requirements**: R13.
- **Dependencies**: U1 (the numbers it may revise live there).
- **Files**: none in `src/` beyond a possible constant change in `src/core/budgets.ts`; the results are recorded on the tracker issue for the wind-down abort and, for a changed number, in `budgets.ts` with its test.
- **Approach**:
  1. From the run ledger (`/api/runs.list`, `/api/runs.get`, the recipe the record's audit used): the duration distribution of completed fix children (`idempotencyKey` round index above 0), of runner merge waits that ended in a merge, and of `run.description_turn` spans; the share of ship units that ended `review pending` in the last 14 days.
  2. One live coding run in a scratch repository whose model script issues a `sleep 600`, then the harness's abort at the loop's end; read the resident's process table before and after; record whether the shell survived.
  2b. From the same run, capture one proxied request body from the write-up turn and one from the description turn, and record which tools each carries; U6's gate is shaped by them.
  2c. Read every channel and user boundary in the production config document for a `maxMinutes` under the fit's sum, for U2's step 0.
  3. Revise the guesses in the module if the data says so; U5 and U7 read the answers.
- **Execution note**: read-only against production; no PR unless a number changes.
- **Patterns to follow**: the audit recorded on the tracker issue; `depot ci` and the dashboard reads in the project memory.
- **Test scenarios**: `Test expectation: none -- a measurement unit; a changed constant is covered by U1's tests`.
- **Verification**: the four distributions and the probe's answer posted on the tracker issue with their sample sizes.

### U5. The loop ends inside the lease, on both harnesses

- **Goal**: the pi harness and the OpenCode bridge end the loop at `deadline − (writeUp + postStep)`, warn before it, and run the write-up inside the lease; the follow-up turn and the post-step turns carve their minutes from the remaining lease; the bearer's grace is one minute; the row records the lease's start.
- **Requirements**: R9, KTD7, KTD10 (harness-pi items 6, 15; harness item 11; model-proxy items 2, 3; run-history item 2).
- **Dependencies**: U1, U4.
- **Files**: `src/core/harness/pi/harness.ts` (`FINALE_TIMEOUT_MS`, `remainingMs`/`deadline`/`warnAt`, the deadline check, the follow-up turn's deadline), `src/core/harness/opencode/bridge.ts` (the same three sites plus `toolContext.remainingMs`), `src/core/harness/opencode/harness.ts` (the synthesized post-turn run), `src/core/harness/contract.ts` (`HarnessDeps.finaleTimeoutMs` replaced by the lease allowances; `HarnessRun` gains the lease; `FollowUpTurnInput` carves), `src/core/harness/windDown.ts` (the loop-end note wording), `src/core/descriptionTurn.ts`, `src/core/verdictTurn.ts`, `src/core/dispatch/runLoop.ts` (the post-steps carve from the remaining lease), `src/core/modelProxy/runBearers.ts` (`BEARER_MARGIN_MS` becomes `bearerGrace`; the expiry is set from the lease's start, not the mint), `src/core/modelProxy/runBearers.test.ts`, `src/core/dispatch/provision.ts` (the mint), `src/core/dispatch/provision.test.ts`, `src/core/dispatcher.test.ts`, `src/core/harness/contract.test.ts`, `src/core/runEvents.ts` and `src/core/runRecord.ts` (`leaseStartedAt` as a `run_meta` field, an event like KTD6's, projected onto the record), `src/core/harness/testing/scenarios.ts` (rows), `src/core/harness/pi/testing/driver.ts` and `src/core/harness/opencode/testing/driver.ts` (the clock knob), `src/core/harness/pi/harness.test.ts`, `src/core/harness/opencode/bridge.test.ts`, `src/core/descriptionTurn.test.ts`, `src/core/verdictTurn.test.ts`, `docs/reference/specs/harness-pi.md` items 6 and 15, `docs/reference/specs/harness.md` item 11, `docs/reference/specs/model-proxy.md` items 2 and 3, `docs/reference/specs/run-history.md` item 2.
- **Approach**:
  1. Tests first, red against today: a conformance row `the lease covers the write-up and the post-step` where the clock passes `loopEnd` with a call under way: the loop ends, the write-up answer stands, the description turn's minutes equal the lease's remainder, and the run's time from the lease's start is at most the lease plus the grace; a row where the write-up call is slower than its allowance ends with the wind-down sentence and says the write-up was cut.
  2. Compute `loopEnd` beside `deadline` from the module's allowances for the run's preset (`postStep(preset)`, 0 where the preset runs none); `warnAt` derives from `loopEnd`; the deadline check moves to `loopEnd`; the finale bound is the `writeUp` allowance; the follow-up turn's deadline is carved from the remaining lease, never a fresh `maxMinutes`; the write-up turn is sent with an empty tool table, and a post-step turn with its submit tools only.
  3. OpenCode parity: the same arithmetic, the finale bound added, `toolContext.remainingMs` set, the synthesized post-turn run carrying the remaining lease.
  4. The description and verdict turns take their minutes as `min(postStep(preset), remaining lease)` instead of `min(ask, 5)` and `min(ask, 3)`; they are allowances held inside the lease, not rounds, so they do not go through `carve`.
  5. The bearer's expiry is `leaseStartedAt + lease + bearerGrace`, set when the harness sets its deadline (the mint at provisioning issues it with a provisional expiry the lease's start replaces), so the grace is measured from the lease, not from attach; `leaseStartedAt` is recorded on `run_meta` at the same moment.
  6. Spec rows: harness-pi item 6 (the loop end, the write-up inside the lease), item 15 (the allowances by name); harness item 11 (the new rows); model-proxy items 2 and 3 (the grace); run-history item 2 (`leaseStartedAt`).
- **Execution note**: keep the `budgetBeforeModelCall` hook the drivers already have; extend the clock knob to land at `loopEnd`, not only past `deadline`.
- **Patterns to follow**: the conformance row `conversation-write-up-call-fails` and the pi driver's mutable clock; the wind-down ownership added by the merged fix; `answerUnderEnding` in `runLoop.ts`.
- **Test scenarios**:
  - `conformance.test.ts` (both drivers): at `loopEnd` with a call in flight the loop ends and the answer is the write-up's; the description turn's minutes equal the remainder; a slow write-up ends with the wind-down sentence and the card says it was cut; the run's `finishedAt − leaseStartedAt ≤ lease + grace`.
  - `harness.test.ts` (pi): `warnAt` is `loopEnd − writeUp`; a follow-up turn's deadline is the remaining lease, not `maxMinutes`; the finale bound equals the `writeUp` allowance.
  - `bridge.test.ts` (OpenCode): the same three, plus `toolContext.remainingMs` is set.
  - `descriptionTurn.test.ts` and `verdictTurn.test.ts`: a run with 1 minute left gets a 1-minute turn; one with 20 left gets 5 and 3.
  - `runBearers.test.ts`: a bearer expires at the lease's end plus one minute.
- **Verification**: the test files green, red first; `npm run specs:check`; the harness conformance matrix in the pull request; `npm run verify`.

### U6. The proxy admits only tool-less calls after the loop's end

- **Goal**: the harness marks the loop's end in the bearer store and the model proxy refuses a call offering a workspace tool after it with a typed note, admitting the tool-less write-up turn and the post-step turns whose tools are the grant's submit tools; the mark survives a bot generation change.
- **Requirements**: R10, KTD8 (model-proxy item 5).
- **Dependencies**: U5.
- **Files**: `src/core/modelProxy/runBearers.ts` (`markLoopEnded`, the grant's `loopEndedAt` and `postStepTools`; `adopt` carries the mark from the row), `src/core/runRecord.ts` (the mark on the row), `src/channels/modelProxy.ts` (`handleAdmitted`: the tool-table check beside `pinRequest`, the refusal), `src/core/harness/pi/harness.ts` and `src/core/harness/opencode/bridge.ts` (mark at `loopEnd`), `src/core/harness/contract.ts` (the mark reaches the store through `HarnessDeps`), `src/channels/modelProxy.test.ts`, `src/core/modelProxy/runBearers.test.ts`, `src/core/harness/testing/scenarios.ts` (a row), `docs/reference/specs/model-proxy.md` item 5.
- **Approach**:
  1. Tests first, red against today: a call offering `bash` after `markLoopEnded` is 403 with a `time_budget_exhausted` note that names the loop's end, forwards nothing and opens no span; a tool-less call and a call offering only the grant's post-step tools are forwarded; before the mark all are forwarded; a real write-up request and a real description-turn request captured from the harness (U4 captures one of each) pass the gate.
  2. `markLoopEnded(runId)` mirrors `revoke`; the grant carries `loopEndedAt`.
  3. The harness calls the mark where it ends the loop; a conformance row proves both drivers do.
  4. Spec rows: model-proxy item 5 gains the second refusal beside the turn guard.
- **Patterns to follow**: the turn-guard refusal in `modelProxy.ts` and its test `the call past maxTurns is 403 turn_budget_exhausted …`; `revoke` in `runBearers.ts`.
- **Test scenarios**:
  - `modelProxy.test.ts`: a tool-carrying call after the mark is 403 with the typed note and no upstream call; a tool-less call after the mark is forwarded; both are forwarded before the mark; the mark on an unknown run is a no-op.
  - `runBearers.test.ts`: `markLoopEnded` sets the grant's field once and survives `rotate`; `adopt` onto a fresh generation's entry carries `loopEndedAt` forward from the row.
  - `conformance.test.ts`: both drivers mark the loop's end before the write-up turn.
- **Verification**: the test files green, red first; `npm run specs:check`; `npm run verify`.

### U7. The shell in flight ends at the loop's end

- **Goal**: a shell command running at the loop's end is ended without killing the harness process, in the shape U4's probe decided, and the wind-down's pushed work is intact.
- **Requirements**: R11 (harness-pi item 6; harness item 11; execution item 12).
- **Dependencies**: U4, U5.
- **Files**: one of two shapes: (a) if the abort propagates, `src/core/harness/pi/harness.ts` sends the abort at `loopEnd` and a conformance row proves the command ended; (b) if it does not, `src/core/harness/container.ts` gains a capability to end the run's descendants without the harness process, `src/core/harness/testing/fakeContainer.ts` gains a modelled child process, and both drivers call it. Plus `src/core/harness/testing/scenarios.ts`, `src/core/harness/opencode/testing/driver.ts` (`ScriptedServe`), `docs/reference/specs/harness-pi.md` item 6, `docs/reference/specs/harness.md` item 11, `docs/reference/specs/execution.md` item 12.
- **Approach**:
  1. Tests first: a conformance row where a command is in flight at `loopEnd`: the command ends, the harness process lives, the write-up answer stands, and the push recorded at the wind-down note is unchanged.
  2. Implement the shape U4 chose; the fake container models the child process either way.
  3. Spec rows: harness-pi item 6 (the shell ends at the loop's end), harness item 11 (the row), execution item 12 (the shell clip's return, in the harness rather than a tool argument).
- **Execution note**: does not start until U4 has posted the probe's answer.
- **Patterns to follow**: `killScript` in `container.ts` for the group kill's shape; `residentExecWrap.ts` for salvaging a killed command's output; the fake container's `kill` recording.
- **Test scenarios**:
  - `conformance.test.ts` (both drivers): the command in flight at `loopEnd` is ended and the harness process is not; the answer is the write-up's; the recorded pushed head predates the kill.
  - `fakeContainer.test.ts` (or beside the drivers): the modelled child process ends on the new capability and the parent does not.
- **Verification**: the rows green on both drivers, red first; one live run on the resident with a `sleep` in flight ends at the loop's end (human-gated receipt on the tracker issue); `npm run verify`.

### U8. The pushed head is recorded, and the contract pushes at the wind-down

- **Goal**: a coding run's push publishes `pushed_head { ref, sha }` whether or not a pull request opens, the row's pushed-branch reads use it, and the ship contract's first instruction tells the child to commit and push at the wind-down note before answering.
- **Requirements**: R12, KTD6 (run-history item 2; agent-ship `Budgets` bullet and item 8; agent-coding item 13).
- **Dependencies**: U5.
- **Files**: `src/core/runEvents.ts` (the union member and the kinds list), `src/core/codingPrPostStep.ts` (publish at the push facts), `src/core/runRecord.ts` (`pushedBranchesOf` reads `pushed_head` first, `pr_opened` as the fallback for older rows), `src/core/runEventLines.ts` (the validator and the line), `src/core/runFriction.ts`, `src/core/dispatch/reply.ts`, `src/channels/runTimeline.ts`, `src/channels/adminCoordinator.ts`, `src/core/boot.ts`, `web/src/lib/runPageModel.ts`, `src/core/testing/conformanceFixture.ts` (every exhaustive site), `src/core/ship/contract.ts` (`renderFirstInstruction`), `src/agents/registry.ts` (`CHECKS_BY_COST` gains the wind-down sentence), `src/core/ship/contract.test.ts`, `src/agents/registry.test.ts`, `src/core/runRecord.test.ts`, `src/core/codingPrPostStep.test.ts`, `docs/reference/specs/run-history.md` item 2, `docs/reference/specs/agent-ship.md` (`Budgets` bullet, item 8), `docs/reference/specs/agent-coding.md` item 13.
- **Approach**:
  1. Tests first, red against today: a push with no description and no open pull request publishes `pushed_head` with the ref and the sha the post-step observed; `pushedBranchesOf` lists it; the run page line renders it; the first instruction carries the wind-down sentence after the push-early sentence and before the expensive checks.
  2. Add the event kind in both the union and the kinds list; publish it from the post-step where `pushed` is computed and from the salvage push, which already reads the full sha with `git rev-parse HEAD` and prints only seven characters into its note; the event does not inherit the salvage's gates (ship children, the time budget, no hard stop): every coding run's push publishes it. Walk every exhaustive site the compiler and the validator name.
  3. `pushedBranchesOf` prefers `pushed_head`, keeps `pr_opened` for rows written before it.
  4. The contract's first instruction and `CHECKS_BY_COST` gain one sentence: at the wind-down note, commit and push what compiles, say what does not, then answer.
  5. Spec rows: run-history item 2 (the event and the record's `pushed`), agent-ship `Budgets` (the sha the salvage records) and item 8, agent-coding item 13 (the sentence).
- **Patterns to follow**: `pr_opened`'s member and its publication in `codingPrPostStep.ts`; the `_EveryKindListed` guard for note kinds; the checks-by-cost describe in `registry.test.ts`, which asserts step ordering.
- **Test scenarios**:
  - `codingPrPostStep.test.ts`: a pushed branch with no description publishes `pushed_head` with ref and sha; an unpushed tree publishes none; a push that also opens a pull request publishes both events.
  - `runRecord.test.ts`: `pushedBranchesOf` reads `pushed_head` and falls back to `pr_opened` on an older row; the record's `pushed` names the sha.
  - `runEventLines.test.ts`: the new kind validates and renders one line; an unknown kind is still dropped.
  - `contract.test.ts` and `registry.test.ts`: the first instruction and the rule carry the wind-down sentence, and the push step still precedes the expensive checks.
- **Verification**: the test files green, red first; `npm run specs:check`; `npm run verify`.

---

## Verification Contract

- Every unit: the named test files red before the change and green after; `npm run specs:check` with every changed spec row bound as `file::describe::it`; `npm run fix` then `npm run verify` green; the pull request title passes `npm run check:pr-title` with scope `core`, `ship`, `config`, `harness` or `tracing`.
- U1, U2: `npm run verify` fails when the fit is broken by a deliberate change to a floor, an allowance or the default `maxRounds`, naming the sum (run once, reverted, noted in the pull request).
- U3: `npm run duration:check` green at head and red with one added literal; `npm run agents:check` green with the scripts described.
- U5, U6, U7: the harness conformance matrix rendered in the pull request, green on both drivers.
- U7: one live run on the resident with a command in flight at the loop's end, receipt on the tracker issue (human-gated).
- U4: the measurements and the probe's answer posted on the tracker issue with sample sizes.

## Definition of Done

- The eight units merged through the review loop, each with its spec rows bound and green.
- No minutes literal outside `src/core/budgets.ts` except those the duration allowlist lists, and the allowlist only shrank after U3 landed.
- A ship request clipped under its loop's fit is refused with the sum at config load and at the fork; a round under its floor is refused and the unit ends `review pending`.
- A budget hit on the ledger after U5 to U8 shows the loop ending at `loopEnd`, the write-up inside the lease, a `pushed_head` event, and `finishedAt − leaseStartedAt ≤ lease + 1 min`; receipts recorded on the tracker issue.
- The record's status is `accepted` for units one and two, with unit three marked as direction; abandoned experiments from the probe are not in any diff.

## Open Questions

| Question | Blocking? | Resolves it | Owner |
|---|---|---|---|
| Does pi's abort end its tool's process group? | Blocks U7 only | U4's live probe | the executing agent |
| Do the measured fix-child and merge-wait durations move the floors of 10 and 10? | Blocks nothing; a changed floor is one row in the module and moves U1's fit and U2's refusal | U4's ledger read | the executing agent |
| Does `postStep 5` hold against measured description turns? | Blocks U5's numbers only | U4's ledger read | the executing agent |
| Which tools do the write-up and the description turn actually carry on the wire? | Blocks U6 | U4's captured request bodies | the executing agent |
