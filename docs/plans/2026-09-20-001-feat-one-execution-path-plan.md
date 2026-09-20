---
title: The one door has one execution path - the table, the click, the floor, the owner rule, the typed line, the hand-back's retirement - Plan
type: feat
date: 2026-09-20
status: proposed
artifact_contract: ce-unified-plan/v1
artifact_readiness: implementation-ready
product_contract_source: ce-plan-bootstrap
execution: code
extends: ../decisions/0069-the-one-door-has-one-execution-path-a-bind-runs-clicks-or-routes-a-violation-is-re-asked-a-disagreement-floors-and-no-chat-surface-hands-back-a-line-to-retype.md
---

# The one door has one execution path - the table, the click, the floor, the owner rule, the typed line, the hand-back's retirement - Plan

## Goal Capsule

- **Objective**: Build [record 0069](../decisions/0069-the-one-door-has-one-execution-path-a-bind-runs-clicks-or-routes-a-violation-is-re-asked-a-disagreement-floors-and-no-chat-surface-hands-back-a-line-to-retype.md): one execution table — bind kind × surface → run / click / route / re-ask / refuse — owned by one module every caller asks, with record 0067's seam as the only re-ask and the route as the only floor, and no chat surface ever handed a line to retype. The day's fourteen defects (D1 to D14 in the record) become replay fixtures first, the table lands as a behavior-preserving refactor second, and each behavioral cell flips in its own unit so production is green between units.
- **Authority**: record 0069 (proposed; this plan is the artifact its acceptance is judged on) over [record 0057](../decisions/0057-the-operator-is-the-one-door-a-model-binds-every-chat-input-and-deterministic-code-authorizes-fences-and-executes.md) (the operator and the split kept; its hand-back clauses amended as the record states), [record 0067](../decisions/0067-one-seam-for-a-structured-answer-a-violation-is-re-asked-with-the-violation-named-and-the-callers-declared-floor-holds-never-a-refusal-shown-to-the-person.md) (the seam, unchanged, as the table's re-ask column), [record 0044](../decisions/0044-a-routed-write-is-confirmed-in-proportion-to-its-blast-radius.md) (the ladder and the store, extended into the one offer path), [record 0054](../decisions/0054-a-refusal-the-person-caused-is-one-question-with-a-best-guess.md) (the refusal renderer kept; the verifier's disagreement leaves its causes), [record 0039](../decisions/0039-the-front-door-writes-nothing-from-prose-and-never-routes-twice.md) (amended: the paste stops being a confirmation on chat), records [0051](../decisions/0051-a-thread-has-one-owner-for-its-life-a-message-is-one-event-in-a-chosen-mode-and-a-pipeline-idles-instead-of-ending.md), [0055](../decisions/0055-a-unit-has-one-thread-and-a-round-reads-the-checks-at-its-head.md) and [0060](../decisions/0060-a-ship-pipeline-is-a-live-run-for-its-whole-life-and-runs-on-every-channel-that-can-open-a-thread.md) (the owner rule the table reads first). Plan 002 ([docs/plans/2026-09-18-002-feat-the-operator-is-the-one-door-plan.md](2026-09-18-002-feat-the-operator-is-the-one-door-plan.md)) takes one dated note: its U12 is absorbed by E6, its U13 is narrowed into E6, its U16 is narrowed to E7's cell change.
- **Execution profile**: eight units, each one pull request through the review loop and each sized to a review. E1 and E2 change nothing a person reads. E3 to E7 each flip one class of cells with its fixtures holding in the same pull request. E8 deletes what nothing renders any more. A child proves its unit with changed-set forms: `npx vitest run` on the unit's test files by name, `tsc --noEmit -p` the touched tsconfig, prettier on the changed files, `npm run specs:check`, and `node scripts/public-hygiene.mjs` where the unit touches fixtures or docs; it pushes a head early and lets CI's `npm run verify` judge it.
- **Stop conditions**: a unit stops and asks if it would flip a cell whose fixtures do not hold on its own replay; render any new line a person is expected to retype on a chat surface; add a second retry loop beside the seam; let a floored request re-enter the operator; weaken the confirm store's one-row-per-thread or consume-once invariants; or change a spec item without its bound test in the same pull request.

---

## Product Contract

### Summary

Fourteen fixtures make the day's failures the regression suite; one module makes the outcome of every bind a table cell; six cells flip one unit at a time — the click replaces the operator's write hand-back, the route replaces the verifier's, the bind repairs make preset lines carry the person's words and refusals carry their whole sentence, the owner rule is read before any directive, the typed line runs as typed — and the hand-back's render, cut note and paste machinery retire when no path produces them.

### Requirements

- R1. `src/load` gains a door row of fourteen fixtures, D1 to D14 exactly as record 0069 tables them, each with the table's expected outcome and the unit that turns it green; the row scores every fixture whose unit is merged and prints the rest as pending; the fixtures pass public hygiene.
- R2. One module owns `decideExecution(bind, surface) → run | click | route | re-ask | refuse`: pure, total over the bind kinds and surfaces, every cell covered by a table test; the route stage's write answer, the operator executor, the verifier's return, admission's fold and the confirm click ask it; no caller renders an outcome the table did not name.
- R3. On a chat surface a registry bind at or above the effective confirm class is offered as one click through record 0044's store — the one mint path whichever caller asks; a store unreachable at mint, or a line `redactSecrets` would alter, is a refusal naming why; several write binds in one decision meet the store's one-row-per-thread invariant: the first mints, the rest are refused naming the pending row. On a typed surface the refusal names the typed form. No path renders `To run this:` on a chat surface.
- R4. A verifier disagreement, failure or timeout floors to the route: the route stage runs the person's own request for that event, the disagreement and the verdict's reason ride the run's record, the event never re-enters the operator, and no sentence about the verifier reaches the person; the verifier's prompt judges whether the preset or command fits the ask, with each preset's meaning named.
- R5. A preset bind carries the person's words verbatim as the request; a leading directive-shaped token (`<word>:<preset>`) in the request is stripped when the operator binds the same preset, so the bound line never reads as a duplication; a refusal's text is carried whole under `ROUTE_RECEIPT_CAP`, never cut at a quote or a bracket; a typo'd directive word binds the preset the words mean.
- R6. A reply into a thread a live run or a pipeline owns is decided by the owner rule before any directive is honoured: it folds into the owner (a steer to the unit's live child, whichever thread holds it) or is refused naming the thread to reply in; it never starts a rival run. A message whose line the person's own chat grammar parses runs as typed through the ladder — the operator never re-spells it — and the directive words' read moves behind the table's owner (plan 002 U12 absorbed, U13 narrowed).
- R7. When every cell above holds on the replay, the chat hand-back retires: `HAND_BACK_PREFIX` leaves every chat render, `HAND_BACK_CUT_NOTE` is deleted, `pastedRoute` and the `outcome: pasted` machinery retire with their spec rows, and the web composer's prefill reads the click row instead of the hand-back line. The typed surfaces keep naming lines in refusals.
- R8. Every spec item a unit changes is changed in the same pull request with its proof bound (`npm run specs:check` passes), and each of records 0039, 0044, 0054 and 0057 gains its dated `## Amended` note (the replacement sentences in record 0069) in the same pull request as the unit that makes it true.

### Acceptance Examples

- AE1. **Covers R2, R3 (D13).** Given `routing.operator: on` and an operator decision binding `config set channel --models.coding <ref>`, when the bind executes on Slack, then one confirmation row is minted through record 0044's store, the button shows the full line, no `To run this:` renders, and the same command routed under `off` mints through the same path.
- AE2. **Covers R4 (D6, D14).** Given a plain-words fix ask whose preset bind the verifier refuses (or the verifier's provider times out), then the route stage runs the ask on the person's own words, the record carries the disagreement, and the person sees the routed run's ordinary card.
- AE3. **Covers R5 (D1, D4, D10, D11, D12).** Given `adgent:ship in <repo>, <task>`, then the bind is `agent:ship` on the request with the typo'd token stripped, the verifier sees no duplication, and a refusal produced anywhere carries its whole sentence.
- AE4. **Covers R6 (D8, D9).** Given a live pipeline's seed thread, a reply opening with `agent:coding <steer text>` folds to the unit's live child or is refused naming the unit thread — never a new run; and `runs stop <id> --mode hard` typed in any thread runs as typed, never re-spelled into `runs_stop`.
- AE5. **Covers R7.** Given every cell green on the replay, no module under `src/core/dispatch` or `src/channels` renders `To run this:` to a chat surface, and the paste machinery is gone with its spec rows rewritten.

### Scope Boundaries

Not here: the confirm default's level (the write row's chat cell moves only under plan 002 U16's gates, as record 0069 narrows them); plan 002's U14, U15, U18 and U19; the plane's queue (record 0064); the intake gate (record 0058); any change to the seam's parsers or retry bound (record 0067). `routing.operator: off` stays the rollback lever through every unit, and under it the route stage asks the same table.

---

## Planning Contract

### Key Technical Decisions

- KTD1. **Fixtures before the module, the module before any cell.** E1 ships the fourteen fixtures scoring only what is merged; E2 ships the table as a byte-equivalent refactor (every cell holds today's behavior, proven by the existing dispatcher, route and operator tests passing unchanged); E3 to E7 flip cells one unit at a time, each with its fixtures in the same pull request. Governs R1, R2; keeps production green between units.
- KTD2. **The table is data a caller executes, never a branch a caller writes.** `decideExecution` returns a closed union; callers switch on it exhaustively, so a new cell is a compile error at every caller — the property that makes the fifteenth defect a missing cell. Governs R2.
- KTD3. **One mint path.** The route stage's existing offer code (`answerCommand`'s row mint) moves into the table's module and the operator executor calls it; the store's invariants are unchanged and the serialization of multi-bind decisions is the caller-visible rule (first write clicks, later writes refused naming the pending row). Governs R3.
- KTD4. **The floor is the route stage under `off` semantics for that one event.** A verifier floor or a seam floor runs `routeRequest` on the person's message with the operator's decision and attempts attached to the resulting run's record; the operator flag is untouched and the event is marked floored so it cannot re-enter the operator. Governs R4.
- KTD5. **The owner rule is asked as data, before the bind.** Admission exposes `ownerOf(threadKey)` and the table's steer/reply rows read it ahead of any directive; `decideFollowUp` stops reading `directives.agent` as an override (plan 002 U12/U13 absorbed and narrowed as record 0069 states). Governs R6.
- KTD6. **Deletion last, and only of what nothing renders.** E8 runs a tree-wide assertion that no chat render emits `HAND_BACK_PREFIX` before deleting the constant's chat uses, the cut note and the paste machinery; the constant itself survives only where typed surfaces name lines in refusals. Governs R7.

### Sequencing

E1 (fixtures, no production change) → E2 (the table, byte-equivalent) → E3 (the click) and E4 (the verifier floor), independent of each other → E5 (the bind and refusal repairs) → E6 (the owner rule and the typed line, which depends on E5's directive handling) → E7 (the write-cell default, gated) → E8 (the retirement, which depends on E3 to E6). A rollback at any point is one revert; `routing.operator: off` remains live throughout.

---

## Implementation Units

| E-ID | Title | Key files | Depends on | Defects |
|---|---|---|---|---|
| E1 | The fourteen fixtures and the door row | `src/load/routeDoorFixtures.ts`, `src/load/routeReplay.ts`, `scripts/load.ts` | none | D1–D14 as fixtures |
| E2 | The execution table, byte-equivalent | `src/core/dispatch/execution.ts`, `src/core/dispatch/route.ts`, `src/core/dispatch/operator.ts`, `src/core/dispatch/reply.ts` | E1 | none (refactor) |
| E3 | The click on every write path | `src/core/dispatch/execution.ts`, `src/core/dispatch/operator.ts`, `src/core/confirmations.ts`, `src/core/dispatch/confirm.ts` | E2 | D13 |
| E4 | The verifier floors to the route | `src/core/dispatch/operator.ts`, `src/core/dispatch/route.ts`, `src/core/dispatch/reply.ts`, `src/core/dispatcher.ts` | E2 | D5, D6, D12, D14 |
| E5 | The bind and refusal repairs | `src/core/dispatch/operator.ts`, `src/core/dispatch/reply.ts` | E2 | D1, D2, D3, D4, D10, D11 |
| E6 | The owner rule before the bind; the typed line runs as typed | `src/core/dispatch/admission.ts`, `src/core/threadAdmission.ts`, `src/core/dispatcher.ts`, `src/directives.ts`, `src/core/dispatch/execution.ts` | E4, E5 | D7, D8, D9 |
| E7 | The write cell's default (narrowed U16) | `src/config/profile.ts`, `src/core/dispatch/execution.ts` | E3, plan 002 U16's gates | none |
| E8 | The hand-back retires from chat | `src/core/dispatch/handBack.ts`, `src/core/dispatch/route.ts`, `src/core/dispatch/fastPath.ts`, `src/core/commandChat.ts`, `web/src` (the composer prefill) | E3, E4, E5, E6 | none (deletion) |

### E1. The fourteen fixtures and the door row

- **Goal**: `npm run load -- route` prints a door row scoring D1 to D14, each fixture the day's message shape with the table's expected outcome and the unit that turns it green; unmerged units' fixtures print pending, so the row is green at head.
- **Requirements**: R1, R8 (load-harness item 17).
- **Approach**: fixtures ported from issues 1993, 2010 and 2025 with names, ids and slugs neutralized; the row's scorer reads each fixture's `unit` tag against a merged-units list the replay carries.
- **Test scenarios**: a fixture whose unit is unmerged scores pending, never fails; D3's fixture types the handed-back line and expects a run once E3 lands; public hygiene passes over the fixture file.
- **Verification**: `src/load/routeReplay.test.ts::the door row scores the fourteen defect fixtures::*` green, red first; `node scripts/public-hygiene.mjs`; `npm run specs:check`; CI's `verify` green.

### E2. The execution table, byte-equivalent

- **Goal**: `decideExecution(bind, surface)` exists, pure and total, and the route stage's write answer, the operator executor and the verifier's return execute its cells — with every cell holding today's behavior, hand-backs included, so no rendered byte changes.
- **Requirements**: R2, R8 (routing-and-config items 21, 25 and 29 gain the table as the owner, outcomes unchanged).
- **Approach**: extract, don't change — the existing branches become cells; the existing dispatcher, route and operator test files pass unchanged as the byte-equivalence proof; the table test enumerates bind kind × surface totality.
- **Test scenarios**: every bind kind × surface pair returns a cell (totality); an unknown bind kind refuses to compile; the operator's write hand-back and the route stage's click both come from the table and match today's bytes.
- **Verification**: `src/core/dispatch/execution.test.ts::the execution table is total and owns every outcome::*` green, red first; `src/core/dispatcher.test.ts`, `src/core/dispatch/route.test.ts`, `src/core/dispatch/operator.test.ts` pass unchanged; `npm run specs:check`; CI's `verify` green.

### E3. The click on every write path

- **Goal**: the operator's write-class registry bind mints record 0044's row through the one offer path (D13's `To run this:` beside the click ends); multi-bind decisions serialize onto one row per thread; store-unreachable and unshowable lines refuse by name on chat.
- **Requirements**: R3, R8 (routing-and-config item 25; slack-channel item 14). Record 0044's amendment note lands here; record 0039's too.
- **Test scenarios**: an operator `config set channel` bind on Slack mints one row with the full line and renders no hand-back; a second write bind in the same decision is refused naming the pending row; a store that throws at mint yields a named refusal, never a paste; the CLI's prose path names the typed form in its refusal.
- **Verification**: `src/core/dispatch/operator.test.ts::a write bind is offered as one click, never handed back::*` and `src/core/dispatch/confirm.test.ts` green, red first; the D13 fixture holds on the replay; `npm run specs:check`; CI's `verify` green.

### E4. The verifier floors to the route

- **Goal**: a verifier disagreement, failure or timeout runs the route stage on the person's own request, the decision and verdict on the resulting run's record; the verifier prompt names each preset's meaning so agreement is about fit; nothing about the verifier is rendered to the person.
- **Requirements**: R4, R8 (routing-and-config items 25 and 29). Record 0054's and record 0057's amendment notes land here; `renderVerifierHandBack` is deleted.
- **Test scenarios**: a scripted disagreement on a preset bind yields the routed run with the disagreement on its record and no verifier sentence in any reply; a transport failure floors the same way; a floored event never re-enters the operator; the two `src/cli.ask.test.ts` process tests pass through the floor unchanged; D6's misread reasons become fixtures the new prompt binds right.
- **Verification**: `src/core/dispatch/operator.test.ts::a verifier disagreement floors to the route::*` green, red first; the D5, D6, D12, D14 fixtures hold; `npm run specs:check`; CI's `verify` green.

### E5. The bind and refusal repairs

- **Goal**: a preset bind carries the request verbatim with a leading directive-shaped token stripped when the operator binds that preset; a typo'd directive word binds the preset the words mean; a refusal's text survives whole under the cap, never cut at a quote or a bracket.
- **Requirements**: R5, R8 (routing-and-config item 29).
- **Test scenarios**: `adgent:ship in <repo>, <task>` binds `agent:ship` on the stripped request (D10); the bound line contains no doubled directive (D4, D12's duplication read gone); a refusal whose sentence contains `("` reaches the person and the record whole (D11); a `ship` bind without the request's words stays the seam's violation (D1 to D3, guarding record 0067's amendment).
- **Verification**: `src/core/dispatch/operator.test.ts::a preset bind carries the person's words and a refusal its whole sentence::*` green, red first; the D1–D4, D10, D11 fixtures hold; `npm run specs:check`; CI's `verify` green.

### E6. The owner rule before the bind; the typed line runs as typed

- **Goal**: a reply into an owned thread folds or is refused naming the thread, whatever directive it opens with (D9); a steer bound as prose folds instead of being lost (D7); a line the chat grammar parses runs as typed through the ladder and the operator never re-spells it (D8); the directive words' read and stage A's separate render paths move behind the table's owner — plan 002 U12 absorbed, U13 narrowed, its dated note added.
- **Requirements**: R6, R8 (thread-admission items 1 and 9; routing-and-config items 1 to 3 and 10).
- **Test scenarios**: `agent:coding <steer>` in a live pipeline's seed thread folds to the unit's live child or refuses naming the unit thread, never a new run; `runs stop <id> --mode hard` runs as typed and is never re-bound to `runs_stop` (an operator bind that re-spells a parseable line is a table refusal); a directive-headed message binds through the one path with the directive honoured inside the owner rule; the directive replay row holds.
- **Verification**: `src/core/dispatch/admission.test.ts::the owner rule is read before the directive::*` and `src/core/dispatcher.test.ts::a typed line runs as typed and is never re-spelled::*` green, red first; the D7, D8, D9 fixtures and the directive row hold; `npm run specs:check`; CI's `verify` green.

### E7. The write cell's default (narrowed U16)

- **Goal**: the write row's chat cell moves from `click` to `run` only when plan 002 U16's gates hold (the write and planted rows twice on the final prompt, the requester fix deployed); a guest's binds keep the click; until then this unit does not land.
- **Requirements**: R2, R8 (routing-and-config item 25; authorization item 14).
- **Verification**: `src/core/dispatch/execution.test.ts::the write cell's default::*` green, red first; the gate receipts in the pull request body; `npm run specs:check`; CI's `verify` green.

### E8. The hand-back retires from chat

- **Goal**: no chat render emits `HAND_BACK_PREFIX`; `HAND_BACK_CUT_NOTE` is deleted; `pastedRoute` and the `outcome: pasted` machinery retire with their spec rows; the web composer's prefill reads the click row; the typed surfaces keep naming lines in refusals.
- **Requirements**: R7, R8 (routing-and-config items 21 and 25 rewritten; web-chat's composer row rewritten).
- **Test scenarios**: a tree assertion that no module under `src/core/dispatch` or `src/channels` renders the prefix to a chat surface; the web composer fills from a click row; a typed-surface refusal still names the line; the replay's paste counters are gone from the volume line.
- **Verification**: `src/core/dispatch/route.test.ts` and `src/core/dispatch/fastPath.test.ts` (deleted with their spec rows rebound) — `src/core/dispatch/execution.test.ts::no chat render emits the hand-back prefix::*` green, red first; `npm run specs:check`; CI's `verify` green.

---

## Verification Contract

| Proof | Command or procedure | Units |
|---|---|---|
| Unit tests red then green, per unit | `npx vitest run <the unit's test files>` | E1 to E8 |
| Spec bindings resolve | `npm run specs:check` | E1 to E8 |
| Public hygiene over fixtures and docs | `node scripts/public-hygiene.mjs` | E1, E8 |
| The whole gate | `npm run verify`, run by CI on the pull request | E1 to E8 |
| Replay: the door row | `npm run load -- route --provider anthropic --model <strong tier> --verify`: every D-fixture whose unit is merged holds; posted with the head sha it ran against | E1, then each of E3 to E6 for its fixtures |
| Replay: the directive row | the same run: the directive words bound as words | E6 |
| Live, human-gated: the click | an operator-bound `config set channel` on Slack shows one button with the full line and no hand-back text; the click runs it | E3 |
| Live, human-gated: the floor | a preset ask under a scripted verifier outage starts the routed run with no verifier sentence in the thread | E4 |
| Live, human-gated: the owner rule | a directive reply in a live pipeline's seed thread folds or is refused naming the unit thread; a typed `runs stop` runs as typed | E6 |

A posted row is a comment on the routing-and-config receipts ledger, naming the head sha and the evidence link.

---

## Definition of Done

- E1 and E2 merged with no rendered byte changed and the door row green at head.
- E3, E4, E5 and E6 merged in order, each with its D-fixtures holding in the same pull request and the amendment notes of records 0039, 0044, 0054 and 0057 landed with the units that make them true.
- E7 merged only when U16's gates hold, with the receipts in its body.
- E8 merged with the hand-back gone from every chat render and the paste machinery's spec rows rewritten.
- Plan 002's dated note (U12 absorbed, U13 narrowed, U16 narrowed) added; the maintainer moves record 0069's status.
- No abandoned attempt code remains in any unit's diff.
