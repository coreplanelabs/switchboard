---
title: A user meets twelve nouns and no others - Plan
type: feat
date: 2026-09-19
status: proposed
artifact_contract: ce-unified-plan/v1
artifact_readiness: implementation-ready
product_contract_source: ce-plan-bootstrap
execution: code
extends: ../decisions/0066-a-user-meets-twelve-nouns-and-no-others-the-vocabulary-is-a-reference-page-bound-to-the-code-and-the-consistency-check-fails-a-user-surface-that-prints-an-internal-word.md
---

# A user meets twelve nouns and no others - Plan

## Goal Capsule

- **Objective**: Build [record 0066](../decisions/0066-a-user-meets-twelve-nouns-and-no-others-the-vocabulary-is-a-reference-page-bound-to-the-code-and-the-consistency-check-fails-a-user-surface-that-prints-an-internal-word.md): the twelve-noun vocabulary published as `docs/reference/vocabulary.md` with its rows bound to the code types that carry them, one explanation page with the containment diagram, the AGENTS.md and docs-landing links; two checks under `verify` (a `docs:check` binding over the vocabulary rows, a `hygiene:check` `vocabulary` class over the user surfaces with a shrinking baseline); the code cleanup the record names; and the retirement of every user string the record's survey caught.
- **Authority**: record 0066 (proposed; this plan is the artifact its acceptance is judged on) over [public-hygiene.md](../reference/specs/public-hygiene.md) for the new class, the docs-check spec rows for the binding, and the surface specs each retirement touches ([agent-ship.md](../reference/specs/agent-ship.md), [live-view.md](../reference/specs/live-view.md), [command-registry.md](../reference/specs/command-registry.md), [web-chat.md](../reference/specs/web-chat.md)); records 0031, 0034, 0035 and 0043 are decided (accepted or superseded) inside U2, under `decisions:check`'s rules.
- **Execution profile**: six units in this repository, each one pull request through the review loop, tests or checks first in every unit. U1 and U2 are docs and records only. U3 and U4 are check extensions with their own unit tests. U5 and U6 change printed strings and one type per file they touch; screenshots regenerate where a web label changes.
- **Stop conditions**: a unit that needs a new noun beyond the twelve, an allow-list over prose, or an edit to an accepted record's body hands back a deviation before changing anything.
- **Tail ownership**: each pull request merges through the review loop; the maintainer confirms the two recorded calls (the rail says Threads — decided; command and door rows hidden by default — recommended) at the record's acceptance.

---

## Product Contract

### Summary

Record 0066 fixes the user's vocabulary at twelve nouns and makes the boundary a guarantee: a reference page bound to the code, an explanation page with the containment diagram, a binding check and a hygiene class, then the cleanup and retirements that shrink the baseline to zero. The record holds the survey and the argument; this plan holds the units.

### Problem Frame

There is no glossary; "session" has six code meanings; two `RoundKind` unions disagree; three surfaces and a reference table still describe a unit's two threads after record 0055 made it one; `attempt`, `runner`, `owner-gap` and `idle` reach users undefined; "lease" is spec-only vocabulary while the product says "budget"; a how-to contradicts accepted record 0051 on stop semantics; and the records defining coordinator, session, conversation and chat are still proposed.

### Requirements

**The vocabulary and explanation pages (record 0066, "The pages"; U1)**

- R1. `docs/reference/vocabulary.md` has one row per noun — meaning, what it holds, what it belongs to, the carrying code type, the surfaces that print it — plus the requester line, the collapse table and the internal-word list.
- R2. One explanation page carries the containment diagram (a thread holds runs; a pipeline is asked in a thread and each unit gets its own thread; rounds spawn child runs into it) and links every noun to its vocabulary row.
- R3. AGENTS.md and `docs/README.md` link the vocabulary page first, before the code map.

**The four records and the spec links (U2)**

- R4. Records 0031, 0034, 0035 and 0043 each end `accepted` or `superseded` (a superseding record names its successor), passing `decisions:check`.
- R5. Every spec under `docs/reference/specs/` links the vocabulary row at a noun's first use.

**The binding check (U3)**

- R6. `docs:check` resolves every vocabulary row's code type against the tree and fails an orphaned row by the row's name, the way `specs:check` fails a dead proof.

**The vocabulary hygiene class (U4)**

- R7. `hygiene:check` gains a `vocabulary` class: an internal word (the record's list) on a user-facing surface — card and reply strings in `src/core/dispatch/` and `src/core/ship/`, the command registry's summaries, web labels under `web/src/`, and the non-spec reference, how-to and tutorial docs — is a hit; the current hits are recorded as the baseline and `hygiene:gen` refuses growth. No allow-list over prose.

**The code cleanup (U5)**

- R8. One `RoundKind` — `coding | review | findings` — with a `FLOORS` entry for `findings`; `src/core/budgets.ts` no longer carves a `fix` round.
- R9. `UnitSession` is renamed to what it is (a lease-segment progress counter, e.g. `UnitLeaseProgress`), tests and spec rows moving with it.
- R10. The "One unit of the plan…" docstring in `src/core/coordinator/contract.ts` sits above `CoordinatorUnit`, not `RoundGate`.

**The string retirements (U6)**

- R11. `runs unit`'s summary line and command summary (so the `runs_unit` MCP description too), the unit page and `docs/reference/dashboard-routes.md` describe one unit thread; the two-thread wording survives only for rows written before record 0055, named as history.
- R12. The run page's lineage link reads "pipeline" in both states; "parent run" and "pipeline run" are retired.
- R13. The Delivery page's "Unit" column is renamed to what it counts (an issue and its pull requests).
- R14. The `owner-gap` badge renders "merge-ready, unmerged".
- R15. `docs/how-to/watch-a-run.md` says a follow-up to an idle unit wakes it (record 0051); the blanket "not run" sentence is retired.
- R16. `docs/reference/dashboard-routes.md` gains the `GET /plane` row and its `/threads` rows read "thread", not "conversation".
- R17. Command and door rows are hidden from the Runs list by default, behind a toggle (the recommended call; confirmed at acceptance).

### Scope Boundaries

- The specs' and records' internal vocabulary is untouched; only user surfaces and the four named records change.
- No route, event shape or store changes; the retirements change words and one default filter, never behavior.
- Record 0065's stage words are values of the round and outcome nouns, owned by its own plan.

### Deferred to Follow-Up Work

- A thirteenth noun, if the plane's health axis forces one (an amendment to record 0066, never a silent mint).
- Narrowing the vocabulary class if ambiguous words ("ask", "fit", "door") drown it (the record's change-our-mind row).

### Open Questions

None open; one recommended call (hiding command and door rows by default) is built in U6 and confirmed or reversed at the record's acceptance.

---

## Planning Contract

### Key Technical Decisions

- **Bind rows like spec proofs.** The vocabulary page's code-type column is machine-read by the docs check and resolved against the tree, so a rename fails the build instead of orphaning the page. Rationale: the spec-proof mechanism already proves this shape works.
- **Ratchet, not allow-list.** The vocabulary class records today's violations as a baseline that only shrinks (`hygiene:gen`'s existing rule); an exception that can be granted forever is discipline, not a guarantee.
- **The user-facing set is enumerable paths, not prose judgement.** Dispatch and ship reply strings, registry summaries, `web/src/` labels, non-spec docs — a fixed path predicate keeps the class deterministic.
- **Retire strings after the checks land.** U5 and U6 shrink the baseline the U4 check recorded, so every retirement is visible as a ratchet decrease.

### High-Level Technical Design

`docs/reference/vocabulary.md` (new) and one page under `docs/explanation/` (new, the containment diagram); links in `AGENTS.md` and `docs/README.md`. `scripts/` gains the vocabulary binding in the docs-check path and the `vocabulary` class in `scripts/public-hygiene.mjs` with its baseline in `scripts/public-hygiene.allowlist.json`. Code: `src/core/budgets.ts` and `src/core/ship/coordinator.ts` (one `RoundKind`, a `findings` floor), the `UnitSession` rename across `src/core/ship/` and its tests, `src/core/coordinator/contract.ts` (the docstring). Strings: `src/core/commands/runs.ts`, `web/src/pages/UnitPage.vue`, `web/src/pages/RunPage.vue`, `web/src/pages/DeliveryPage.vue`, `web/src/pages/PlanePage.vue`, `web/src/pages/RunsIndexPage.vue` (the default filter), `docs/reference/dashboard-routes.md`, `docs/how-to/watch-a-run.md`.

### Assumptions

- The docs-check path (`npm run docs:check`, part of `check:consistency`) can gain a resolver without a new script name; otherwise a described script is added and `agents:check` updated in the same unit.
- Rows written before record 0055 still carry a review thread and keep a history-named rendering (R11); nothing rewrites old records.
- Hiding command and door rows is a client-side default over fields the summaries already carry.

## Implementation Units

| U-ID | Title | Key files | Depends on |
| --- | --- | --- | --- |
| U1 | The vocabulary and explanation pages, linked first | `docs/reference/vocabulary.md`, `docs/explanation/` (new page), `AGENTS.md`, `docs/README.md` | — |
| U2 | The four records decided; specs link the vocabulary rows | `docs/decisions/0031-*.md`, `0034-*.md`, `0035-*.md`, `0043-*.md`, `docs/reference/specs/*.md` | U1 |
| U3 | docs:check binds every vocabulary row's code type | the docs-check script path, `docs/reference/vocabulary.md` | U1 |
| U4 | hygiene:check gains the vocabulary class and its baseline | `scripts/public-hygiene.mjs`, `scripts/public-hygiene.allowlist.json`, `docs/reference/specs/public-hygiene.md` | U1 |
| U5 | The code cleanup: one RoundKind, the rename, the docstring | `src/core/budgets.ts`, `src/core/ship/coordinator.ts`, `src/core/coordinator/contract.ts`, their tests and spec rows | — |
| U6 | The string retirements and the hidden bookkeeping rows | `src/core/commands/runs.ts`, `web/src/pages/*.vue`, `docs/reference/dashboard-routes.md`, `docs/how-to/watch-a-run.md`, screenshots | U4, U5 |

### U1. The vocabulary and explanation pages, linked first

- **Scope**: R1 to R3. The twelve rows with their carrying types (`thread` → the thread key on `RunSummary`; `run` → `RunRecord`; `unit` → `CoordinatorUnit`; `round` → `RoundKind`; …), the collapse table, the internal-word list, the two maintainer calls; the explanation page's diagram; the two links.
- **Blast radius**: docs only.
- **Validation**: `npm run docs:check`, `npm run check:site`, `npm run hygiene:check`.

### U2. The four records decided; specs link the vocabulary rows

- **Scope**: R4, R5. Each of 0031, 0034, 0035 and 0043 is accepted as-is or superseded by a record that restates what still holds in the twelve-noun frame; every spec's first use of a noun links its row.
- **Blast radius**: docs and records only; `decisions:check` guards the record moves.
- **Validation**: `npm run decisions:check`, `npm run docs:check`, `npm run specs:check`.

### U3. docs:check binds every vocabulary row's code type

- **Scope**: R6. Tests first: the check's unit test feeds a page with a live type, a dead type and a renamed type and asserts the failure names the row. Then the resolver, wired into `check:consistency`.
- **Blast radius**: the docs-check leg; a future rename of a carrying type fails CI until the row moves with it.
- **Validation**: the check's unit test; `npm run docs:check` green on the real page; a deliberate dead row fails by name (shown in the unit's PR validation).

### U4. hygiene:check gains the vocabulary class and its baseline

- **Scope**: R7. Tests first: the scanner's unit test pins the path predicate (a dispatch reply string hits, a spec line does not) and the word list. Then the class, `hygiene:gen` recording the baseline, and the public-hygiene spec row.
- **Blast radius**: `check:consistency`; every later PR that prints an internal word on a user surface fails.
- **Validation**: the scanner's unit test; `npm run hygiene:check` green with the recorded baseline; `npm run hygiene:gen` refuses growth.

### U5. The code cleanup: one RoundKind, the rename, the docstring

- **Scope**: R8 to R10. Tests first where behavior is pinned (`FLOORS` gains `findings`; the carve tests move off `fix`); the `UnitSession` rename is structural and rides its own commit; the docstring moves.
- **Blast radius**: the budgets and ship modules; no printed string changes.
- **Validation**: `npx vitest run` on the touched test files; the budgets spec rows re-resolve under `specs:check`.

### U6. The string retirements and the hidden bookkeeping rows

- **Scope**: R11 to R17. Tests first: `runs.test.ts` for the one-thread summary, the web page tests for the renamed labels and the default filter. Then the strings, the two docs pages, `npm run screenshots:gen` where labels changed. Each retirement shrinks U4's baseline.
- **Blast radius**: printed words on the card, the commands, four web pages and two docs pages; one default filter on the Runs list.
- **Validation**: the tests; the hygiene baseline strictly smaller; before and after screenshots on the pull request (human-gated).

## Verification Contract

The record's criteria, each bound to a test id or check name; every row `[gap]` until its unit merges.

| Criterion | Proof |
| --- | --- |
| The vocabulary page exists with one bound row per noun and is linked first from AGENTS.md and the landing page | `npm run docs:check`; `npm run check:site` [gap: unit one] |
| Records 0031, 0034, 0035 and 0043 are accepted or superseded, successors named | `npm run decisions:check` [gap: unit two] |
| Every spec links a noun's vocabulary row at first use | `npm run specs:check`; the docs-check link pass [gap: unit two] |
| A vocabulary row whose code type is gone fails by the row's name | the binding check's unit test (`scripts/…vocabulary…test`::an orphaned row fails by name) [gap: unit three] |
| An internal word newly printed on a user surface fails; the baseline only shrinks | the scanner's unit test (`scripts/public-hygiene…`::the vocabulary class hits a reply string and not a spec); `npm run hygiene:gen` growth refusal [gap: unit four] |
| One `RoundKind` with a `findings` floor; no `fix` carve | `src/core/budgets.test.ts`::`the findings round has a floor…` [gap: unit five] |
| `UnitSession` is renamed and its tests and spec rows moved | `npm run specs:check` over the moved rows [gap: unit five] |
| The one-thread wording on `runs unit`, the unit page, the MCP description and dashboard-routes | `src/core/commands/runs.test.ts`::`a unit names one thread…`; `npm run docs:check` [gap: unit six] |
| The lineage link, the Delivery column, the owner-gap badge and the stop-semantics how-to read the nouns | the web page tests; the hygiene baseline decrease [gap: unit six] |
| Command and door rows hidden by default behind a toggle | `web/src/pages/runsIndex.test.ts`::`bookkeeping rows hide by default…` [gap: unit six] |

- Every unit: the fast gates at the changed-set scope (`npx vitest run` on touched test files, the touched tsconfig's `tsc --noEmit`, `npx prettier --check` on changed files, `npm run hygiene:check`, `npm run specs:check`), plus `npm run check:pr-title`.

## Definition of Done

- The six pull requests are merged; the vocabulary page is linked first and every row binds; the two checks run under `verify`; the vocabulary baseline is at or near zero and only shrinks; the four records are decided; and record 0066 is `accepted` with the maintainer's two calls confirmed.
