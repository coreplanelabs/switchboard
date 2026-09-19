---
title: The orchestration plane owns every run's state - Plan
type: feat
date: 2026-09-19
status: proposed
artifact_contract: ce-unified-plan/v1
artifact_readiness: implementation-ready
product_contract_source: ce-plan-bootstrap
execution: code
extends: ../decisions/0064-the-plane-owns-every-runs-state-a-refusal-becomes-a-queue-position-an-ending-is-judged-by-the-ledger-that-saw-it-and-a-release-is-a-quiet-window-a-person-closes.md
---

# The orchestration plane owns every run's state - Plan

## Goal Capsule

- **Objective**: Build [record 0064](../decisions/0064-the-plane-owns-every-runs-state-a-refusal-becomes-a-queue-position-an-ending-is-judged-by-the-ledger-that-saw-it-and-a-release-is-a-quiet-window-a-person-closes.md): the run ledger's Durable Object grows into the plane, the one owner of every run's state, with the bot and the plan runner as its clients; six refusals become queue conditions asked at three stages; the incidents' hand recoveries become named watches and moves; saturation is one checkpoint steer per round; a release past its threshold is a quiet window that hands the merge to a person; the dashboard gains a panel set whose first unit is the read-only table.
- **Authority**: record 0064 (proposed; this plan is the artifact its acceptance is judged on) over `docs/reference/specs/orchestration-plane.md` (the new living spec, opened by U1's pull request and grown by every unit; it is not on this branch, so it is named and not linked), [run-history.md](../reference/specs/run-history.md), [thread-admission.md](../reference/specs/thread-admission.md), [agent-ship.md](../reference/specs/agent-ship.md), [resident-repos.md](../reference/specs/resident-repos.md), [release-and-deploy.md](../reference/specs/release-and-deploy.md), [live-view.md](../reference/specs/live-view.md), [routing-and-config.md](../reference/specs/routing-and-config.md), [http-ingress.md](../reference/specs/http-ingress.md), [execution.md](../reference/specs/execution.md), [command-registry.md](../reference/specs/command-registry.md), [authorization.md](../reference/specs/authorization.md), [costs.md](../reference/specs/costs.md).
- **Execution profile**: fifteen code units in this repository, each one pull request through the review loop, tests first in every unit, plus the configuration and human steps the record names. U1 is read-only over existing stores and useful the day it lands; its pull request is open beside this plan and nothing else here has been built. U2 (the driver's `queued` passing condition) ships in a release before any bot answers `queued`. U3 opens the object's tables and the decider behind `plane.admission: shadow`; U4 to U6 turn the conditions on one stage at a time; U7 to U11 add the causes, the steers, the moves, the pressure window and the release manager; U12 the panels; U13 adoption; U14 the record amendments; U15 the settings and secrets. The soft stop (U10), the queued spawn's idle (U5) and the owner gap (U11) rest on record 0051's unit idle, which its own plan builds and this plan waits for.
- **Stop conditions**: a unit that finds a fifth place that decides admission, a second writer of ending causes, a timer it needs beyond the three the record names, or a kill of any live run hands back a deviation before changing anything. Nothing here adds a Durable Object class, a Worker, a model call in the object, or a credential the bot does not already hold.
- **Tail ownership**: each pull request merges through the review loop under the freeze's rules in force; the `pull_request` webhook subscription, the resident objects' bearer, the `plane.admission` flips and the `release.quiet` numbers are the maintainer's; every live receipt (a queued ask admitted on an event, a steer that landed, a window that lifted on the deploy's report) is posted on the receipts issue of the owning spec.

---

## Product Contract

### Summary

On 2026-09-18 seven releases landed, two bursts each lost fifteen runs' work, and every detection and recovery was a person's. Record 0064 moves four decisions out of the bot process, which rolls on every release, into the ledger object that already sees every claim, heartbeat and seal and already outlives the bot: whether an ask may run now, what an ending means, how saturation is handled, and when a release may cut. The record holds the measurements, the alternatives and the argument.

### Problem Frame

Six doors refuse at three stages and one waits by a client poll; the ending's words are composed inside the process that rolls; every health fact exists and nothing acts on it; a release is a person's chore over a fleet that never drains. The record's Today table and appendix survey are the grounding at `a578f314`.

### Requirements

**The table (record 0064, "The table, the panels and adoption"; U1)**

- R1. `src/core/plane/table.ts` is node-free and pure: `buildPlaneTable({ now, runs, instances, pullRequests })` returns every run row with its owner and health flags (`stalled`, `bound-exceeded`, `no-signal`, `provisional`, `interrupted`, `failed`), every unit row with its instance and health (`live`, `waiting`, `idle`, `merged`, `merge-ready`, `ended`, `owner-gap`), every tracked pull request with its owner and health (`approved`, `dirty`, `red`, `pending`, `mistitled`, `merged`, `closed`, `unknown`), and empty `windows` and `findings`; live rows sort first, stalled ahead of healthy.
- R2. `createPlaneService` reads the runs service for live and recent runs and for an instance's units under the viewer's predicate, the instance store for the instance's facts, and the merge door's GitHub reads for at most `maxPullRequests` pull requests, the units' first; an unreadable GitHub or a process without a credential reads `unknown`.
- R3. `plane show` is a registry command, action `runs:read`, effect read, on every surface, rendered as three sections; the router is offered it with its three fixtures.
- R4. `GET /plane` serves the web shell with a `PlaneSeed` and `GET /plane.json` the same table; Access-gated beside `/runs`; live rows of this process carry their tokens; the nav gains **Plane** on `runLedger`.

**The decider and the object (record 0064, "Where it lives"; U3)**

- R5. `src/core/plane/decide.ts` is node-free and pure: `decide(state, event) → { state, effects, writes }` over a closed event union and a closed effect union; the object applies it inside one `transactionSync` with the state read, the writes (inbox rows, unit rows, reservations) and the effects committed together.
- R6. The object gains the tables `plane_queue(run_id, requester, thread_key, stage, request_json, conditions_json, position_at, queued_at, state)`, `plane_reservations(kind, key, run_id, at)`, `plane_windows(kind, key, phase, opened_at, reason_json)`, `plane_findings(id, watch, subject, timeline_json, filed_at)`, `plane_effects(id, body_json, offered_at, acked_at)` and `plane_levels(resident, name, side, reported_at, generation)`.
- R7. `plane.admission: off | shadow | on` is a config key (default `off`); under `shadow` the bot posts its own outcome per dispatch (`proceeded`, `refused:<code>`, `fell_cold:<token>`) to `POST /plane/outcome`, the object logs the decider's decision beside it, and nothing runs from the decider; a `plane disagreements` line on the table counts them per condition.
- R8. Every answer the object gives the bot's heartbeat and reclaim-sweep calls carries `effects: PlaneEffect[]`, at most 32; the bot acknowledges each by id with `done`, `skipped` or `deferred` on `POST /plane/ack`; a draining generation defers `admit` and `reissue` and executes the rest.

**The transport (record 0064, "Where it lives"; U4)**

- R9. The state Worker gains a service binding to the bot Worker and pushes committed effects to a bearer-gated `POST /plane/effects` the Worker forwards to the container; a push that fails is not retried by a timer, the effect rides the next heartbeat or sweep answer.
- R10. Effects are bounded: effects for a sealed run are dropped at the seal; a per-run cap and a total cap refuse by name when hit.

**The queue at the admission stage (record 0064, "The queue"; U4)**

- R11. The admission stage asks `POST /plane/admit` with the thread key, the requester and the request; the answer is `admitted { reservation }` or `queued { id, position, waiting }`. `admitted` writes a reservation on the thread in the same transaction; the ledger claim promotes it. `queued` stores the request in the durable inbox's shape, mints the run id, and the bot posts the queued card and abandons any registry row it made.
- R12. Conditions at this stage: `thread_free(thread)` (flipped by the seal or closing reclaim of the thread's run), `window_open(kind)` (flipped by a window's lift), `deploy_settled` (flipped by the deploy runner's `deploy.landed` post). The full condition set is these three, the runner's (R18), the resident's (R21) and the provider's (R31); no other condition exists.
- R13. A queued run has a page (`/runs/<id>` reads the position and the conditions from the plane) and `runs stop <id>` withdraws it (`withdrawn`); a plain reply into a thread whose only run is queued appends to the stored request. Position is the rank among queued runs sharing the unmet condition, shown per condition.
- R14. `admit(id)` writes the run's attaching row under the plane's id in the same transaction as the effect; the bot dispatches the stored request under that id through the restart-from-request path; authorization runs again and a lost grant ends the run `refused`, acknowledged as `refused` so the plane re-walks. A queued run withdrawn or refused writes a final record with its cause.
- R15. The deploy runner posts `deploy.landed { version, workers }` to the state Worker with its bearer beside its `/undrain`.

**The runner conditions (record 0064, "The queue"; U2, U5)**

- R16. The driver reads `queued` as a spawn answer (a passing condition, like `not_host`) and re-reads its unit selection at every unit boundary; both ship in a release before any bot answers `queued` or appends a unit.
- R17. The ship fork asks `runner_free(plan)` after the plan read and before the host-key claim, which moves after it; `admitted` reserves the plan instance; a seed naming units of a live instance is written onto the instance's unit rows with minutes re-carved from the parent's remaining lease, and the object wakes the runner through the Workflow binding it holds; a seed naming units already selected or merged is answered with one line and starts nothing.
- R18. `runner_free` flips on the instance's `finish`, on an engine status of `errored` or `terminated` read by the bot at a seed or by the object at the re-ask cadence while a seed waits, or on the hosting deadline of an instance the engine does not report `waiting`.
- R19. A `queued` answer to a runner's spawn idles the unit under record 0051 (no lease spent) and the plane's `admit` wakes it; the child's lease starts at admission and the parent's round is re-carved then.

**The resident conditions (record 0064, "The queue"; U6)**

- R20. Each resident object posts its levels, `seat` (thread users and op users both) and `memory` (the gate's soft side), at every crossing and on its first sample after a boot, through an outbox re-offered on its next call; every answer it gives the bot (attach, exec, status) carries `levels`, and the bot forwards a change to `POST /plane/level`. The registry object posts the drain's set, cleared and, by one alarm at `until`, expired.
- R21. The executor's attach asks the resident's conditions before reserving; `seat(resident)` and `memory(resident) below soft` are conditions for write presets; read presets (`explore`, `research`, `general`, `review`) fall cold under a resident condition and never wait on a window; a `restartOf` claim passes windows and the memory line.
- R22. The bot forwards every refusal-by-name it meets at attach or exec (`user-pool-exhausted`, the memory gate's, `draining`, `runtime-unreachable`, `runtime-replaced`) as an observation; an admitted run that meets one re-enters the queue at its old position instead of falling cold.
- R23. A resident that has never reported, whose generation changed without a report, or whose Worker the deploy runner reports landed, is `unknown` until its next level; write presets fall cold for it. While a queued run waits on a resident that has said nothing since, the object emits one `probe(resident)` effect per re-ask cadence and the bot's status probe answers with the levels.
- R24. `plane.reaskMinutes` (default 2) is the one re-ask cadence, used only while something waits on a reporter that fell silent; `plane.coldFallback` flips write presets back to falling cold.

**Endings (record 0064, "Endings and the watches"; U7)**

- R25. The claim meta gains `restartOf`; an ending gains `restarting: true` when the reattach path restarts the run; the runner keeps waiting for `child_resumed` on such an ending; the plane sends `child_resumed` from a `restartOf` claim and a duplicate beside the bot's own announcement is harmless.
- R26. The object records `ended { kind, cause }` from the closed set `completed`, `failed`, `stopped`, `withdrawn`, `refused`, `lease_lapsed`, `resident_replaced`, `runner_gone` only when a row closes; the reclaim's outcome (`resume`, `restart`, `rehost`, `closed`) is reported to the object; the bot's interrupted notes, the reattach text and the runner's report render the cause and never compose one; an older Worker leaves today's words.
- R27. The object's alarm is set to the earliest hosting deadline, lease end or re-ask across its rows and re-armed only when that earliest changes; at a lease end it offers the row to a generation other than its owner and never ends a run.

**Steers (record 0064, "The backpressure contract"; U8)**

- R28. The heartbeat body carries the round index, the in-flight call with its declared bound, the last event's time and the newest pushed head; `pushed_head` gains `clean` (no uncommitted or unpushed work at the push).
- R29. The object writes the checkpoint steer, "finish the step you are on, push a checkpoint and end the round; start no new command; the resident takes your push", as a `run_inbox` row keyed by run, round and cause, at most once per run per round per cause and the same sentence at most once per round, for `long_call` (a coding run's in-flight call past its declared bound or past the no-bound line) and `no_push` (a coding round with no pushed head past `noPushMinutes`, default 15).
- R30. A system actor `plane` holds a standing `steer` grant on write-preset runs; the row's sender is `plane`; authorization records it (record 0057's amendment).

**Provider transients (record 0064, "The queue"; U8)**

- R31. The model proxy reports each provider's level (`up` on a relayed success, `down` on a failure past its one retry) to `POST /plane/level`; a turn the proxy could not complete after the retry does not end the run: the harness holds the turn and the run parks on `provider_up(provider)`, the lease still counting; the provider's next success, for any run, flips the condition and the object writes one steer re-issuing the held turn; a run whose provider never answers ends on its lease as today.

**Moves (record 0064, "Endings and the watches"; U9)**

- R31a. `unit_title`: the runner's open takes the head commit's subject when it passes the title rule, else `<type>(<scope>): <title cut to fit>`; a tracked pull request whose title fails the rule gets a `retitle` effect with the same rule.
- R32. `orphaned_child`: a child that ends with a pushed branch, no pull request and no live runner gets a `pr_open` effect from the branch.
- R33. `dirty_at_approval`: `mergeableState: dirty` on an approved head opens a fix round on the unit's coding lane briefed "rebase onto the base and push"; the reviewed-head gate voids the approval; re-review follows.
- R34. `plane stop <instance>` (destructive) terminates the runner instance and ends its live child in one move, recorded on the parent run and the unit thread. `runner_gone` (the engine reports `errored` or `terminated` with units unfinished, or the hosting deadline passes on an instance not `waiting`) emits `reissue(plan, remaining units)` keyed by the attempt number.
- R35. A move whose precondition no longer holds is acknowledged `skipped`; a finding carries the watch and the timeline, deduplicated by watch and subject, and is filed by a research-tier run the bot dispatches, through the path `friction propose` uses.

**Saturation (record 0064, "The backpressure contract"; U10)**

- R36. A resident's `memory` level on the soft side opens a pressure window on that resident (`window_open(coding, resident)`), writes the checkpoint steer to every live coding child on it once per round, and closes on a level below the line or a person's `plane window lift`.
- R37. The gate's hard line lets a checkpoint's git commands through (resident-repos, the gate's item).
- R38. Revisable: at the hard line the object soft-stops (record 0051's pause) only children whose newest `pushed_head` is `clean` and newer than their last tool call; never `hard`, never a kill, never a child whose newest push is not clean.

**The release manager (record 0064, "The release manager"; U11)**

- R39. The webhook intake reads `pull_request` events for the release pull request and for every tracked pull request through record 0047's delivery-id dedupe, emitting `release.grew { prs, ageDays }` and the tracked pull requests' state changes; `owner_gap` ends when the pull request merges or closes.
- R40. `release.quiet: { prs, days }` is a setting; a quiet window has the phases *Quiet* (coding admission closes fleet-wide, reads run, one checkpoint steer to every live coding child, the runner's next-unit spawn idles), *Closing* (when no coding run is live, every new ask queues except a review round of a unit in flight), *Drained* (the bot's held rows and the resident's in-flight operations read zero), *Handed* (one card naming the release, the count and the step, "this deploys production"; the plane calls no merge), *Released* (the deploy runner's `deploy.landed` lifts the window for the bot's part; `fleet_open(resident)` stays closed until that resident's Worker is in the list). The release pull request's merge event during *Quiet* moves the window to *Closing* at once.
- R41. `plane window lift` (destructive) lifts any window early; a window has no deadline.

**Panels (record 0064, "The table, the panels and adoption"; U12)**

- R42. `/plane/queue`, `/plane/windows` and `/plane/health` are panels of the set under the **Plane** section; the costs page moves under it and `/costs*` redirects; the metrics page lands there when built.

**Adoption (record 0064; U13)**

- R43. `plane adopt <pull request URL>` (write class) puts an outside pull request on the docket: the plane reads its facts, enters the state machine at the matching state, drives reviews and fix rounds as a generated one-unit plan whose pre-check adopts the existing pull request, and hands `merge_ready` to a person; the adopter is the requester and authors the commits. The names are the maintainer's to decide.

### Scope Boundaries

- No new Durable Object class, no new Worker, no model call inside the object, no credential the bot does not hold, no kill or hard stop of a live run, no merge or approval by the plane.
- The memory gate (#1910), the credential refresh (#1915) and the flake rerun (#1921) are observed, not built here.
- Record 0051's unit idle is built by its own plan; U5, U10 and U11 wait for it.

### Deferred to Follow-Up Work

- Adoption's docket panel beyond the table row (after U13).
- A per-run cost cap (record 0046 direction).

### Open Questions

| Question | Blocking? | Owner | Resolves it |
|---|---|---|---|
| The release threshold numbers | deferred (a setting) | the maintainer | the first two windows |
| The soft stop under "never a kill" | deferred (U10 ships behind a setting, `plane.softStop: off` by default) | the maintainer | the first pressure window's latencies |
| The panel's name and adoption's words | deferred | the maintainer | one line |
| The re-ask cadence's number | deferred (a setting) | the plan | the first week's probe counts |

---

## Planning Contract

### Key Technical Decisions

- KTD1. **The ledger object is the plane; the decider is a pure module.** `src/core/plane/decide.ts` is node-free and imported by the Worker and the bot's tests alike, as `runRecord.ts` is; the object applies it inside `transactionSync` so state, writes and effects commit together. (Record 0064, "Where it lives".)
- KTD2. **Three asks at three stages, every `admitted` a reservation.** The admission stage, the ship fork before the host claim, and the executor's attach each ask; `plane_reservations` keyed by thread, plan instance or run holds the answer until the claim promotes it. (Record 0064, "The queue".)
- KTD3. **A queued run is only its queue row.** No registry row, no heartbeat, nothing the drain or the deploy preflight counts; the plane mints the id and `admit` writes the attaching row; the bot dispatches from the stored request through the restart-from-request path that exists. (Delta review B2.)
- KTD4. **What the object owns it writes itself.** Checkpoint steers are `run_inbox` rows and appended units are `coordinator_units` rows plus the Workflow wake the object already sends; only what the bot must do is an effect. (Saturation review M6.)
- KTD5. **Levels, not edges, with a re-ask for silence.** Every reporter re-states its level at boot and on every answer to the bot; the one cadence `plane.reaskMinutes` runs only while something waits on a silent reporter. (Delta review M3 and M6.)
- KTD6. **Drained is what the deploy counts.** The bot's held rows and the resident's in-flight operations, hosted parents and idle units excluded; a unit's review round passes *Closing*. (Delta review B1.)
- KTD7. **Shadow compares the bot's outcome with the decider's, per condition, as inputs land.** The bot posts its own outcome per dispatch; thread, window and deploy conditions enter shadow at U3, the runner's at U5, the resident's at U6. (Migration review M7.)
- KTD8. **Version skew is sequenced by unit order.** The driver's `queued` passing condition (U2) ships alone; the Worker's routes and effects field (U3) land before the bot asks (U4); resident reports (U6) land before the plane accepts their conditions; the memory-first deploy order gives the rest.
- KTD9. **The soft stop ships off.** `plane.softStop` defaults to `off`; the record marks it revisable and the maintainer's word was "never a kill".

### High-Level Technical Design

Ask path: `dispatcher.admit` → `POST /plane/admit` (stage one) → `admitted { reservation }` → the claim promotes it; or `queued` → the bot abandons the registry row, posts the card, and the request sleeps in `plane_queue`. The ship fork asks stage two before `runLedger.open`; `makeExecutor` asks stage three before reserving a seat.

Event path into the object: ledger claims, heartbeats (with the grown body), seals and reclaim outcomes (already the object's calls); `POST /plane/level` from the resident objects and the bot; `POST /plane/outcome` from the bot under shadow; `POST /plane/deploy` from the deploy runner; the webhook intake's `release.grew` and pull request states; the runner's `finish` and the engine status reads; the object's alarm.

Decider: `decide(state, event)` walks the queue oldest first after every event, evaluates the watches the event can change, and returns writes (inbox rows, unit rows, reservations, windows, findings) and effects (`admit`, `card`, `retitle`, `pr_open`, `probe`, `reissue`, `stop_instance`, `handed_card`).

Effect path: the object commits, pushes to `POST /plane/effects` on the bot Worker through the service binding, and repeats unacknowledged effects on heartbeat and sweep answers; the bot executes each once by id and acknowledges on `POST /plane/ack`.

Files, by unit: U1 (`src/core/plane/table.ts`, `src/core/planeService.ts`, `src/core/commands/plane.ts`, `src/channels/planeView.ts`, `web/src/pages/PlanePage.vue`, `docs/reference/specs/orchestration-plane.md`; its pull request is open beside this plan). U2 `src/core/coordinator/driver.ts` (`spawnReturn` passing conditions; the selection re-read before `readyUnits`). U3 `src/core/plane/decide.ts` and its test, `deploy/cloudflare-memory/worker.ts` (tables, `transactionSync` application, the `effects` field on heartbeat and reclaim answers, `/plane/outcome`, `/plane/ack`), `src/core/runLedger/` (the client half), `src/config.ts` (`plane.admission`), `src/core/dispatch/admission.ts` (the outcome post). U4 `deploy/cloudflare/worker.ts` and `deploy/cloudflare-memory/wrangler.template.jsonc` (the binding and `/plane/effects`), `src/core/dispatch/admission.ts` (`AdmissionOutcome` gains `queued`), `src/core/dispatch/reattach.ts` (dispatch from a stored request under a given id), `src/core/runsService.ts` and `src/channels/liveView.ts` (a queued id's page), `src/core/commands/runs.ts` (`runs stop` withdraws), `src/deploy/run.ts` (`deploy.landed`). U5 `src/core/dispatch/ship.ts` (the ask before the claim; the claim after the plan read), `src/core/coordinator/handOff.ts` (append; one-line answers), `deploy/cloudflare-memory/worker.ts` (the engine status read through `SHIP_COORDINATOR`; unit rows; the wake). U6 `deploy/cloudflare-resident/worker.ts` (levels on every answer; the outbox; the registry's drain alarm; the bearer), `src/execution/factory.ts` and `src/execution/resident.ts` (the stage-three ask; forwarding refusals and levels), `deploy/cloudflare-memory/worker.ts` (`/plane/level`, `plane_levels`). U7 `src/core/runLedger/types.ts` (`restartOf`), `src/core/dispatch/reattach.ts` and `record.ts` (`restarting`, the cause read), `src/core/ship/coordinator.ts` (the note renders the cause; the wait through a restarting ending), `src/core/boot.ts` (the reclaim outcome report). U8 `src/core/runLedger/writeThrough.ts` (the heartbeat body), `src/core/runEvents.ts` (`pushed_head.clean`), `src/core/plane/decide.ts` (the steers), `src/core/authz/policy.ts` (the `plane` actor). U9 `src/channels/adminCoordinator.ts` (the runner's open title; `stop_instance`), `src/core/plane/decide.ts`, `src/core/commands/plane.ts` (`plane stop`). U10 `deploy/cloudflare-resident/memoryGuard.ts` (git through the hard line), `src/core/plane/decide.ts` (the pressure window; the soft stop behind `plane.softStop`). U11 `src/core/coordinator/checksIntake.ts` (`pull_request` with dedupe), `src/core/plane/decide.ts` (the window phases), `src/core/commands/plane.ts` (`plane window lift`). U12 `web/src/pages/` (three panels), `src/channels/planeView.ts` (their seeds), `src/channels/costsView.ts` (the redirect). U13 `src/core/commands/plane.ts` (`plane adopt`), `src/core/coordinator/handOff.ts` (the pre-check adopts). U14 nine records' dated amendments. U15 the infrastructure repository's config and secrets; no file here.

### Assumptions

- A resident object can reach the state Worker with the bearer once it is wired (record 0064, "What would change our mind", first test).
- The bot Worker can forward a bearer-gated route to the container as it forwards the runner's step routes (second test).
- One decider evaluation per event fits the object's budget at the evening's peak of 29 live rows (third test, a bench over recorded ledger events).
- The restart-from-request path can dispatch under a given run id (U4 verifies before changing the queue's shape).

---

## Implementation Units

| Unit | Title | Key files | Depends on |
|---|---|---|---|
| U1 | The table | `src/core/plane/table.ts`, `src/core/planeService.ts`, `src/core/commands/plane.ts`, `src/channels/planeView.ts`, `web/src/pages/PlanePage.vue` | none; the plan's first pull request, open beside this one |
| U2 | The driver learns `queued` and re-reads its selection | `src/core/coordinator/driver.ts` | none; its own release |
| U3 | The decider, the tables, the outcome posts, shadow | `src/core/plane/decide.ts`, `deploy/cloudflare-memory/worker.ts`, `src/config.ts` | U1 |
| U4 | The transport and the admission-stage conditions | `deploy/cloudflare/worker.ts`, `src/core/dispatch/admission.ts`, `src/core/dispatch/reattach.ts`, `src/deploy/run.ts` | U3 |
| U5 | The runner conditions and the append | `src/core/dispatch/ship.ts`, `src/core/coordinator/handOff.ts`, `deploy/cloudflare-memory/worker.ts` | U2 released, U4, record 0051's unit idle |
| U6 | The resident levels and conditions | `deploy/cloudflare-resident/worker.ts`, `src/execution/factory.ts`, `src/execution/resident.ts` | U4 |
| U7 | Endings and causes | `src/core/runLedger/types.ts`, `src/core/dispatch/reattach.ts`, `src/core/ship/coordinator.ts`, `src/core/boot.ts` | U3 |
| U8 | The heartbeat facts, the checkpoint steers and the provider condition | `src/core/runLedger/writeThrough.ts`, `src/core/runEvents.ts`, `src/channels/modelProxy.ts`, `src/core/plane/decide.ts`, `src/core/authz/policy.ts` | U3 |
| U9 | The moves | `src/channels/adminCoordinator.ts`, `src/core/plane/decide.ts`, `src/core/commands/plane.ts` | U4, U7 |
| U10 | Saturation | `deploy/cloudflare-resident/memoryGuard.ts`, `src/core/plane/decide.ts` | U6, U8, record 0051's unit idle |
| U11 | The release manager | `src/core/coordinator/checksIntake.ts`, `src/core/plane/decide.ts`, `src/core/commands/plane.ts` | U4, U8, record 0051's unit idle |
| U12 | The panels and the costs fold | `web/src/pages/`, `src/channels/planeView.ts`, `src/channels/costsView.ts` | U4, U11 |
| U13 | Adoption | `src/core/commands/plane.ts`, `src/core/coordinator/handOff.ts` | U9, U11 |
| U14 | The record amendments | `docs/decisions/0046…0063` | the record's acceptance |
| U15 | Settings, secrets and the webhook subscription | the infrastructure repository | U6, U11 |

### U1. The table

- **Goal**: `plane show` and the `/plane` panel answer what is happening, read-only over the stores that exist.
- **Requirements**: R1 to R4 (orchestration-plane.md items 1 to 5).
- **Dependencies**: none. The plan's first pull request, open beside this one as coreplanelabs/switchboard#1936; every later unit builds on it once it merges.
- **Files**: as listed in the index; `docs/reference/specs/orchestration-plane.md` opened with its Code and Tests header.
- **Approach**: tests first over the pure table, the service with fake reads, the command's registration and renders, the view's routing and seed, the page over a seed; then the module, the service, the command, the view, the page, the nav, the preview fixture, the screenshots, the spec.
- **Test scenarios**: a stalled row sorts first; a foreign row reads no-signal; a pull request GitHub cannot read is unknown; a merge-ready unit with an open pull request is an owner gap; a caller without `runs:read` is refused before the service is asked; a live row of this process links through its token.
- **Verification**: the five test files green, red first; `npm run specs:check`; `npm run hygiene:check`; `npm run screenshots:check`; scoped `tsc --noEmit`; CI runs the suite.

### U2. The driver learns `queued` and re-reads its selection

- **Goal**: a `queued` spawn answer is a passing condition, and the unit selection is read at every unit boundary, so a later bot can answer `queued` and append units without killing an instance.
- **Requirements**: R16.
- **Dependencies**: none; ships in a release of its own before U4 and U5.
- **Files**: `src/core/coordinator/driver.ts` and its test; `docs/reference/specs/http-ingress.md` item 9; `docs/reference/specs/agent-ship.md` item 16.
- **Approach**: tests first: a `queued` spawn answer with `at` re-asks under the step policy and never throws; a unit appended to the rows between two units is walked after the current one. Then the passing condition and the re-read before `readyUnits`.
- **Test scenarios**: `409 queued` on the spawn step; a selection that grows mid-walk; a selection that shrinks (a unit merged by hand) is walked as merged.
- **Verification**: the driver suite green, red first; `npm run specs:check`; scoped `tsc --noEmit`.

### U3. The decider, the tables, the outcome posts, shadow

- **Goal**: the object holds the plane's state and decides beside the bot without acting.
- **Requirements**: R5 to R8 (the `effects` field empty until U4 fills it), R24's key.
- **Dependencies**: U1.
- **Files**: `src/core/plane/decide.ts` and `decide.test.ts`; `deploy/cloudflare-memory/worker.ts` and `runs.test.ts`; `src/core/runLedger/ledger.ts`, `runLedgerWorker.ts` and `writeThrough.ts` (the answers' `effects` field and the ack call); `src/core/dispatch/admission.ts` (the outcome post); `src/config.ts` and `src/config/validate.ts`; `docs/reference/specs/orchestration-plane.md` items for the decider, the tables and shadow; `docs/reference/specs/routing-and-config.md` (the key).
- **Approach**: tests first over the decider: a `thread_free` condition flips on a seal; a queue walk admits oldest first and re-evaluates after each admission; an event with no transition returns the state unchanged; effects carry ids. Inside workerd: the tables exist; `transactionSync` commits state and effects together; an outcome post is logged beside the decider's decision; the `effects` field is present and empty; an ack of an unknown id is a no-op. Then the module, the object, the clients and the key.
- **Test scenarios**: a heartbeat answer carries `effects: []`; shadow logs `refused:thread-live` beside `queued` for a second ask on a live thread; `off` posts nothing.
- **Verification**: the decider and Worker tests green, red first; `npm run specs:check`; `npm run docs:check`; the Worker's own typecheck and tests.

### U4. The transport and the admission-stage conditions

- **Goal**: an ask that meets a live thread, a window or a pending deploy queues, holds nothing, and is admitted on the event.
- **Requirements**: R9 to R15.
- **Dependencies**: U3.
- **Files**: `deploy/cloudflare/worker.ts` (the `/plane/effects` route and its forward), `deploy/cloudflare-memory/wrangler.template.jsonc` (the binding), `deploy/cloudflare-memory/worker.ts` (`/plane/admit`, the push, `plane_reservations`), `src/core/dispatch/admission.ts` (`queued` outcome; the ask), `src/core/dispatch/reattach.ts` (dispatch from a stored request under a given id), `src/core/runLedger/decisions.ts` (a claim promotes a reservation), `src/core/runsService.ts` and `src/channels/liveView.ts` (a queued id's page), `src/core/commands/runs.ts` (`runs stop` on a queued id), `src/deploy/run.ts` (`deploy.landed`), the specs' rows (thread-admission items 1, 5, 9; run-history items 29, 41, 42; release-and-deploy item 13).
- **Approach**: tests first: two asks a second apart on one thread, the second `queued` with position 1 and the first's claim promoting its reservation; the seal flips `thread_free` and the `admit` effect carries the attaching row; a duplicate `admit` after a roll is `skipped`; a `queued` run has no heartbeat and is absent from the drain's held set; `runs stop` withdraws and writes a `withdrawn` record; `deploy.landed` flips `deploy_settled`; a push that fails leaves the effect on the next heartbeat answer; a draining generation defers `admit`.
- **Execution note**: verify first that the restart-from-request path can dispatch under a given id (KTD3's assumption); a deviation here is handed back before the queue's shape is built on it.
- **Verification**: the admission, ledger and Worker suites green, red first; the bot Worker's own typecheck and tests; `npm run specs:check`.

### U5. The runner conditions and the append

- **Goal**: a seed that meets a live runner appends to it or waits with a position; an errored runner frees its plan within the re-ask cadence.
- **Requirements**: R17 to R19.
- **Dependencies**: U2 released; U4; record 0051's unit idle for R19.
- **Files**: `src/core/dispatch/ship.ts`, `src/core/coordinator/handOff.ts`, `deploy/cloudflare-memory/worker.ts` (the engine status read through `SHIP_COORDINATOR`, unit rows, the wake, `plane_reservations` by plan instance), `docs/reference/specs/agent-ship.md` items 16 and 10.
- **Approach**: tests first: two seeds for one plan a second apart, the second `queued`; a seed naming new units of a live instance writes the rows and wakes the runner; a seed naming selected units answers one line; an instance the engine reports `errored` frees the plan at the next re-ask; an instance `waiting` past its hosting deadline frees nothing; a `queued` spawn idles the unit and `admit` wakes it with a fresh lease.
- **Verification**: the ship, hand-off and Worker suites green, red first; `npm run specs:check`.

### U6. The resident levels and conditions

- **Goal**: a coding ask that meets an exhausted pool or a memory line waits with a position and is admitted when the resident reports below it, and a silent resident is probed, never waited on forever.
- **Requirements**: R20 to R24.
- **Dependencies**: U4.
- **Files**: `deploy/cloudflare-resident/worker.ts` (levels on every answer, the outbox, the registry's alarm at `until`, the bearer), `deploy/cloudflare-resident/drain.ts`, `src/execution/factory.ts` and `src/execution/resident.ts` (the stage-three ask; forwarding), `deploy/cloudflare-memory/worker.ts` (`/plane/level`, `plane_levels`, the `probe` effect), `src/config.ts` (`plane.reaskMinutes`, `plane.coldFallback`), `docs/reference/specs/resident-repos.md` items 19, 38, 69 and the gate's item, `docs/reference/specs/execution.md` items 25 to 27.
- **Approach**: tests first: a resident's attach answer carries `levels`; a crossing posts a level; a boot re-states it; the drain's expiry posts `cleared` from the alarm; a coding ask on a resident above the soft line queues at stage three and holds no registry row; a level below the line admits it; a read preset falls cold; an admitted run refused a seat re-enters at its position; a resident with no report since its generation changed is `unknown` and a `probe` effect fires at the cadence; `restartOf` passes.
- **Verification**: the resident Worker's own typecheck and tests; the executor suites; the Worker suites; `npm run specs:check`.

### U7. Endings and causes

- **Goal**: an ending's cause is the plane's fact, rendered by everyone, and a restarted child never orphans its unit.
- **Requirements**: R25 to R27.
- **Dependencies**: U3.
- **Files**: `src/core/runLedger/types.ts`, `src/core/dispatch/reattach.ts`, `src/core/dispatch/record.ts`, `src/core/ship/coordinator.ts`, `src/core/coordinator/driver.ts` (waiting through a restarting ending), `src/core/boot.ts`, `deploy/cloudflare-memory/worker.ts` (the cause on close; the alarm), `docs/reference/specs/run-history.md` items 33, 36, 39, 47, 47a, `docs/reference/specs/agent-ship.md` item 15.
- **Approach**: tests first: a resident replacement's restart carries `restarting: true` and the runner's wait re-arms instead of ending the unit; a `restartOf` claim sends `child_resumed`; the reclaim's `closed` outcome records `lease_lapsed`; a row resumed records nothing; the interrupted note renders the cause word; an older Worker leaves today's words; the alarm at a lease end offers the row and the owner's heartbeat refreshes it.
- **Verification**: the reattach, coordinator, boot and Worker suites green, red first; `npm run specs:check`.

### U8. The heartbeat facts, the checkpoint steers and the provider condition

- **Goal**: a stalled or push-less coding child reads one fixed sentence at its next boundary, from the plane, once per round per cause; a provider transient parks a run on the provider's next success instead of ending it.
- **Requirements**: R28 to R31.
- **Dependencies**: U3.
- **Files**: `src/core/runLedger/writeThrough.ts` and `runLedgerWorker.ts` (the heartbeat body), `src/core/runEvents.ts` (`pushed_head.clean`), `src/core/harness/pi/harness.ts` (the clean fact at push; the held turn), `src/channels/modelProxy.ts` (the provider level report; the failure past the retry parks instead of erroring), `src/core/plane/decide.ts` (`long_call`, `no_push`, `provider_up`), `deploy/cloudflare-memory/worker.ts` (the inbox write in the decider's transaction; `plane_levels` for providers), `src/core/authz/policy.ts` and `grants.ts` (the `plane` actor), `docs/reference/specs/run-history.md` item 40 and the heartbeat's row, `docs/reference/specs/model-proxy.md` (the level report and the held turn), `docs/reference/specs/authorization.md`, `docs/reference/specs/thread-admission.md` item 2.
- **Approach**: tests first: a heartbeat carries the round, the in-flight call, the last event and the pushed head; a call past its bound writes one inbox row with the sentence and the `plane` sender; a second heartbeat in the same round writes none; a new round writes one again; the same sentence from two causes is written once per round; a 502 past the proxy's retry reports the provider `down`, the run parks with its turn held and no `harness_error`, the next success from another run reports `up` and one steer re-issues the held turn.
- **Verification**: the ledger, harness, proxy, decider and Worker suites; `npm run specs:check`.

### U9. The moves

- **Goal**: a mistitled or orphaned or conflicting pull request and a died or stopped runner are recovered by a named move, or a finding is filed.
- **Requirements**: R31a to R35.
- **Dependencies**: U4, U7.
- **Files**: `src/channels/adminCoordinator.ts` (the runner's open title; `stop_instance`), `src/core/plane/decide.ts`, `src/core/commands/plane.ts` (`plane stop`), `src/core/plane/findings.ts` (dedupe; the research dispatch and the filing path), `docs/reference/specs/agent-ship.md` items 10 and 16, `docs/reference/specs/command-registry.md` and `authorization.md` (`plane stop` destructive).
- **Approach**: tests first: the runner's open uses the head commit's subject when it passes the rule; a tracked pull request with a failing title gets `retitle`; a child that ends with a pushed branch and no runner gets `pr_open`; a dirty approved head opens a rebase round and the approval is voided at the new head; `plane stop` ends the instance and the child in one move and records both; an `errored` instance with unfinished units emits `reissue` keyed by attempt; a move whose precondition is gone is `skipped`; two findings on one subject are one.
- **Verification**: the coordinator, decider and command suites; the conformance suite's rows for `plane stop`; `npm run specs:check`.

### U10. Saturation

- **Goal**: a resident above its soft line closes its door to coding, steers its children once, and never kills.
- **Requirements**: R36 to R38.
- **Dependencies**: U6, U8; record 0051's unit idle for R38.
- **Files**: `deploy/cloudflare-resident/memoryGuard.ts` and `worker.ts` (git through the hard line), `src/core/plane/decide.ts` (the pressure window; the soft stop behind `plane.softStop`), `src/config.ts`, `docs/reference/specs/resident-repos.md` (the gate's item), `docs/reference/specs/orchestration-plane.md`.
- **Approach**: tests first: a soft-side level opens the window and writes nine steers for nine children once; a below-side level closes it; a `git push` passes the hard line while `npx vitest` is refused; with `plane.softStop: on`, a child with a clean newest push is soft-stopped and a child whose newest push is not clean is not; with the setting off nothing stops.
- **Verification**: the resident Worker's tests, the decider suite; `npm run specs:check`.

### U11. The release manager

- **Goal**: a release past its threshold declares a quiet window, drains to what the deploy counts, hands the merge to a person and lifts on the deploy's report.
- **Requirements**: R39 to R41.
- **Dependencies**: U4, U8; record 0051's unit idle.
- **Files**: `src/core/coordinator/checksIntake.ts` (`pull_request` with 0047's dedupe), `src/core/plane/decide.ts` (the phases), `src/core/commands/plane.ts` (`plane window lift`), `src/config.ts` (`release.quiet`), `docs/reference/specs/release-and-deploy.md` items 13 and 31, `docs/reference/specs/http-ingress.md` item 12, `docs/reference/specs/orchestration-plane.md`.
- **Approach**: tests first: the twelfth merge opens the window; coding queues and a review of a unit in flight passes *Closing*; *Drained* reads the preflight's numbers with a hosted parent and an idle unit live; the handed card names the release and calls no merge; `deploy.landed` without the resident lifts the bot's part and leaves `fleet_open(resident)` closed; a merge during *Quiet* moves to *Closing*; a redelivered `closed` event fires nothing twice; `plane window lift` lifts.
- **Verification**: the intake, decider and command suites; `npm run specs:check`.

### U12. The panels and the costs fold

- **Goal**: the queue, the windows and the findings are panels beside the table, and the costs page lives under the set.
- **Requirements**: R42.
- **Dependencies**: U4, U11.
- **Files**: `web/src/pages/PlaneQueuePage.vue`, `PlaneWindowsPage.vue`, `PlaneHealthPage.vue` and their tests, `web/src/routes.ts`, `src/channels/planeView.ts` (their seeds), `src/channels/costsView.ts` (the redirect), `scripts/web-preview.ts`, `src/docs/screenshotManifest.ts`, `docs/reference/specs/orchestration-plane.md`, `docs/reference/specs/costs.md`.
- **Approach**: tests first over the seeds and the pages; `screenshots:gen`.
- **Verification**: the view and page suites; `npm run screenshots:check`; `npm run specs:check`.

### U13. Adoption

- **Goal**: an outside pull request handed to the plane is finished through the review loop to merge-ready.
- **Requirements**: R43.
- **Dependencies**: U9, U11.
- **Files**: `src/core/commands/plane.ts` (`plane adopt`), `src/core/coordinator/handOff.ts` and `src/core/ship/preflight.ts` (the pre-check adopts an existing pull request), `src/core/plane/decide.ts`, `docs/reference/specs/orchestration-plane.md`, `docs/reference/specs/agent-ship.md` item 10.
- **Approach**: tests first: an adopted pull request enters at `reviewed`, `approved` or `dirty` per its facts; the fix round adopts the existing pull request and opens none; `merge_ready` hands to a person; the adopter is the requester.
- **Verification**: the command, hand-off and decider suites; `npm run specs:check`.

### U14. The record amendments

- **Goal**: records 0046, 0047, 0051, 0057, 0059, 0060, 0061, 0062 and 0063 carry the dated amendment sentences record 0064 lists, each with its re-evaluation.
- **Requirements**: record 0064, "Records this design amends".
- **Dependencies**: the record's acceptance.
- **Files**: the nine records under `docs/decisions/`.
- **Verification**: `npm run decisions:check`; `npm run hygiene:check`; `npm run build -w docs`.

### U15. Settings, secrets and the webhook subscription

- **Goal**: production runs the plane on.
- **Requirements**: R7, R24, R40's setting.
- **Dependencies**: U6, U11 released.
- **Files**: the infrastructure repository's bot config (`plane.admission: shadow`, then `on`; `plane.reaskMinutes`; `release.quiet`) and secrets (the resident objects' state-Worker bearer); the GitHub App's webhook subscription gains `pull_request`. No file in this repository.
- **Approach**: shadow for a week with the disagreement line read daily; the flip to `on` once the line reads zero for the conditions that landed; the receipts posted per spec ledger. Human-gated.

---

## Verification Contract

| Proof | Command or procedure | Units |
|---|---|---|
| Unit tests red then green, per unit | `npx vitest run <the unit's test files>` | U1 to U13 |
| The touched Worker's own gate | `npm run verify -w deploy/cloudflare-memory`, `-w deploy/cloudflare`, `-w deploy/cloudflare-resident` as touched | U3 to U11 |
| Scoped types | `tsc --noEmit -p <the touched tsconfig>` under `NODE_OPTIONS=--max-old-space-size=6144` | every unit |
| Spec proofs bind | `npm run specs:check` | every unit |
| Public hygiene | `npm run hygiene:check` | every unit |
| Generated regions | `npm run docs:gen` then `npm run docs:check` | U1, U3, U9, U11, U13 |
| Screenshots | `npm run screenshots:gen` then `npm run screenshots:check` | U1, U12 |
| Records | `npm run decisions:check` | U14 |
| The full suite, types and verify | CI, on every push; never a child's criterion | every unit |
| Live receipts | a queued ask admitted on the event it named; a steer that landed and its push; a window that lifted on `deploy.landed`; the shadow line at zero for a week | U4, U6, U8, U11, U15 |

## Definition of Done

- Every unit merged through the review loop with its spec rows bound and its tests red first.
- The shadow line reads zero disagreements for a week on the conditions that landed, then `plane.admission: on`.
- The live receipts above posted on the owning specs' receipts issues.
- Record 0064 moved to accepted by the maintainer, its open questions answered in a dated note; the nine amendments landed.
- No dead-end or experimental code left from an abandoned approach; no timer added beyond the three the record names.
