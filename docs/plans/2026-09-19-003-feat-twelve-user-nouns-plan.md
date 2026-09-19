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

- **Objective**: Build [record 0066](../decisions/0066-a-user-meets-twelve-nouns-and-no-others-the-vocabulary-is-a-reference-page-bound-to-the-code-and-the-consistency-check-fails-a-user-surface-that-prints-an-internal-word.md): the twelve-noun vocabulary published as `docs/reference/vocabulary.md` whose table is a generated region rendered from a typed list under `src/docs/` that imports the carrying types; one explanation page with the containment diagram; the AGENTS.md and docs-landing links; `vocabulary:check` — a sibling of `hygiene:check` sharing public-hygiene's baseline and ratchet helpers — over extracted string literals, web template text nodes and the non-spec docs trees; the code cleanup the record names (the fix→findings rename with the `merge` kind kept, the `UnitSession` rename, the docstring move); and the retirement of the user strings the record's survey caught, split into bot strings, docs pages and web labels.
- **Authority**: record 0066 (proposed; this plan is the artifact its acceptance is judged on) over [public-hygiene.md](../reference/specs/public-hygiene.md) item 1 for the sibling class, the docs-check spec rows for the generated region, and the surface specs each retirement touches — [agent-ship.md](../reference/specs/agent-ship.md) items 8, 12 and 17, [live-view.md](../reference/specs/live-view.md) item 28, [command-registry.md](../reference/specs/command-registry.md), [orchestration-plane.md](../reference/specs/orchestration-plane.md); records 0031, 0034, 0035 and 0043 are decided inside U2 under `decisions:check`'s rules, with the per-record statuses the record's difficulty map fixes.
- **Execution profile**: nine units in this repository, each one pull request through the review loop, tests or checks first in every unit. U1 to U3 are docs and records only. U4 and U5 are check extensions with their own unit tests. U6 is a rename plus a docstring move, no printed string changed. U7 and U8 retire printed strings in the bot and the docs. U9 is the only unit touching `web/`, runs last, and is gated on the maintainer's check-in and the open question.
- **Stop conditions**: a unit that needs a new noun beyond the twelve, a permanent per-line exception for a printed string, or an edit to an accepted record's body hands back a deviation before changing anything.
- **Tail ownership**: each pull request merges through the review loop; the maintainer confirms the two recorded calls (the rail says Threads — decided; command and door rows hidden by default — open) at the record's acceptance, and checks in before U9 is seeded.

---

## Product Contract

### Summary

Record 0066 fixes the user's vocabulary at twelve nouns and makes the boundary a guarantee: a reference page whose table is generated from a typed list importing the carrying types, an explanation page with the containment diagram, a `vocabulary:check` over what the surfaces actually print, then the cleanup and the retirements that drive the recorded baseline to zero — the record's acceptance gate. The record holds the survey and the argument; this plan holds the units.

### Problem Frame

There is no glossary; "session" names eleven code types plus the sandbox's and the OpenCode client's vendor sessions; the two `RoundKind` unions spell the same pass `fix` and `findings` with a translation between them; four unconditional strings still describe a unit's two threads after record 0055 made it one; `attempt`, `runner`, `owner-gap` and `idle` reach users undefined; "lease" is spec-only vocabulary while the product says "budget"; and the records defining coordinator, session, conversation and chat are still proposed.

### Requirements

**The vocabulary and explanation pages (record 0066, "The pages"; U1)**

- R1. `docs/reference/vocabulary.md` has one row per noun in the record's schema — meaning, what it holds, what it belongs to, the carrying code type, the surfaces that print it — plus the requester line, the nouns-versus-values rule, the collapse table and the fourteen-word internal list.
- R2. One explanation page carries the containment diagram (a thread holds runs; a pipeline is asked in a thread and each unit gets its own thread; rounds spawn child runs into it) and links every noun to its vocabulary row.
- R3. AGENTS.md and `docs/README.md` link the vocabulary page first, before the code map (human-gated: no check asserts link order), and the page joins `REQUIRED_PAGES` in `scripts/check-site.mjs`.

**The four records (U2)**

- R4. Records 0031, 0034, 0035 and 0043 each end in the status the record's difficulty map fixes — 0031, 0035 and 0043 accepted; 0034 superseded with `superseded_by` naming its successor — passing `decisions:check`.

**The spec links (U3)**

- R5. Every spec the vocabulary page's surfaces column cites links the vocabulary row at a noun's first use; the remaining specs are batched behind it.

**The generated vocabulary region (U4)**

- R6. The vocabulary table is a generated region rendered from a typed list under `src/docs/` that imports each row's carrying type; a renamed or deleted type fails the typecheck, and a stale or hand-edited region fails `docs:check` naming the row.

**vocabulary:check (U5)**

- R7. `vocabulary:check`, a sibling script under `check:consistency` sharing `scripts/public-hygiene.mjs`'s baseline and ratchet helpers, fails one of the record's fourteen internal words found in: string and template literals extracted (TypeScript AST) from `src/core/dispatch/`, `src/core/ship/` and the command registry's summaries and tool descriptions; text nodes of the web templates under `web/src/`; lines of the non-spec docs trees. `docs/reference/vocabulary.md` and `docs/reference/specs/public-hygiene.md` are exempt by path. The baseline is recorded with the gen script's `--force` and only shrinks.

**The code cleanup (U6)**

- R8. One `RoundKind` spelling — `coding | review | findings | merge` — in `src/core/budgets.ts` and `src/core/ship/coordinator.ts`: `fix` renamed to `findings` in `FLOORS` and the ask arithmetic, the coordinator's findings→fix translation removed, the `merge` kind and its floor, ask and reserve untouched (agent-ship.md items 8 and 12).
- R9. `UnitSession` is renamed to what it is (a lease-segment progress counter), tests and spec rows moving with it, `src/core/coordinator/driver.ts` included.
- R10. The "One unit of the plan…" docstring in `src/core/coordinator/contract.ts` sits above `CoordinatorUnit`, not `RoundGate`.

**The bot-string retirements (U7)**

- R11. `runs unit`'s command summary (and so the `runs_unit` MCP description) and the unit-key argument text describe one unit thread and an ordinal, not "coding thread …, review thread …" or `attempt` (agent-ship.md item 17); the pre-0055 legacy rendering stays, named as history.
- R12. The plane table's chat, CLI and MCP output renders `owner-gap` as "merge-ready, unmerged" and `idle` in the outcome's words, never the raw flag join.
- R13. The delivery report's "Units:" label and the 0046 card sentences (segment, renewal, grant) read in the budget noun's words; 0060's hosted stop refusal reads in the pipeline noun's words — the replacement sentences the record's "Records this design amends" section fixes.

**The docs retirements (U8)**

- R14. `docs/reference/dashboard-routes.md` describes one unit thread (lines 17 and 63 today), gains the `GET /plane` page row, and its `/threads` rows say "thread", not "conversation"; the remaining non-spec docs lines carrying one of the fourteen words are rewritten.

**The web-label retirements and the hidden bookkeeping rows (U9)**

- R15. The unit page's "Runs by round" count line describes one unit thread; `attempt {{ … }}` reads as an ordinal; "the runner has not started this unit" names the pipeline (live-view.md item 28).
- R16. The run page's lineage link reads "pipeline" on the unit lineage; a conductor child's link keeps "parent run".
- R17. The Delivery page's "Unit" column is renamed to "Issue"; the home page's turn labels read as runs.
- R18. Command and door rows are hidden from the Runs list by default behind a toggle — built only once the open question is confirmed.

### Scope Boundaries

- The specs' and records' internal vocabulary is untouched; only user surfaces, the four named records and the record-0066 replacement sentences change.
- No route, event shape or store changes; the retirements change words and one default filter, never behavior. The fix→findings rename is one spelling for one pass — floors, asks and the ledger's arithmetic keep their values.
- `docs/how-to/watch-a-run.md` is not edited here: its stop sentence describes the dispatcher at head; record 0051's idle wake rewrites it in 0051's own plan.
- Record 0065's stage words are values of the round and outcome nouns, owned by its own plan.

### Deferred to Follow-Up Work

- A thirteenth noun, if the plane's health axis forces one (an amendment to record 0066, never a silent mint).
- A second word set for the distinctive synonyms (`segment N`, `owner-gap`, `coding thread` / `review thread`, `parent run`) joining `vocabulary:check` if they extract cleanly — the class ships enforcing the internal-word ban, not the collapse.
- Further narrowing of the fourteen if extraction still drowns (the record's change-our-mind row).

### Open Questions

- **Command and door rows hidden by default** — recommended by the record, to be confirmed by the maintainer before U9 is seeded; U9 builds the default and the toggle only on confirmation.

---

## Planning Contract

### Key Technical Decisions

- **A generated region, not a resolver.** `docs:check` is generate-and-diff over typed regions (`scripts/docs-gen.ts`, `src/docs/`); the vocabulary table is rendered from a typed list whose imports are the binding — a rename fails `tsc`, a stale region fails the diff. Rationale: no new check mechanism; the reference tables already work this way.
- **Extraction, not per-line regex.** A regex over `src/` hits identifiers, imports and comments (`session` 343 times in dispatch and ship); the class reads string literals (TypeScript AST), web template text nodes and docs lines — what is printed, never what the code says to itself.
- **A sibling script sharing the ratchet.** `vocabulary:check` reuses `scripts/public-hygiene.mjs`'s baseline, allow and ratchet helpers rather than adding a class to the per-line scanner, because its unit of scan (an extracted literal) differs from hygiene's (a line).
- **Ratchet, and a zero gate.** The baseline is recorded once with `--force`, only shrinks, is re-recorded in the same pull request as every retirement, and must reach zero on the enumerated surfaces before record 0066 is accepted.
- **Rename before retire.** U6 makes the code's words true (`findings`, the renamed counter) before U7 to U9 change what is printed, so no retirement prints a word the code is about to rename.

### High-Level Technical Design

`docs/reference/vocabulary.md` (new; its table a generated region) and one page under `docs/explanation/` (new, the containment diagram); links in `AGENTS.md` and `docs/README.md`; `REQUIRED_PAGES` in `scripts/check-site.mjs`. `src/docs/vocabulary.ts` (new: the typed row list, importing the carrying types) wired into `scripts/docs-gen.ts`. `scripts/vocabulary-check.mjs` (new sibling) plus its gen mode, sharing `scripts/public-hygiene.mjs` helpers; `package.json` scripts and the regenerated AGENTS.md commands table. Code: `src/core/budgets.ts`, `src/core/ship/coordinator.ts`, `src/core/coordinator/driver.ts`, `src/core/coordinator/contract.ts`. Strings: `src/core/commands/runs.ts`, `src/core/commands/plane.ts`, `src/core/delivery.ts`, the ship/dispatch card sentences; `docs/reference/dashboard-routes.md`; `web/src/pages/UnitPage.vue`, `RunPage.vue`, `DeliveryPage.vue`, `HomePage` turns, `RunsIndexPage.vue` (the default filter).

### Assumptions

- Adding the `vocabulary:check` and its gen script to `package.json` and describing them in AGENTS.md satisfies `agents:check` (`npm run fix` regenerates the table).
- The pre-0055 legacy renderings (`src/core/commands/runs.ts` line 376, `web/src/pages/UnitPage.vue` lines 201 to 218) are pinned by 0055's tests and stay; only the unconditional strings retire.
- Hiding command and door rows is a client-side default over fields the summaries already carry.

## Implementation Units

| U-ID | Title | Key files | Depends on |
| --- | --- | --- | --- |
| U1 | The vocabulary and explanation pages, linked first | `docs/reference/vocabulary.md`, `docs/explanation/` (new page), `AGENTS.md`, `docs/README.md`, `scripts/check-site.mjs` | — |
| U2 | The four records decided | `docs/decisions/0031-*.md`, `0034-*.md` (+ successor), `0035-*.md`, `0043-*.md` | U1 |
| U3 | Specs link the vocabulary rows at first use | `docs/reference/specs/*.md` (the cited set first) | U1 |
| U4 | The vocabulary table becomes a generated, type-importing region | `src/docs/vocabulary.ts` (new), `scripts/docs-gen.ts`, `docs/reference/vocabulary.md` | U1 |
| U5 | vocabulary:check and its baseline | `scripts/vocabulary-check.mjs` (new), `scripts/public-hygiene.mjs` (exported helpers), `package.json`, `AGENTS.md`, `docs/reference/specs/public-hygiene.md` | U1 |
| U6 | The code cleanup: one RoundKind spelling, the rename, the docstring | `src/core/budgets.ts`, `src/core/ship/coordinator.ts`, `src/core/coordinator/driver.ts`, `src/core/coordinator/contract.ts`, their tests and spec rows | — |
| U7 | The bot-string retirements | `src/core/commands/runs.ts`, `src/core/commands/plane.ts`, `src/core/delivery.ts`, the ship/dispatch card sentences, the vocabulary baseline | U5, U6 |
| U8 | The docs retirements | `docs/reference/dashboard-routes.md`, the non-spec docs trees, the vocabulary baseline | U5 |
| U9 | The web-label retirements and the hidden bookkeeping rows | `web/src/pages/UnitPage.vue`, `RunPage.vue`, `DeliveryPage.vue`, `RunsIndexPage.vue`, home turns, screenshots, the vocabulary baseline | U5, U7, U8; the maintainer's check-in and the open question |

### U1. The vocabulary and explanation pages, linked first

- **Goal**: A reader finds one page defining the twelve nouns in the record's five-column schema and one explanation page with the containment diagram, linked before the code map.
- **Requirements**: R1, R2, R3 (record 0066, "The pages", "Nouns versus values", "The internal words").
- **Dependencies**: none.
- **Files**: `docs/reference/vocabulary.md` (new), `docs/explanation/` (new page), `AGENTS.md`, `docs/README.md`, `scripts/check-site.mjs` (`REQUIRED_PAGES`), `docs/.vitepress` nav if the sidebar lists reference pages.
- **Approach**: Write the page from the record's tables — the twelve rows, the requester line, the nouns-versus-values rule, the collapse, the fourteen internal words, the by-rule definitions; the table is hand-authored here and becomes the generated region in U4. Add the two links and the `REQUIRED_PAGES` entry.
- **Patterns to follow**: the record's row schema stated once; neighbouring reference pages' front matter and tone.
- **Test scenarios**:
  - `scripts/check-site.mjs` lists the vocabulary page and `npm run check:site` fails when the built site lacks it.
- **Verification**: `npm run docs:check`; `npm run check:site` (after `npm run build -w docs`); `npm run hygiene:check`; the link order is human-gated — named in the pull request, no check asserts it.

### U2. The four records decided

- **Goal**: Records 0031, 0035 and 0043 are accepted; 0034 is superseded by a successor restating the reading unit in the twelve-noun frame, so the vocabulary page binds to settled ground.
- **Requirements**: R4 (record 0066, difficulty map row four, with the per-record statuses).
- **Dependencies**: U1.
- **Files**: `docs/decisions/0031-the-coordinator-runs-a-plan-not-a-pull-request.md`, `0034-one-agent-per-unit-a-run-continues-a-transcript.md` plus its successor record (new), `0035-a-session-log-outlives-its-runs-compaction-is-a-pointer.md`, `0043-the-home-page-is-a-chat-the-browser-is-a-channel-and-a-turn-is-a-run.md`, `docs/explanation/design-decisions.md` (regenerated).
- **Approach**: Acceptance freezes a body byte for byte (`src/docs/records.ts`), so read each body first: 0031, 0035 and 0043 flip `status` to accepted as-is; 0034 gains `superseded_by` naming the new record, which restates what still holds (one agent per unit; a run continues a transcript) without the review-thread rationale 0055 undid or the session trade 0057 replaced. Regenerate the index with `npm run docs:gen`.
- **Patterns to follow**: how earlier superseded records name their successor; `decisions:check`'s status rules.
- **Test scenarios**:
  - `npm run decisions:check` passes with the four statuses and the successor named — and fails if `superseded_by` is dropped (shown red first by flipping 0034 without a successor).
- **Verification**: `npm run decisions:check`; `npm run docs:check`; `npm run hygiene:check`.

### U3. Specs link the vocabulary rows at first use

- **Goal**: A spec reader lands on the vocabulary row the first time a spec uses one of the twelve nouns, starting with the specs the vocabulary page's surfaces column cites.
- **Requirements**: R5 (record 0066, "The pages", third bullet).
- **Dependencies**: U1.
- **Files**: the specs the vocabulary page cites — [agent-ship.md](../reference/specs/agent-ship.md), [live-view.md](../reference/specs/live-view.md), [command-registry.md](../reference/specs/command-registry.md), [web-chat.md](../reference/specs/web-chat.md), [orchestration-plane.md](../reference/specs/orchestration-plane.md), [public-hygiene.md](../reference/specs/public-hygiene.md) — then the remainder in one batch commit.
- **Approach**: One link per noun per spec, at first use, anchor-linked to the page's row; no wording changes, so no proof reference moves. Batch the remaining specs mechanically and read the diff.
- **Patterns to follow**: how specs link records today (`[record 0055](../../decisions/…)`).
- **Test scenarios**:
  - `npm run specs:check` passes — the links change no `file::describe::it` proof and no header path.
- **Verification**: `npm run specs:check`; `npm run docs:check`; `npx prettier --check` on the changed files.

### U4. The vocabulary table becomes a generated, type-importing region

- **Goal**: A rename of a carrying type fails the typecheck, and a stale or hand-edited vocabulary table fails `docs:check` naming the row.
- **Requirements**: R6 (record 0066, "Two checks", first bullet).
- **Dependencies**: U1.
- **Files**: `src/docs/vocabulary.ts` (new: the typed row list, `import type { CoordinatorUnit } from "../core/coordinator/contract.js"` and siblings), `src/docs/vocabulary.test.ts` (new), `scripts/docs-gen.ts`, `docs/reference/vocabulary.md` (the table wrapped in the region markers), the docs-check spec rows.
- **Approach**: Tests first: the renderer's test feeds the typed list and asserts the rendered rows and the region name; the regions test already proves a drifted region fails with the file and region named. Then the list — one entry per noun carrying the noun, meaning, holds, belongs-to, the type's name as a `import type`-checked reference and the printing surfaces — and the `docs:gen` wiring. Regenerate with `npm run fix`.
- **Patterns to follow**: `src/docs/reference.ts` and `src/docs/regions.ts` — how the existing generated tables render and diff; AGENTS.md's rule that generated regions are never hand-edited.
- **Test scenarios**:
  - `src/docs/vocabulary.test.ts::renders one row per noun in schema order`.
  - `src/docs/vocabulary.test.ts::a row names the carrying type it imports` (the list's entry is the type, not a string that can drift).
  - `src/docs/regions.test.ts::declaredRegions` continues to cover the new region; a hand-edited table shown failing `npm run docs:check` in the pull request's validation.
- **Verification**: `npx vitest run src/docs/vocabulary.test.ts src/docs/regions.test.ts`; `npm run docs:check`; the touched tsconfig's `tsc --noEmit`.

### U5. vocabulary:check and its baseline

- **Goal**: One of the fourteen internal words printed on a user surface fails `check:consistency` by file and word, with today's violations recorded as a baseline that only shrinks.
- **Requirements**: R7 (record 0066, "Two checks", second and third bullets; [public-hygiene.md](../reference/specs/public-hygiene.md) item 1 for the sibling's ratchet shape).
- **Dependencies**: U1.
- **Files**: `scripts/vocabulary-check.mjs` (new; the extractor and the check), `src/vocabularyCheck.test.ts` (new), `scripts/public-hygiene.mjs` (helpers exported, no behavior change), `package.json` (`vocabulary:check`, `vocabulary:gen`, wired into `check:consistency` and `fix`), `AGENTS.md` (regenerated commands table), `docs/reference/specs/public-hygiene.md` (the sibling's rows).
- **Approach**: Tests first, mirroring `src/publicHygiene.test.ts`: the extractor over a TypeScript fixture yields string and template literals only (an identifier `session` is unseen); a web template fixture yields text nodes only; the docs scan skips `docs/reference/specs/` except that the non-spec trees are in scope; `docs/reference/vocabulary.md` and the public-hygiene spec are exempt by path; the fourteen-word list with the scoped senses (`hosted` only before run/parent/pipeline, `runner` only after plan). Then the script, sharing the baseline/ratchet/allow helpers. Record the initial baseline with `npm run vocabulary:gen -- --force` (a brand-new class's baseline is refused without it) and commit it; every later shrink re-runs the gen and commits the baseline in the same pull request — written here so U7 to U9 inherit the mechanic.
- **Patterns to follow**: `scripts/public-hygiene.mjs`'s `classesFor`/`scanText`/ratchet split and its test file's structure; the Commands-table rule (`agents:check` refuses an undescribed script).
- **Test scenarios**:
  - `src/vocabularyCheck.test.ts::extracts string literals, never identifiers or comments`.
  - `src/vocabularyCheck.test.ts::a web template text node hits; an attribute binding does not`.
  - `src/vocabularyCheck.test.ts::the vocabulary page and the hygiene spec are exempt by path`.
  - `src/vocabularyCheck.test.ts::the scoped senses — hosted run hits, GitHub-hosted runner does not`.
  - `src/vocabularyCheck.test.ts::growth is refused; shrink demands a re-recorded baseline` (the shared ratchet).
- **Verification**: `npx vitest run src/vocabularyCheck.test.ts src/publicHygiene.test.ts`; `npm run vocabulary:check` green on the recorded baseline; `npm run agents:check`; `npm run hygiene:check`.

### U6. The code cleanup: one RoundKind spelling, the rename, the docstring

- **Goal**: The code carries the words the product will print: the fix/findings pass has one spelling with the `merge` kind and every floor intact, the lease-segment counter's name says what it is, and the unit docstring sits on the unit type.
- **Requirements**: R8, R9, R10 (record 0066, "The code cleanup"; [agent-ship.md](../reference/specs/agent-ship.md) items 8 and 12 keep their meaning through the rename).
- **Dependencies**: none.
- **Files**: `src/core/budgets.ts` (`RoundKind`, `FLOORS`, the ask arithmetic), `src/core/budgets.check.test.ts`, `src/core/ship/coordinator.ts` (the union, the line-1018 translation removed, `UnitSession` renamed), `src/core/ship/coordinator.test.ts`, `src/core/coordinator/driver.ts` and `driver.test.ts` (the import and threading of the renamed type), `src/core/coordinator/contract.ts` (the docstring), the budgets and agent-ship spec rows.
- **Approach**: Structural first, behavioral never: one commit renames `fix` → `findings` across `RoundKind`, `FLOORS`, the ask switch and the coordinator/driver call sites and deletes the translation; a second commit renames `UnitSession` (tests and spec rows moving with it, same commit) and moves the docstring. `MERGE_WAIT_ASK_MINUTES`, the merge floor and record 0046's fit are untouched — the diff must show values unchanged.
- **Patterns to follow**: AGENTS.md "Tidy first" (structural and behavioral separate); "Tests move with code".
- **Test scenarios**:
  - `src/core/budgets.check.test.ts::the budgets module — one table every wall clock derives from…` still passes with `findings` where `fix` was, values identical.
  - `src/core/budgets.check.test.ts::the fit — a pipeline holds its first child at its ask and every later round at its floor…` unchanged in outcome.
  - `src/core/ship/coordinator.test.ts` rounds: a findings step's ledger row records `findings`, no translation.
- **Verification**: `npx vitest run src/core/budgets.check.test.ts src/core/ship/coordinator.test.ts src/core/coordinator/driver.test.ts`; `npm run specs:check` over the moved rows; the touched tsconfig's `tsc --noEmit`.

### U7. The bot-string retirements

- **Goal**: The bot's printed strings — command summaries, MCP descriptions, the plane table, the delivery report, the card sentences, the hosted stop refusal — speak the twelve nouns; the vocabulary baseline shrinks and is re-recorded.
- **Requirements**: R11, R12, R13 (record 0066, "The collapse" and "Records this design amends"; [agent-ship.md](../reference/specs/agent-ship.md) item 17; [command-registry.md](../reference/specs/command-registry.md); [orchestration-plane.md](../reference/specs/orchestration-plane.md)).
- **Dependencies**: U5 (the baseline exists so the shrink is visible), U6 (the code's words are already true).
- **Files**: `src/core/commands/runs.ts` (the summary at line 393 today, the unit-key argument text, `HOSTED_STOP_REFUSAL` and the `runs_stop` description) and `src/core/commands/runs.test.ts`; `src/core/commands/plane.ts` (the health rendering) and `plane.test.ts`; `src/core/delivery.ts` (the "Units:" label, `UnitRow` naming) and its test; the ship/dispatch card sentences (segment/renewal/grant → the record's replacement sentences, ending → outcome, owner/actor → requester in printed strings); the touched spec rows; the vocabulary baseline.
- **Approach**: Tests first per surface: pin the new sentence, run red, change the string. Use the record's replacement sentences verbatim for the 0046/0051/0060 strings. The pre-0055 legacy rendering (line 376 today) stays, its comment naming it history. Then `npm run vocabulary:gen` to re-record the shrunken baseline in the same pull request (the ratchet fails on unrecorded shrink), and move the spec rows in the same commits as their strings.
- **Patterns to follow**: the record's "Records this design amends" replacement sentences; `specs:check`'s rule that the row moves with the string.
- **Test scenarios**:
  - `src/core/commands/runs.test.ts`: the `runs unit` summary names one thread; the unit-key description phrases the ordinal without `attempt`.
  - `src/core/commands/runs.test.ts`: the hosted stop refusal reads the pipeline sentence (`--mode hard` escape wording intact).
  - `src/core/commands/plane.test.ts`: a unit whose health is `owner-gap` prints "merge-ready, unmerged" on chat, CLI and MCP output.
  - `src/core/delivery.test.ts` (bot): the report's label counts issues, not units.
- **Verification**: `npx vitest run` on the four touched test files; `npm run vocabulary:check` green with the smaller baseline; `npm run specs:check`; `npx prettier --check` on the changed files.

### U8. The docs retirements

- **Goal**: The non-spec docs trees speak the twelve nouns: dashboard-routes describes one unit thread, documents `GET /plane`, and says thread where it said conversation; the remaining fourteen-word hits in reference, how-to, tutorials and explanation are rewritten.
- **Requirements**: R14 (record 0066, "Today" rows for the two-thread table, the undocumented plane page and the lease gap).
- **Dependencies**: U5.
- **Files**: `docs/reference/dashboard-routes.md` (rows 17 and 63 today; the new `/plane` row beside `/api/plane.show`; the `/threads` rows), the non-spec docs pages the baseline names, the vocabulary baseline.
- **Approach**: The dashboard-routes rows sit outside any generated region, so `docs:check` proves nothing there — bind the rewrites to the vocabulary baseline shrink and name them in the pull request for the human reader. Rewrite each baseline-listed docs line in the noun's words; `npm run vocabulary:gen` re-records the shrink in the same pull request. `docs/how-to/watch-a-run.md`'s stop sentence is out of scope (it is true at head; 0051's plan owns its future).
- **Patterns to follow**: the vocabulary page's own phrasings, so the docs and the page never diverge.
- **Test scenarios**:
  - `npm run vocabulary:check` red before the rewrite on the seeded fixture of the baseline, green after with the smaller baseline (the shared ratchet test in `src/vocabularyCheck.test.ts` pins the mechanism; the shrink itself is the pull request's receipt).
- **Verification**: `npm run docs:check`; `npm run vocabulary:check` with the smaller baseline; `npm run check:site`; `npx prettier --check` on the changed files.

### U9. The web-label retirements and the hidden bookkeeping rows

- **Goal**: The web labels speak the twelve nouns — one unit thread on the unit page, "pipeline" on the unit lineage, "Issue" on Delivery, runs on the home page — and command and door rows hide by default behind a toggle.
- **Requirements**: R15, R16, R17, R18 (record 0066, "The collapse" and maintainer call two; [live-view.md](../reference/specs/live-view.md) item 28).
- **Dependencies**: U5, U7, U8; **gated** on the maintainer's check-in for frontend work and on the open question (the command/door default) being confirmed — seeded last, and not before both.
- **Files**: `web/src/pages/UnitPage.vue` (the count line at 272 today, `attempt` at 233, the runner sentence at 287) and `web/src/pages/unitPage.test.ts`; `web/src/pages/RunPage.vue` (the lineage label at 588) and `runPage.test.ts`; `web/src/pages/DeliveryPage.vue` (the column at 160) and `delivery.test.ts`; the home turn labels and `home.test.ts`; `web/src/pages/RunsIndexPage.vue` (the default filter and toggle) and `runsIndex.test.ts`; `web/src/pages/plane.test.ts` if the badge gloss moves; regenerated screenshots; the vocabulary baseline.
- **Approach**: Tests first per page, red then green; the pre-0055 legacy branches (`UnitPage.vue` lines 201 to 218 today) stay pinned. The conductor branch keeps "parent run" — the test distinguishes the two lineages. The filter is a client-side default over fields the summaries carry; the toggle names what it shows. `npm run screenshots:gen` for the changed surfaces; `npm run vocabulary:gen` re-records the final shrink — the enumerated surfaces' baseline should reach zero here, the record's acceptance gate.
- **Patterns to follow**: the neighbouring page tests' mount fixtures (`web/src/testing/mount.ts`); the screenshots manifest flow (`screenshots:check` names the stale surface).
- **Test scenarios**:
  - `web/src/pages/unitPage.test.ts`: the count line names one thread; the ordinal phrasing renders; the not-started sentence names the pipeline.
  - `web/src/pages/runPage.test.ts`: a unit-lineage link reads "pipeline"; a conductor child's link reads "parent run".
  - `web/src/pages/delivery.test.ts`: the column header reads "Issue".
  - `web/src/pages/runsIndex.test.ts`: command and door rows absent by default; the toggle reveals them; `aria` names the control.
- **Verification**: `npx vitest run` on the touched page tests; `npm run vocabulary:check` at (or explaining any distance from) zero; `npm run screenshots:check`; before/after screenshots on the pull request (human-gated).

## Verification Contract

The record's criteria, each bound to a test id or check name; every row `[gap]` until its unit merges.

| Criterion | Proof |
| --- | --- |
| The vocabulary page exists with one row per noun in the schema and ships in the built site | `npm run docs:check`; `npm run check:site` with the page in `REQUIRED_PAGES` [gap: U1] |
| AGENTS.md and the landing page link the page first | human-gated: named in U1's pull request; no check asserts link order [gap: U1] |
| Records 0031, 0035, 0043 accepted; 0034 superseded naming its successor | `npm run decisions:check` [gap: U2] |
| The cited specs link a noun's vocabulary row at first use | `npm run specs:check` green over the linked specs (links move no proofs) [gap: U3] |
| A vocabulary row whose carrying type is renamed or deleted fails by the row's name | `src/docs/vocabulary.test.ts::a row names the carrying type it imports`; the typecheck; `npm run docs:check` on a stale region [gap: U4] |
| An internal word printed on a user surface fails; the baseline only shrinks | `src/vocabularyCheck.test.ts::extracts string literals, never identifiers or comments`; `src/vocabularyCheck.test.ts::growth is refused; shrink demands a re-recorded baseline` [gap: U5] |
| One `RoundKind` spelling with the `merge` kind and every floor value intact | `src/core/budgets.check.test.ts::the budgets module — one table every wall clock derives from…` [gap: U6] |
| The renamed counter's tests and spec rows moved with it | `npm run specs:check` over the moved rows [gap: U6] |
| The bot's summaries, plane table, report label, card sentences and stop refusal read the nouns | `src/core/commands/runs.test.ts`, `src/core/commands/plane.test.ts`, `src/core/delivery.test.ts` (the U7 scenarios); the re-recorded baseline [gap: U7] |
| dashboard-routes reads one thread, documents `GET /plane`, says thread | the re-recorded baseline; the pull request's diff (the rows sit outside any generated region — human-gated) [gap: U8] |
| The unit, run, Delivery and home labels read the nouns | `web/src/pages/unitPage.test.ts`, `runPage.test.ts`, `delivery.test.ts`, `home.test.ts` (the U9 scenarios) [gap: U9] |
| Command and door rows hidden by default behind a toggle | `web/src/pages/runsIndex.test.ts` (the U9 scenario) — built only on the confirmed call [gap: U9] |
| The enumerated surfaces' baseline reaches zero (the record's acceptance gate) | `npm run vocabulary:check` with an empty baseline for the enumerated surfaces [gap: U9] |

- Every unit: the fast gates at the changed-set scope — `npx vitest run` on the touched test files by name, the touched tsconfig's `tsc --noEmit` under `NODE_OPTIONS=--max-old-space-size=6144`, `npx prettier --check` on the changed files, `npm run hygiene:check`, `npm run specs:check` — plus `npm run check:pr-title`; CI's `verify` is the gate on the pull request, never the full suite locally.

## Definition of Done

- The nine pull requests are merged; the vocabulary page is linked first and its table is a generated, type-importing region; `vocabulary:check` runs under `check:consistency`; the enumerated surfaces' baseline is zero and only shrinks; the four records are decided; and record 0066 is `accepted` with the maintainer's two calls confirmed.
