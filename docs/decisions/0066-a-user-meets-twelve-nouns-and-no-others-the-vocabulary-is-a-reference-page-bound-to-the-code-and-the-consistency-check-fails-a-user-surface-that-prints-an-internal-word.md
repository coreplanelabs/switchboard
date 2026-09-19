---
title: A user meets twelve nouns and no others; the vocabulary is a reference page bound to the code, and the consistency check fails a user surface that prints an internal word
status: proposed
date: 2026-09-19
pattern: Ubiquitous language published as one glossary rendered as a generated region from a typed list that imports the code types carrying it; an anti-corruption layer at every user surface (internal words are translated at the boundary, never printed); a ratchet whose recorded baseline only shrinks, driven to zero as the acceptance gate
---

# A user meets twelve nouns and no others; the vocabulary is a reference page bound to the code, and the consistency check fails a user surface that prints an internal word

**The ask.** Decide (the maintainer, before the plan's first unit is seeded): the product speaks twelve user nouns, each with exactly one meaning; every other word the system uses internally is allowed in specs, records and code and never printed on a user surface; the vocabulary is one reference page rendered from a typed list bound to the code types that carry it, and two checks under `verify` hold the line — a generated-region binding whose typed list imports the carrying types, and a `vocabulary:check` that fails an internal word extracted from a user-facing surface. Written for an engineer who knows the runs index, the run page, the card, the command registry and the docs tree. Success criteria:

1. A reader of any user surface — a card, a reply, a web label, a command summary, a how-to — meets only the twelve nouns, their values, the requester, plain English and proper names (an agent preset, a repository, a pull request number). This criterion is `[gap]` until the retirement units drive the recorded baseline to zero — that zero is the record's acceptance gate.
2. `docs/reference/vocabulary.md` exists, one row per noun, its table a generated region rendered from a typed list under `src/docs/` that imports each row's carrying type — so a rename fails the typecheck and a stale region fails `docs:check` by the row's name.
3. An internal word newly printed on a user surface — a string literal in the enumerated bot modules, a web template text node, a line of the non-spec docs trees — fails `vocabulary:check`; the recorded baseline of current violations only shrinks. Model-written prose is out of the check's reach and is governed by the preset instructions and the review (see the difficulty map).
4. The words the product prints agree with the words the code carries: the `fix` round is renamed `findings` end to end, so the two `RoundKind` unions spell the same passes and the coordinator stops translating one word into the other.
5. Specs, decision records and code keep their internal vocabulary; nothing forces a spec to say "budget" where it means the ledger's lease.

_Amended 2026-09-19 (pull request 1986, round two): criterion 1 gained the values-and-plain-English carve-out and the acceptance gate (a shrinking baseline alone would let today's violations sit forever); criterion 2 restated the binding as a generated region from a typed list (`docs:check` is generate-and-diff and parses no sources); criterion 3 named the extraction surfaces and the model-prose limit; criterion 4 became a rename that keeps the `merge` round instead of a union collapse that would delete a live kind._

## TL;DR

There is no glossary. "Session" names eleven code types plus the sandbox's and the OpenCode client's vendor sessions; the two `RoundKind` unions spell the same pass `fix` in one file and `findings` in the other, with a translation between them; three surfaces and a reference table still say a unit has two threads after [record 0055](0055-a-unit-has-one-thread-and-a-round-reads-the-checks-at-its-head.md) made it one; the same link is labelled "parent run" on one page state and "pipeline run" on another; "lease" appears 197 times in the specs and zero times in the how-to and tutorial trees, where the product says "budget"; and `attempt`, `runner`, `owner-gap` and `idle` reach users with no definition anywhere a user can read. The bet: fix the user's vocabulary at twelve nouns — thread, run, agent, pipeline, unit, round, budget, follow-up, verdict, outcome, card, pull request — publish it as one reference page whose table is generated from a typed list importing the carrying types, and make the boundary a guarantee instead of discipline: `docs:check` fails a stale vocabulary region, and `vocabulary:check` fails an internal word extracted from a user surface, with today's violations as a ratchet baseline that only shrinks and reaches zero at acceptance. It costs one reference page, one explanation page, two check extensions, a small code cleanup and the retirement of a dozen user strings. Doing nothing leaves every new surface free to mint its own words, and the drift compounds: the two-thread wording and the twin `RoundKind` unions are what a year of that looks like.

_Amended 2026-09-19 (pull request 1986, round two): the session count corrected (eleven types, not six meanings), the union sentence restated as a spelling disagreement rather than a missing round, and the checks renamed to what the shape now specifies._

## Today at `23ccafce`

Every claim verified at head.

_Amended 2026-09-19 (pull request 1986, round two): the table is re-verified and re-pinned at `23ccafce` (line numbers had drifted); the session row fixes its count, `HarnessSession`'s home and the swapped `SessionSeed`/`SessionTail` lines; the `RoundKind` row now names the coordinator's findings→fix translation; the two-thread row is narrowed to the four unconditional strings (the conditional renderings are deliberate pre-0055 legacy pinned by 0055's own tests); the owner-gap row is repointed from the web gloss to the chat plane table that prints the flag verbatim (the round-one nit); and the stop-semantics row is deleted — `docs/how-to/watch-a-run.md` describes what `src/core/dispatcher.ts` does at head, and [record 0051](0051-a-thread-has-one-owner-for-its-life-a-message-is-one-event-in-a-chosen-mode-and-a-pipeline-idles-instead-of-ending.md)'s idle wake is a pipeline unit's and not built yet._

| Claim | Proof at `23ccafce` |
| --- | --- |
| No glossary or vocabulary page exists anywhere in the docs tree | `docs/reference/` holds README, authorization, cli, code-map, configuration, dashboard-routes, migrations, slack-commands and specs; no file in `docs/` defines the product's nouns |
| "Session" names eleven code types plus the sandbox's and the OpenCode client's vendor sessions | `UnitSession` (`src/core/ship/coordinator.ts` line 795), `RunSession` (`src/core/runRecord.ts` line 527), `SessionTail`/`SessionSeed` (`src/core/dispatch/seed.ts` lines 42 and 55), `HarnessSession` (`src/core/harness/contract.ts` line 376), `SessionCapability`/`SessionAssets` (`src/tools/session.ts` lines 30 and 55), `SessionSearchHit`/`SessionSearchView` (`src/core/runsService.ts` lines 323 and 333), `SessionLog` (`src/core/runLedger/inMemory.ts` line 60), `SessionHit` (`src/core/runLedger/types.ts` line 237) — plus the OpenCode client's wrappers of that vendor's session (`src/core/harness/opencode/client.ts` lines 103 and 116) and the sandbox's exec sessions (`src/execution/sandboxLifecycle.ts` line 21) |
| `UnitSession` is a lease-segment counter with no transcript | `src/core/ship/coordinator.ts` lines 795 to 803: `segment`, `renewalsSpent`, `spendUsd`, `continueFrom`, the previous run and handoff — nothing conversational |
| The two `RoundKind` unions spell the same pass two ways, with a translation between them | `src/core/budgets.ts` line 146: `"coding" \| "review" \| "fix" \| "merge"`, with `fix` floored in `FLOORS` (line 166) and the merge wait asked at `MERGE_WAIT_ASK_MINUTES` (line 173); `src/core/ship/coordinator.ts` line 402: `"coding" \| "review" \| "findings"`, whose comment says the findings step's child is a coding run; line 1018 translates `findings` to `fix` for the ledger |
| Four unconditional strings still say a unit has two threads | `src/core/commands/runs.ts` line 393 (the `runs unit` command summary, which is also the `runs_unit` MCP tool's description), `web/src/pages/UnitPage.vue` lines 272 to 273 (the "Runs by round" heading's count line), `docs/reference/dashboard-routes.md` lines 17 and 63 — after accepted [record 0055](0055-a-unit-has-one-thread-and-a-round-reads-the-checks-at-its-head.md) made a unit one thread. (The conditional renderings — `runs.ts` line 376, `UnitPage.vue` lines 201 to 218 — are deliberate legacy paths for rows written before 0055, pinned by 0055's own tests, and stay.) |
| The run page labels the same link two ways | `web/src/pages/RunPage.vue` lines 588 to 589: `"pipeline run"` when the lineage names a unit, `"parent run"` otherwise |
| The Delivery page's "Unit" column is an issue plus its pull requests, unrelated to a plan unit | `web/src/pages/DeliveryPage.vue` line 160; the table is one row per board issue the pull requests link |
| `attempt`, `runner`, `owner-gap` and `idle` reach user surfaces with no user-facing definition | `web/src/pages/UnitPage.vue` line 233 (`attempt {{ … }}`) and line 287 ("the runner has not started this unit"); `src/core/commands/plane.ts` line 45 prints the raw health flags verbatim (`row.health.join(",")` — the chat and CLI `plane show` and the `plane_show` MCP output), `UnitHealth` including `idle` and `owner-gap` (`src/core/plane/table.ts` line 46); the web badge already translates `owner-gap` to "approved, open, nobody's" (`web/src/pages/PlanePage.vue` line 82) |
| The Plane page is routed and undocumented | `web/src/routes.ts` line 32 routes `GET /plane`; `docs/reference/dashboard-routes.md` lists `/api/plane.show` (line 93) and no `/plane` page row |
| "Lease" is spec vocabulary that never reaches a user doc | 197 word hits across `docs/reference/specs/*.md`; zero in `docs/how-to/` and `docs/tutorials/` (the only non-spec hits are record titles quoted in generated indexes); the product's own knob is `--boundary.maxMinutes`, glossed as a budget (`docs/how-to/configure-your-defaults.md`) |
| The records that define coordinator, session, conversation and chat are still proposed | records [0031](0031-the-coordinator-runs-a-plan-not-a-pull-request.md), [0034](0034-one-agent-per-unit-a-run-continues-a-transcript.md), [0035](0035-a-session-log-outlives-its-runs-compaction-is-a-pointer.md) and [0043](0043-the-home-page-is-a-chat-the-browser-is-a-channel-and-a-turn-is-a-run.md) all carry `status: proposed` while shipped specs cite them (agent-ship.md, live-view.md, web-chat.md, command-registry.md among others) |
| A docstring sits above the wrong type | `src/core/coordinator/contract.ts` lines 377 to 381: the comment "One unit of the plan an instance runs …" sits directly above `RoundGate` (line 383), not `CoordinatorUnit` (line 388) |

## The shape

### The twelve nouns

The vocabulary page's row schema, stated once: **meaning, what it holds, what it belongs to, the carrying code type, the surfaces that print it** — every row carries all five. The table below carries the meaning and the carrying type; the page carries the full schema.

_Amended 2026-09-19 (pull request 1986, round two): the schema is stated once and the table gained the carrying-type column; the run row dropped "one transcript" (a pipeline is a run with no transcript of its own, [record 0060](0060-a-ship-pipeline-is-a-live-run-for-its-whole-life-and-runs-on-every-channel-that-can-open-a-thread.md)); the thread row's "one live at a time" is qualified the same way; the round row keeps the `merge` kind; the budget row belongs to a run, a unit or a pipeline; the outcome row widened to standing so it holds `idle` (0051 defines idle as a unit with no ending)._

| Noun | Meaning | Carried by |
| --- | --- | --- |
| **thread** | Where you talk — a Slack thread or a web thread. Holds runs — one live model run at a time; a pipeline's own hosted run occupies no thread ([record 0060](0060-a-ship-pipeline-is-a-live-run-for-its-whole-life-and-runs-on-every-channel-that-can-open-a-thread.md)). | the thread key on `RunSummary` (`src/core/runRegistry/projections.ts`) |
| **run** | One piece of work: one request, one agent, one outcome. Belongs to one thread — and a pipeline is a run. | `RunRecord` (`src/core/runRecord.ts`) |
| **agent** | The kind of run: general, coding, review, ship, research, explore, conductor. | `Preset` (`src/core/budgets.ts`) |
| **pipeline** | Ship's job on a plan: asked in one thread, ending with a report there. Holds units. | `CoordinatorInstance` (`src/core/coordinator/contract.ts`) |
| **unit** | One deliverable of a pipeline: its own branch, its own pull request, its own thread. Holds rounds. | `CoordinatorUnit` (`src/core/coordinator/contract.ts`) |
| **round** | One pass over a unit — coding, review, findings or merge; the first three spawn child runs, the merge round waits on the guards. | `RoundKind` (`src/core/budgets.ts`) |
| **budget** | The minutes a run, a unit or a pipeline may spend; renewable. | `Grant` and the lease arithmetic (`src/core/budgets.ts`) |
| **follow-up** | A reply in a thread, during or after a run. | `FollowUpInput` (`src/core/threadAdmission.ts`) |
| **verdict** | The review's findings joined with the checks at the reviewed head. | `ReviewVerdict` (`src/core/reviewVerdict.ts`) |
| **outcome** | How a run or a unit stands once it is not working — ended or idle; merged, merge-ready, idle, failed, stopped are its values. | `UnitEnding` (`src/core/ship/coordinator.ts`), the status on `RunSummary` |
| **card** | The message Switchboard keeps updating in a thread for a run. | `StatusUpdate`/`StatusHandle` on `ChannelIO` (`src/core/types.ts`) |
| **pull request** | GitHub's own noun, unchanged. | the pull request fields on `CoordinatorUnit`; `PlanePullRequestRow` (`src/core/plane/table.ts`) |

The person is the **requester** — one word on every surface, whoever they are to GitHub or to the config.

### Nouns versus values

_Added 2026-09-19 (pull request 1986, round two): without this rule "twelve and no others" was untestable — the record's own trace prints requester, issue, model, effort, idle and merge-ready._

The twelve are the domain nouns. A noun's **values** — an outcome's `merged`, `merge-ready`, `idle`, `aborted`, `failed`, `stopped`; an agent's preset names; a model's name — and **plain English** (issue, minutes, branch, model, effort) are not nouns and need no row. A surface prints a value or plain English freely; what it may not print is an internal word.

### By rule, not only by enumeration

_Added 2026-09-19 (pull request 1986, round two): the boundary must classify a future surface, not only today's list._

- A **user surface** is anything the product prints to a person who has not opened the repository: a card or reply string the bot code prints, a command or tool summary the registry publishes, a web label, and the non-spec docs trees (reference, how-to, tutorials, explanation). Specs, decision records, plans, code and code comments are not user surfaces.
- An **internal word** is a word whose product sense exists only behind a seam — it names a mechanism (a ledger claim, a scheduler's counter, a host's key) rather than a thing the requester asked for or received. A word with a common English sense is internal only in its product sense, which is why the mechanical check is scoped to the unambiguous ones and the rest stay editorial.

### The collapse

Every synonym a surface prints today reads as its noun:

_Amended 2026-09-19 (pull request 1986, round two): "parent run" collapses only on the unit lineage — a conductor's child has a parent run that is no pipeline, and keeps the phrase; `attempt` is an ordinal, phrased rather than dropped; the fix round is a rename to `findings`, not a deletion; coordinator moved to the internal-word rule (one rule, stated once)._

- **conversation** and **chat** become **thread** (the web rail keeps its "Threads" heading — decided, see the maintainer calls).
- **instance**, **hosted parent**, **plan runner** and — on the unit lineage only — **parent run** and **pipeline run** all read as **pipeline**. A conductor's child keeps "parent run": its parent is a run, not a pipeline.
- **attempt** is an ordinal, not a synonym: a surface says "the second pipeline for this plan", never `attempt 2`.
- **task** and the plan's U-ids read as **unit**.
- the **fix** round is renamed **findings** end to end (one spelling in both unions, the translation removed); a round is named by its pass: coding, review, findings, merge.
- **lease**, **segment**, **renewal** and **grant** read as **budget** — a budget is "renewed", never "segment 2".
- **steer**, **nudge**, **wake** and **thread event** read as **follow-up**.
- **ending** reads as **outcome**.
- the model-and-effort "card" or "tier" is just **model** and **effort** — "card" belongs to the thread message alone.
- **owner**, **actor**, **maintainer** and operator-as-a-person read as **requester**.
- **turn** reads as **run** (the home page's turn is a run's rendering, and says so).
- the **owner-gap** badge reads as **merge-ready, unmerged**.
- the Delivery page's "Unit" column reads as **issue**, which is what it counts.
- **conductor** stays a preset name.

### The internal words

_Amended 2026-09-19 (pull request 1986, round two): the mechanical list is scoped to the fourteen unambiguous internal senses — `door`, `carve`, `floor`, `fit`, `ask`, `fold`, `wake` and `operator` are common English or vendor nouns (GitHub-hosted runners live in the how-to tree) and stay editorial; the narrowing the earlier draft kept as a fallback is now the design._

Allowed in specs, decision records and code — never on a user surface, and policed mechanically by `vocabulary:check`: **session, lease** (the ledger's claim)**, segment, instance, attempt, hosted** (as "hosted run/parent/pipeline" only)**, host key, coordinator, runner** (as "plan runner" only)**, admission, intake, handoff, wind-down, tier**. One rule for **coordinator**: an internal word whose user referent is **pipeline** — it is never printed. The remaining boundary words (door, carve, floor, fit, ask, fold, wake, operator in the model-turn sense) are editorial: the review holds them, not the check. The specs keep their precision; the boundary translates.

### Two maintainer calls to record

1. **The web rail says "Threads"** — decided. The rail is the thread noun's own surface; renaming it to anything else would contradict the collapse.
2. **Command and door rows are hidden from the user's Runs list by default** — recommended, to confirm at acceptance. A run whose agent is `command` or `door` is bookkeeping, not one of the twelve nouns' referents; a toggle shows them.

### The pages

- **`docs/reference/vocabulary.md`** — one row per noun in the schema above. Its table is a **generated region** (`docs:gen`/`docs:check`, like the reference tables today) rendered from a typed list under `src/docs/` that imports each row's carrying type (`import type { CoordinatorUnit } …`): a rename fails the typecheck, and a hand edit or a stale region fails `docs:check` by the row's name. Linked first from AGENTS.md and from the docs landing page, before the code map.
- **One explanation page** carries the containment diagram: a thread holds runs; a pipeline is asked in a thread and each unit gets its own thread; rounds spawn child runs into it.
- **Every spec links the vocabulary row at a noun's first use**, so a spec's internal words are read against the user noun they surface as.

_Amended 2026-09-19 (pull request 1986, round two): the binding is restated as a generated region rendered from a typed list — `docs:check` is generate-and-diff over typed regions and parses no sources, so "resolved the way spec proofs are resolved" described a mechanism that does not exist._

### The code cleanup

_Moved here 2026-09-19 (pull request 1986, round two) from Boundaries, where a rename sat under "Not changed"._

- One spelling for the fix/findings round: `RoundKind` becomes `"coding" | "review" | "findings" | "merge"` in both files — `fix` renamed to `findings` in `FLOORS` and the ask arithmetic of `src/core/budgets.ts`, the coordinator's findings→fix translation (`src/core/ship/coordinator.ts` line 1018) removed. The `merge` kind stays: it has a floor, an ask (`MERGE_WAIT_ASK_MINUTES`), a loop position and a reserve term, and accepted [record 0046](0046-a-budget-is-a-lease-carved-from-its-parent-and-one-module-proves-the-leases-fit.md) derives the fit from the merge wait's floor. A rename, never a behaviour change.
- `UnitSession` is renamed to what it is — a lease-segment progress counter — with its tests and spec rows.
- The "One unit of the plan …" docstring in `src/core/coordinator/contract.ts` moves above `CoordinatorUnit`.

### Two checks make it a guarantee

_Amended 2026-09-19 (pull request 1986, round two): the hygiene class as first drafted was a per-line regex over `src/`, which would hit identifiers, imports and comments (`session` appears 343 times in the dispatch and ship sources); the check must read what is printed. It is now a sibling `vocabulary:check`, extraction-based, sharing public-hygiene's baseline and ratchet helpers; the vocabulary page and the public-hygiene spec are exempt by path, and the "no allow-list over prose" principle is reworded to what the mechanism actually holds._

- **`docs:check` holds the binding** through the generated vocabulary region: the typed list under `src/docs/` imports the carrying types, so a renamed or deleted type fails the typecheck and a stale table fails `docs:check` by the row's name.
- **`vocabulary:check`, a sibling of `hygiene:check` under `check:consistency`**, fails one of the fourteen internal words where a user can read it. It reads **what is printed, never what the code says to itself**: string and template literals extracted from the enumerated bot modules (`src/core/dispatch/`, `src/core/ship/`, the command registry's summaries and tool descriptions) by a TypeScript AST pass; the text nodes of the web templates under `web/src/`; and the lines of the non-spec docs trees (reference, how-to, tutorials, explanation). It shares `scripts/public-hygiene.mjs`'s baseline and ratchet helpers: the current violations are recorded once (`hygiene:gen -- --force` for the new class) and the baseline only shrinks, re-recorded in the same pull request as every retirement. `docs/reference/vocabulary.md` and the public-hygiene spec are exempt by path (`classesFor`), the way the allow file already exempts pages that quote the banned words.
- **The principle**: no permanent per-line exceptions for printed strings — a violation is rewritten or it sits on the shrinking baseline; a page whose job is to quote the words is exempt by path, never line by line.
- **What the check cannot see, and who holds it**: card checklists and most replies are written by the model at runtime, and badge text flows from data — the check reads none of it. Model prose is governed by the preset instructions, which cite the vocabulary page, and by the review that reads the specs a change touches. The acceptance gate is the check's half: the enumerated surfaces' baseline reaches zero, driven there by the retirement units.

## One trace: a unit at its budget, a findings round, and every word on the way

The hard case is the one where today's surfaces use the most synonyms at once: a pipeline's unit exhausts its budget and later rounds carry it to the merge.

_Amended 2026-09-19 (pull request 1986, round two): the waking-reply step is deleted with the stop-semantics proof row (0051's idle wake is not built yet, so the step narrated the future as the present); the round step keeps the `merge` kind and describes the rename; the owner-gap step is repointed to the chat plane table; the hidden-rows and ordinal phrasings are marked as the proposed state, not narrated as shipped._

1. A requester asks for a two-unit plan in a Slack thread. Today the card says the work was "handed to the plan runner" and the run page's lineage link may say "parent run"; the runs list shows the parent, its children, and — interleaved — `command` and `door` rows. After: the card says the **pipeline** started and the unit lineage's link says **pipeline** (a conductor's children keep "parent run"); under the recommended call — proposed, to confirm at acceptance — the bookkeeping rows are hidden by default.
2. The first unit's coding run exhausts its lease segment. Today the unit page could say `attempt 2`, the plane table says `idle`, and a spec-literate reader knows a "renewal" was "spent" on a "segment". After: the card and the unit page say the unit's **budget** ran out and the unit is **idle** — an **outcome** value, not a new noun; a renewal prints as "budget renewed", never "segment 2"; a retry reads as an ordinal — "the second pipeline for this plan" — never `attempt 2`.
3. A later coding round pushes; the review round requests changes; the findings pass runs. Today one union spells that pass `fix` with its own floor while the other spells it `findings` and a translation bridges them at the ledger. After: one spelling — coding, review, findings, merge — with the floors unchanged; the surfaces print **round**.
4. The review approves and the checks pass; the pull request sits open, nobody's. Today the chat and CLI plane table and the `plane_show` MCP output print the raw flag — `owner-gap` in `row.health.join(",")` — while the web badge already glosses it. After: every surface reads **merge-ready, unmerged** — the same fact in the user's nouns.
5. The pipeline reports in the asking thread. Today the report's ending words and the record's "ending" field mix with the page's "outcome". After: every surface says **outcome**.

At every step the internal machinery kept its words — the ledger still holds a lease, the runner still counts segments — and the boundary translated once. The property: a requester can read the whole trace without meeting a word the vocabulary page does not define, a noun value, or plain English.

## Records this design amends

_Added 2026-09-19 (pull request 1986, round two): three collapses rewrite strings that accepted or implemented records made binding; the amendments are recorded here with their replacement sentences rather than left for the retirement units to discover._

- **[Record 0046](0046-a-budget-is-a-lease-carved-from-its-parent-and-one-module-proves-the-leases-fit.md)** (accepted) names the card sentences in its trace. Replacements: `budget 45 min (carved from ship's 120; holds 60 for …)` → `budget 45 min (from the pipeline's 120; 60 min held for the rounds to come)`; `renewal 1 of 6, continues a1b2c3d` → `budget renewed, 1 of 6, continues a1b2c3d`; `no progress in the last lease; grant holds 5 renewals; reply continue to spend one` → `no progress on the last budget; 5 renewals left; reply continue to spend one`. The lease arithmetic, the floors and the fit are untouched — only the printed words move.
- **[Record 0051](0051-a-thread-has-one-owner-for-its-life-a-message-is-one-event-in-a-chosen-mode-and-a-pipeline-idles-instead-of-ending.md)** (proposed) repeats the grant sentence; the same replacement applies.
- **[Record 0060](0060-a-ship-pipeline-is-a-live-run-for-its-whole-life-and-runs-on-every-channel-that-can-open-a-thread.md)** (implemented) fixes the hosted stop refusal (`HOSTED_STOP_REFUSAL` in `src/core/commands/runs.ts`, also the `runs_stop` MCP description). Replacement: `this run is a pipeline; its units run in their own threads, so a soft stop ends nothing; --mode hard is the escape: it seals the run failed and releases the thread`.

This record amends those records' printed wording; their mechanisms, floors and refusal semantics stand.

## Spec rows that change with the code

_Added 2026-09-19 (pull request 1986, round two), the 0060/0064 shape: the units move these rows in the same pull requests as the strings._

- [public-hygiene.md](../reference/specs/public-hygiene.md) — the sibling `vocabulary:check`, its extraction surfaces, its shared ratchet and its path exemptions.
- [agent-ship.md](../reference/specs/agent-ship.md) — the round words (items 8 and 12) and the unit summary (item 17) once `fix` is renamed and the two-thread wording retires.
- [live-view.md](../reference/specs/live-view.md) — the unit page's wording (item 28), the lineage link, the runs-index default filter if the recommended call is confirmed.
- [command-registry.md](../reference/specs/command-registry.md) — `runs unit`'s summary and the `runs_stop`/`runs_unit` descriptions.
- [orchestration-plane.md](../reference/specs/orchestration-plane.md) — the plane table's health rendering (`owner-gap` → merge-ready, unmerged).
- The docs-check spec rows — the generated vocabulary region beside the reference tables.

## The difficulty map

_Amended 2026-09-19 (pull request 1986, round two): the first row's risk was stated as over-matching only; the under-matching half — the prose the check cannot see — is now named._

1. **The extraction boundary** (the checks): extracting exactly what is printed — string literals from the enumerated bot modules, web template text nodes, non-spec docs lines — without hitting identifiers or comments (over-matching) and knowing what the check cannot see (under-matching: model-written card checklists and replies, badge text flowing from data — governed by the preset instructions and the review, never by the check). (most work)
2. **The binding region**: the typed list under `src/docs/` importing the carrying types; cheap, but the failure sentence must name the row, and the region must regenerate like the reference tables.
3. **The retirements**: a dozen strings across the bot, the web bundle and the reference docs, each with tests and screenshots pinning the old words, each re-recording the baseline in its own pull request.
4. **The four records**: [0031](0031-the-coordinator-runs-a-plan-not-a-pull-request.md), [0034](0034-one-agent-per-unit-a-run-continues-a-transcript.md), [0035](0035-a-session-log-outlives-its-runs-compaction-is-a-pointer.md) and [0043](0043-the-home-page-is-a-chat-the-browser-is-a-channel-and-a-turn-is-a-run.md) define coordinator, session, conversation and chat and are cited by shipped specs while still proposed; each is accepted or superseded so the vocabulary page has settled ground to bind to, and `decisions:check`'s rules (supersede, never edit) shape how. Per record, the intended status: **0031 accepted** (the coordinator runs a plan, not a pull request — the machinery holds; the word "coordinator" merely never prints); **0034 superseded** (`superseded_by` a successor restating the reading unit in the twelve-noun frame — its review-thread rationale was undone by [record 0055](0055-a-unit-has-one-thread-and-a-round-reads-the-checks-at-its-head.md) and its session trade by [record 0057](0057-the-operator-is-the-one-door-a-model-binds-every-chat-input-and-deterministic-code-authorizes-fences-and-executes.md)); **0035 accepted** (the session log outlives its runs — the mechanism stands and "session" stays internal; its user surface reads thread); **0043 accepted** (the browser is a channel and a turn is a run; the rail's heading is the thread noun's surface, and the home page's "turn" retires with the collapse). Acceptance freezes a body byte for byte (`src/docs/records.ts`), so a record whose words must change is superseded, never accepted-then-edited. A superseded record names `superseded_by` or `decisions:check` fails.

_The per-record statuses were added 2026-09-19 (pull request 1986, round two): acceptance freezes a body byte for byte, so which record can be accepted as-is and which must be superseded is a design call, not an implementation detail._

## Why not X

**Why not rename the internal words too, one vocabulary everywhere?** The specs' precision is load-bearing: "lease" names a ledger claim with expiry semantics "budget" does not carry, and 197 spec uses would blur into a word that means minutes to a user. The boundary is cheaper than the flattening, and the anti-corruption layer is the named pattern for exactly this.

**Why not per-line exceptions instead of a ratchet?** A per-line exception list grows; a baseline shrinks and gates acceptance at zero. The hygiene mechanism already proves the ratchet works. Pages whose job is to quote the internal words — the vocabulary page, the public-hygiene spec — are exempt by path, which is a property of the page, not a granted exception for a line. _(Reworded 2026-09-19, pull request 1986 round two: the earlier "no allow-list over prose" contradicted both the mechanism and the vocabulary page itself, which would have been the class's largest hit.)_

**Why not a style guide instead of checks?** The two-thread wording survived an accepted record that removed the second thread; the twin `RoundKind` spellings survived in one file pair with a translation between them. Discipline was tried; the drift is the evidence.

## Boundaries

Not changed: the specs' and records' internal vocabulary; the code's type names beyond the renames the shape lists; the plane table's health axis beyond the `owner-gap` badge's rendering; the conductor preset's name. Not owned here: [record 0064](0064-the-plane-owns-every-runs-state-a-refusal-becomes-a-queue-position-an-ending-is-judged-by-the-ledger-that-saw-it-and-a-release-is-a-quiet-window-a-person-closes.md)'s plane conditions and [record 0065](0065-a-hosted-pipeline-run-is-an-orchestrator-every-surface-reads-its-standing-from-its-own-events-never-from-a-model-runs-signals.md)'s standing vocabulary — their stage words are the round and outcome nouns' values, not new nouns; [record 0052](0052-a-run-resolves-one-model-card-and-every-control-is-decided-against-it-before-the-first-call.md)'s "model card" and [record 0057](0057-the-operator-is-the-one-door-a-model-binds-every-chat-input-and-deterministic-code-authorizes-fences-and-executes.md)'s operator door (both proposed) keep their internal words — this record only says a user surface prints **model** and **effort**, never "card" or "tier" in that sense. Compatibility: the vocabulary page and the checks are additive; the string retirements change words, never shapes or routes (the `/threads` rail keeps its path and heading).

_Amended 2026-09-19 (pull request 1986, round two): the `UnitSession` rename moved from here to the shape (it is a change, not a non-change), and records 0052 and 0057 are named for the tier and card senses._

## What would change our mind

- *A thirteenth noun keeps forcing itself in.* If the retirements cannot express a surface without a new word (the plane's health axis is the candidate), the vocabulary page gains a row by amendment, not by a surface minting one silently.
- *Even the fourteen unambiguous words drown the check in false hits.* The scope is already the design — the ambiguous words stay editorial. If extraction still cannot hold the fourteen (a quoted example in a how-to, a literal that is data rather than prose), the class narrows further by amendment, never by a per-line exception.

_Amended 2026-09-19 (pull request 1986, round two): the second bullet's narrowing was the fallback and is now the design; the bullet keeps only the residual risk._

## Rollout

One plan, `docs/plans/2026-09-19-003-feat-twelve-user-nouns-plan.md`, in the same pull request as this record. Nine units: the vocabulary and explanation pages with the AGENTS.md and landing links; the acceptance or supersession of records 0031, 0034, 0035 and 0043; the spec links at first noun use; the generated vocabulary region bound through the typed list; `vocabulary:check` with its baseline; the code cleanup (one `RoundKind` spelling with the `merge` kind kept, `UnitSession` renamed to what it is, the misplaced docstring moved); and the retirements split three ways — the bot's printed strings, the docs pages, and the web labels last, gated on the maintainer's check-in for frontend work and on the command/door default being confirmed. Each unit binds its criteria to test ids or check names in the plan's Verification Contract — the plan's closing table, whose rows are `[gap]` (a criterion named but not yet proven, the specs' own marker — [docs/reference/specs/README.md](../reference/specs/README.md)) until their units merge.

_Amended 2026-09-19 (pull request 1986, round two): six units became nine — the spec links split from the records unit, and the retirements split into bot strings, docs and web, the web unit last and gated; `[gap]` and the Verification Contract are defined at first use._

## Sources

Records [0031](0031-the-coordinator-runs-a-plan-not-a-pull-request.md), [0034](0034-one-agent-per-unit-a-run-continues-a-transcript.md), [0035](0035-a-session-log-outlives-its-runs-compaction-is-a-pointer.md), [0043](0043-the-home-page-is-a-chat-the-browser-is-a-channel-and-a-turn-is-a-run.md), [0046](0046-a-budget-is-a-lease-carved-from-its-parent-and-one-module-proves-the-leases-fit.md), [0051](0051-a-thread-has-one-owner-for-its-life-a-message-is-one-event-in-a-chosen-mode-and-a-pipeline-idles-instead-of-ending.md), [0055](0055-a-unit-has-one-thread-and-a-round-reads-the-checks-at-its-head.md), [0060](0060-a-ship-pipeline-is-a-live-run-for-its-whole-life-and-runs-on-every-channel-that-can-open-a-thread.md), [0064](0064-the-plane-owns-every-runs-state-a-refusal-becomes-a-queue-position-an-ending-is-judged-by-the-ledger-that-saw-it-and-a-release-is-a-quiet-window-a-person-closes.md), [0065](0065-a-hosted-pipeline-run-is-an-orchestrator-every-surface-reads-its-standing-from-its-own-events-never-from-a-model-runs-signals.md); `docs/reference/specs/public-hygiene.md`; the survey above, verified at `23ccafce`.
