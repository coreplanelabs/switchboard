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

- **Objective**: Build [record 0069](../decisions/0069-the-one-door-has-one-execution-path-a-bind-runs-clicks-or-routes-a-violation-is-re-asked-a-disagreement-floors-and-no-chat-surface-hands-back-a-line-to-retype.md) as amended 2026-09-20: the operator is one agent loop with typed tool calls as its only way to act — bind a preset with typed arguments, run a registry command, ask a question that parks the thread's pending state, or end the turn — owned by one module every caller asks; refusals come only from the policy table, the verifier retires, the readers' route is the last-resort floor for a turn that ends with no tool call, and no chat surface is ever handed a line to retype. The loop lands first, at the top of the queue, carrying the day's defects (D1 to D14 in the record) and the first night's four door failures (N1 to N4) as its fixtures; the remaining cells flip one unit at a time so production is green between units.
- **Authority**: record 0069 (accepted 2026-09-20, as amended — the loop) over [record 0057](../decisions/0057-the-operator-is-the-one-door-a-model-binds-every-chat-input-and-deterministic-code-authorizes-fences-and-executes.md) (the operator and the split kept; its hand-back clauses amended as the record states), [record 0067](../decisions/0067-one-seam-for-a-structured-answer-a-violation-is-re-asked-with-the-violation-named-and-the-callers-declared-floor-holds-never-a-refusal-shown-to-the-person.md) (the seam, unchanged, as the table's re-ask column), [record 0044](../decisions/0044-a-routed-write-is-confirmed-in-proportion-to-its-blast-radius.md) (the ladder and the store, extended into the one offer path), [record 0054](../decisions/0054-a-refusal-the-person-caused-is-one-question-with-a-best-guess.md) (the refusal renderer kept; a refusal names its policy row, and the verifier retires), [record 0039](../decisions/0039-the-front-door-writes-nothing-from-prose-and-never-routes-twice.md) (amended: the paste stops being a confirmation on chat), records [0051](../decisions/0051-a-thread-has-one-owner-for-its-life-a-message-is-one-event-in-a-chosen-mode-and-a-pipeline-idles-instead-of-ending.md), [0055](../decisions/0055-a-unit-has-one-thread-and-a-round-reads-the-checks-at-its-head.md) and [0060](../decisions/0060-a-ship-pipeline-is-a-live-run-for-its-whole-life-and-runs-on-every-channel-that-can-open-a-thread.md) (the owner rule the table reads first). Plan 002 ([docs/plans/2026-09-18-002-feat-the-operator-is-the-one-door-plan.md](2026-09-18-002-feat-the-operator-is-the-one-door-plan.md)) takes one dated note: its U12 is absorbed by E6, its U13 is narrowed into E6, its U16 is narrowed to E7's cell change.
- **Execution profile**: five units after the rewrite of 2026-09-20 (E2 absorbed E4, E5 and E6), each one pull request through the review loop and each sized to a review. E2 — the loop — lands first, at the top of the queue, with its fixtures in the same pull request. E1's door row then scores every fixture at head; E3 and E7 flip their cells; E8 deletes what nothing renders any more. A child proves its unit with changed-set forms: `npx vitest run` on the unit's test files by name, `tsc --noEmit -p` the touched tsconfig, prettier on the changed files, `npm run specs:check`, and `node scripts/public-hygiene.mjs` where the unit touches fixtures or docs; it pushes a head early and lets CI's `npm run verify` judge it.
- **Stop conditions**: a unit stops and asks if it would flip a cell whose fixtures do not hold on its own replay; render any new line a person is expected to retype on a chat surface; add a second retry loop beside the seam; let a floored request re-enter the operator; weaken the confirm store's one-row-per-thread or consume-once invariants; or change a spec item without its bound test in the same pull request.

---

## Product Contract

### Summary

One unit lands the operator as a single agent loop — typed tool calls as the only way to act, a question parked as the thread's pending state and rebound by the person's next words, refusals only from the policy table, the verifier retired, the readers' route the one last-resort floor, no write ask reaching general — with the day's fourteen defects and the first night's four door failures as its fixtures. The remaining units score the door row, mint every write click through one path, move the write cell only under its gates, and retire the hand-back's render, cut note and paste machinery when no path produces them.

### Requirements

- R1. `src/load` gains a door row of eighteen fixtures — D1 to D14 exactly as record 0069 tables them, plus N1 to N4 from the first night's door failures (issues 2043, 2045, 2046) — each with the amended table's expected outcome and the unit that turns it green; the row scores every fixture whose unit is merged and prints the rest as pending; the fixtures pass public hygiene.
- R2. One module owns the operator loop: typed tool calls — `bind_preset`, `run_command`, `ask`, or an ended turn — are the model's only way to act, read tools (the thread's owner and pending question, the repository's facts, the registry's help) ground its decision, and `decideExecution(turnOutcome, surface) → run | click | route | question | refuse` is pure and total over the amended record's table, every cell covered by a table test; the route stage's answer, the operator, admission's fold and the confirm click execute its cells; no caller renders an outcome the table did not name.
- R3. On a chat surface a registry bind at or above the effective confirm class is offered as one click through record 0044's store — the one mint path whichever caller asks; a store unreachable at mint, or a line `redactSecrets` would alter, is a refusal naming why; several write binds in one decision meet the store's one-row-per-thread invariant: the first mints, the rest are refused naming the pending row. On a typed surface the refusal names the typed form. No path renders `To run this:` on a chat surface.
- R4. The verifier retires: `verifyOperatorBind` and `renderVerifierHandBack` are deleted, no second model judges the loop's decision, and the readers' route is the last-resort floor only for a turn that ends with no tool call — it runs the person's own request, reads the thread's parent as the request, carries the decision and the attempts on the resulting run's record, and never re-enters the loop; no sentence about the door's internals reaches the person.
- R5. A preset bind carries the person's words verbatim as a typed argument, so a malformed, doubled or re-spelled line is unrepresentable; a typo'd directive word binds the preset the words mean; a refusal comes only from the policy table, names the policy row it stands on, and its text is carried whole under `ROUTE_RECEIPT_CAP`, never cut at a quote or a bracket — the model authors no refusal (its "cannot" is an `ask` or an ended turn), and no write ask ever reaches the general preset.
- R6. A reply into a thread a live run or a pipeline owns is decided by the owner rule before the loop sees the message: it folds into the owner (a steer to the unit's live child, whichever thread holds it) or is refused naming the thread to reply in; it never starts a rival run. A question the loop asks parks the thread's pending question in durable state, and the person's next words in that thread — mention or not — are joined to the original request with the question and rebind it, never floored as a bare answer. A message whose line the person's own chat grammar parses runs as typed through the ladder — it never enters the loop, never re-spelled — and the directive words' read moves behind the table's owner (plan 002 U12 absorbed, U13 narrowed).
- R7. When every cell above holds on the replay, the chat hand-back retires: `HAND_BACK_PREFIX` leaves every chat render, `HAND_BACK_CUT_NOTE` is deleted, `pastedRoute` and the `outcome: pasted` machinery retire with their spec rows, and the web composer's prefill reads the click row instead of the hand-back line. The typed surfaces keep naming lines in refusals.
- R8. Every spec item a unit changes is changed in the same pull request with its proof bound (`npm run specs:check` passes), and each of records 0039, 0044, 0054 and 0057 gains its dated `## Amended` note (the replacement sentences in record 0069) in the same pull request as the unit that makes it true.

### Acceptance Examples

- AE1. **Covers R2, R3 (D13).** Given `routing.operator: on` and an operator decision binding `config set channel --models.coding <ref>`, when the bind executes on Slack, then one confirmation row is minted through record 0044's store, the button shows the full line, no `To run this:` renders, and the same command routed under `off` mints through the same path.
- AE2. **Covers R4, R5 (D6, D14; issue 2043).** Given a plain-words docs ask that names a record and a plan by number, the loop binds `agent:ship` on the person's own words — never a model-authored refusal about "administrative" access — and a turn that ends with no tool call runs the route on the person's request with the decision on the run's record.
- AE3. **Covers R5 (D1, D4, D10, D11, D12).** Given `adgent:ship in <repo>, <task>`, then the bind is `agent:ship` on the request with the typo'd token stripped, the verifier sees no duplication, and a refusal produced anywhere carries its whole sentence.
- AE4. **Covers R6 (D8, D9).** Given a live pipeline's seed thread, a reply opening with `agent:coding <steer text>` folds to the unit's live child or is refused naming the unit thread — never a new run; and `runs stop <id> --mode hard` typed in any thread runs as typed, never re-spelled into `runs_stop`.
- AE5. **Covers R7.** Given every cell green on the replay, no module under `src/core/dispatch` or `src/channels` renders `To run this:` to a chat surface, and the paste machinery is gone with its spec rows rewritten.
- AE6. **Covers R6 (issue 2046).** Given the loop asked "which repo" and parked the question, the person's reply `nominal` — mention or not — rebinds the original request joined with the question and its answer; it is never floored to general, and general never answers a write ask with "post a new message".

### Scope Boundaries

Not here: the confirm default's level (the write row's chat cell moves only under plan 002 U16's gates, as record 0069 narrows them); plan 002's U14, U15, U18 and U19; the plane's queue (record 0064); the intake gate (record 0058); any change to the seam's parsers or retry bound (record 0067). `routing.operator: off` stays the rollback lever through every unit, and under it the route stage asks the same table.

---

## Planning Contract

### Key Technical Decisions

- KTD1. **The loop first, at the top of the queue (the maintainer's decision, 2026-09-20).** E2 lands the operator loop with its D and N fixtures in the same pull request — replacing the staged byte-equivalent refactor, because the chain it would have preserved is the defect; E1's door row then scores every fixture at head, and E3, E7 and E8 flip the remaining cells one unit at a time. `routing.operator: off` stays the rollback lever throughout. Governs R1, R2.
- KTD2. **The table is data a caller executes, never a branch a caller writes.** The loop's turn outcome and `decideExecution`'s cell are closed unions; callers switch on them exhaustively, so a new tool or cell is a compile error at every caller — the property that makes the next defect a missing cell. Governs R2.
- KTD3. **One mint path.** The route stage's existing offer code (`answerCommand`'s row mint) moves into the table's module and the operator executor calls it; the store's invariants are unchanged and the serialization of multi-bind decisions is the caller-visible rule (first write clicks, later writes refused naming the pending row). Governs R3.
- KTD4. **The floor is the route stage under `off` semantics, for one cause only.** A turn that ends with no tool call runs `routeRequest` on the person's message — the router reading the thread's parent as the request — with the loop's decision and attempts attached to the resulting run's record; the operator flag is untouched and the event is marked floored so it cannot re-enter the loop. The verifier does not floor: it retires. Governs R4.
- KTD5. **The owner rule and the pending question are state, read before the loop.** Admission exposes `ownerOf(threadKey)` and the thread's pending question; a reply folds under the owner rule ahead of any directive, an answer rebinds the parked request, and `decideFollowUp` stops reading `directives.agent` as an override (plan 002 U12/U13 absorbed and narrowed as record 0069 states). Governs R6.
- KTD6. **Deletion last, and only of what nothing renders.** E8 runs a tree-wide assertion that no chat render emits `HAND_BACK_PREFIX` before deleting the constant's chat uses, the cut note and the paste machinery; the constant itself survives only where typed surfaces name lines in refusals. Governs R7.

### Sequencing

E2 (the operator loop, top of the queue — ahead of every other unit) → E1 (the door row, scored against the amended table) → E3 (the click) → E7 (the write-cell default, gated) → E8 (the retirement, which depends on E2 and E3). E4, E5 and E6 are absorbed into E2 and are not run as units. A rollback at any point is one revert; `routing.operator: off` remains live throughout.

---

## Implementation Units

| E-ID | Title | Key files | Depends on | Defects |
|---|---|---|---|---|
| E2 | The operator loop: typed tools, parked questions, policy-only refusals; the verifier retires — **top of the queue** | `src/core/dispatch/execution.ts`, `src/core/dispatch/operator.ts`, `src/core/dispatch/reply.ts`, `src/core/dispatch/admission.ts`, `src/core/threadAdmission.ts`, `src/core/dispatcher.ts`, `src/directives.ts` | none | D1–D12, D14; N1–N4 |
| E1 | The door row of eighteen fixtures | `src/load/routeDoorFixtures.ts`, `src/load/routeReplay.ts`, `scripts/load.ts` | E2 | D1–D14, N1–N4 as fixtures |
| E3 | The click on every write path | `src/core/dispatch/execution.ts`, `src/core/dispatch/operator.ts`, `src/core/confirmations.ts`, `src/core/dispatch/confirm.ts` | E2 | D13 |
| E4 | Absorbed into E2 (the verifier retires) | — | — | — |
| E5 | Absorbed into E2 (the tool schema replaces the bind repairs) | — | — | — |
| E6 | Absorbed into E2 (the owner rule, the pending question, the typed line) | — | — | — |
| E7 | The write cell's default (narrowed U16) | `src/config/profile.ts`, `src/core/dispatch/execution.ts` | E3, plan 002 U16's gates | none |
| E8 | The hand-back retires from chat | `src/core/dispatch/handBack.ts`, `src/core/dispatch/route.ts`, `src/core/dispatch/fastPath.ts`, `src/core/commandChat.ts`, `web/src` (the composer prefill) | E2, E3 | none (deletion) |

### E2. The operator loop — top of the queue

- **Goal**: the operator becomes one agent loop with typed tool calls as its only way to act — `bind_preset` (the preset and the person's request as typed arguments), `run_command` (a registry command with typed arguments), `ask` (one question, parked as the thread's pending question in durable state), or ending the turn — with read tools (the thread's owner and pending question, the repository's facts, the registry's help) grounding its decision. A question's answer is the person's next words in the thread, mention or not: joined to the original request with the question, it rebinds. Refusals come only from the policy table, naming the row they stand on; the model authors none. The verifier retires: `verifyOperatorBind` and `renderVerifierHandBack` are deleted. The readers' route is the last-resort floor only for a turn that ends with no tool call, reading the thread's parent as the request. No write ask ever reaches the general preset.
- **Requirements**: R2, R4, R5, R6, R8 (routing-and-config items 21, 25 and 29; thread-admission items 1 and 9). The amendment notes of records 0054 and 0057 land here.
- **Order**: first, ahead of every other unit — the maintainer's decision of 2026-09-20 recorded in record 0069's amendment.
- **Absorbs**: E4 (the verifier), E5 (the bind and refusal repairs), E6 (the owner rule and the typed line); their scenarios below are this unit's fixtures.
- **Fixtures from the first night's door failures, in this unit's contract**: (N1) a plain-words docs ask flipping a record's status binds `agent:ship`, never a refusal about "privileged administrative updates" (issue 2043); (N2) a docs ask naming a record and a plan by number binds the same way — a record is a markdown file a ship unit edits (issue 2043, second instance); (N3) a bare `review` reply in a thread whose parent names a pull request binds `agent:review <that url>`, and a repository the App is not installed on is refused naming the installation remedy from the policy table, never "re-send" or "credentials" (issue 2045); (N4) a free-text answer to the loop's own question rebinds the original request joined with the question and answer — never floored to general, and general never answers a write ask with "post a new message" (issue 2046).
- **Test scenarios (carried from the absorbed units)**: D5/D6/D12/D14 — no verifier sentence exists anywhere, a no-tool-call turn floors to the route with the decision on the run's record and never re-enters the loop, and the two `src/cli.ask.test.ts` process tests pass through the floor unchanged; D1–D4/D10/D11 — a preset bind carries the person's words as a typed argument (a malformed, doubled or re-spelled line is unrepresentable), a typo'd directive word binds the preset the words mean, and a refusal's text survives whole and names its policy row; D7/D8/D9 — the owner rule is read before the loop, `runs stop <id> --mode hard` runs as typed and is never re-spelled, and a directive reply in an owned thread folds or is refused naming the thread; totality — every turn outcome × surface pair returns a cell, and an unknown tool refuses to compile.
- **Verification**: `src/core/dispatch/operator.test.ts::the operator is one loop with typed tools::*` and `src/core/dispatch/execution.test.ts::the turn-outcome table is total and owns every outcome::*` green, red first; `src/core/dispatch/admission.test.ts::the owner rule and the pending question are read before the loop::*` green, red first; `npm run specs:check`; CI's `verify` green.

### E1. The door row of eighteen fixtures

- **Goal**: `npm run load -- route` prints a door row scoring D1 to D14 and N1 to N4, each fixture the failure's message shape with the amended table's expected outcome and the unit that turns it green; unmerged units' fixtures print pending, so the row is green at head.
- **Requirements**: R1, R8 (load-harness item 17).
- **Approach**: fixtures ported from issues 1993, 2010, 2025, 2043, 2045 and 2046 with names, ids and slugs neutralized; the row's scorer reads each fixture's `unit` tag against a merged-units list the replay carries.
- **Test scenarios**: a fixture whose unit is unmerged scores pending, never fails; D3's fixture types the handed-back line and expects a run once E3 lands; public hygiene passes over the fixture file.
- **Verification**: `src/load/routeReplay.test.ts::the door row scores the defect fixtures::*` green, red first; `node scripts/public-hygiene.mjs`; `npm run specs:check`; CI's `verify` green.

### E3. The click on every write path

- **Goal**: the operator's write-class registry bind mints record 0044's row through the one offer path (D13's `To run this:` beside the click ends); multi-bind decisions serialize onto one row per thread; store-unreachable and unshowable lines refuse by name on chat.
- **Requirements**: R3, R8 (routing-and-config item 25; slack-channel item 14). Record 0044's amendment note lands here; record 0039's too.
- **Test scenarios**: an operator `config set channel` bind on Slack mints one row with the full line and renders no hand-back; a second write bind in the same decision is refused naming the pending row; a store that throws at mint yields a named refusal, never a paste; the CLI's prose path names the typed form in its refusal.
- **Verification**: `src/core/dispatch/operator.test.ts::a write bind is offered as one click, never handed back::*` and `src/core/dispatch/confirm.test.ts` green, red first; the D13 fixture holds on the replay; `npm run specs:check`; CI's `verify` green.

### E4. Absorbed into E2

The verifier does not floor: it retires with the loop (the maintainer's decision, 2026-09-20). The scenarios this unit carried (D5, D6, D12, D14; the `src/cli.ask.test.ts` process tests; no verifier sentence in any reply) are E2's fixtures. Not run as a unit.

### E5. Absorbed into E2

The typed tool schema replaces the bind repairs — a malformed, doubled or re-spelled line is unrepresentable — and the refusal render (whole text, the policy row named) lands with the loop. The scenarios this unit carried (D1–D4, D10, D11) and the night fixtures N1–N3 are E2's. Not run as a unit.

### E6. Absorbed into E2

The owner rule and the pending question are state the loop reads first; the typed line never enters the loop; plan 002 U12 is absorbed and U13 narrowed as record 0069 states, the dated note added with E2. The scenarios this unit carried (D7, D8, D9, the directive replay row) and the night fixture N4 are E2's. Not run as a unit.

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
| Unit tests red then green, per unit | `npx vitest run <the unit's test files>` | E2, E1, E3, E7, E8 |
| Spec bindings resolve | `npm run specs:check` | E2, E1, E3, E7, E8 |
| Public hygiene over fixtures and docs | `node scripts/public-hygiene.mjs` | E1, E8 |
| The whole gate | `npm run verify`, run by CI on the pull request | E2, E1, E3, E7, E8 |
| Replay: the door row | `npm run load -- route --provider anthropic --model <strong tier> --verify`: every D- and N-fixture whose unit is merged holds; posted with the head sha it ran against | E2, then E1 and E3 for their fixtures |
| Replay: the directive row | the same run: the directive words bound as words | E2 |
| Live, human-gated: the click | an operator-bound `config set channel` on Slack shows one button with the full line and no hand-back text; the click runs it | E3 |
| Live, human-gated: the floor and the question | a turn ending with no tool call starts the routed run with no door sentence in the thread; a question's free-text answer rebinds the parked request | E2 |
| Live, human-gated: the owner rule | a directive reply in a live pipeline's seed thread folds or is refused naming the unit thread; a typed `runs stop` runs as typed | E2 |

A posted row is a comment on the routing-and-config receipts ledger, naming the head sha and the evidence link.

---

## Definition of Done

- E2 merged first, with its D- and N-fixtures holding in the same pull request, the verifier deleted, and the amendment notes of records 0054 and 0057 landed with it.
- E1 merged with the door row of eighteen fixtures green at head; E3 merged with the amendment notes of records 0039 and 0044.
- E7 merged only when U16's gates hold, with the receipts in its body.
- E8 merged with the hand-back gone from every chat render and the paste machinery's spec rows rewritten.
- Plan 002's dated note (U12 absorbed, U13 narrowed, U16 narrowed) added with E2.
- No abandoned attempt code remains in any unit's diff.

## Amended 2026-09-20 — the loop is the first unit

The maintainer decided for the one loop (record 0069's amendment of the same date, on the field comparison recorded there): E2 is rewritten as the operator loop with typed tool calls and moves to the top of the queue, ahead of every other unit; E4, E5 and E6 are absorbed into it, their test scenarios becoming its fixtures, joined by the first night's four door failures (issues 2043 — both false refusals — 2045 and 2046) in its contract; the verifier retires rather than floors; the readers' route is the last-resort floor only for a turn that ends with no tool call; and no write ask reaches the general preset. E1, E3, E7 and E8 stand, re-scored against the amended table.
