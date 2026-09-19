---
title: A user meets twelve nouns and no others; the vocabulary is a reference page bound to the code, and the consistency check fails a user surface that prints an internal word
status: proposed
date: 2026-09-19
pattern: Ubiquitous language published as one glossary whose rows are bound to the code types that carry them (a binding check, like spec proofs); an anti-corruption layer at every user surface (internal words are translated at the boundary, never printed); a ratchet whose recorded baseline only shrinks
---

# A user meets twelve nouns and no others; the vocabulary is a reference page bound to the code, and the consistency check fails a user surface that prints an internal word

**The ask.** Decide (the maintainer, before the plan's first unit is seeded): the product speaks twelve user nouns, each with exactly one meaning; every other word the system uses internally is allowed in specs, records and code and never printed on a user surface; the vocabulary is one reference page whose rows are bound to the code types that carry them, and two checks under `verify` hold the line — a binding check that every row's code type exists, and a hygiene class that fails an internal word on a user-facing surface. Written for an engineer who knows the runs index, the run page, the card, the command registry and the docs tree. Success criteria:

1. A reader of any user surface — a card, a reply, a web label, a command summary, a how-to — meets only the twelve nouns, the requester, and proper names (an agent preset, a repository, a pull request number).
2. `docs/reference/vocabulary.md` exists, one row per noun, and a row whose carrying code type is renamed or deleted fails `docs:check` by name, the way a spec proof fails `specs:check` today.
3. An internal word newly printed on a user surface fails `hygiene:check`; the recorded baseline of current violations only shrinks. No allow-list over prose.
4. The two `RoundKind` unions become one; the words the product prints agree with the words the code carries.
5. Specs, decision records and code keep their internal vocabulary; nothing forces a spec to say "budget" where it means the ledger's lease.

## TL;DR

There is no glossary. "Session" has six code meanings; two `RoundKind` unions disagree about whether a `fix` round exists; three surfaces and a reference table still say a unit has two threads after record 0055 made it one; the same link is labelled "parent run" on one page state and "pipeline run" on another; "lease" appears 197 times in the specs and zero times in the how-to and tutorial trees, where the product says "budget"; and `attempt`, `runner`, `owner-gap` and `idle` reach users with no definition anywhere a user can read. The bet: fix the user's vocabulary at twelve nouns — thread, run, agent, pipeline, unit, round, budget, follow-up, verdict, outcome, card, pull request — publish it as one reference page whose every row names the code type that carries it, and make the boundary a guarantee instead of discipline: `docs:check` fails a vocabulary row whose type is gone, and `hygiene:check` fails an internal word printed on a user surface, with today's violations as a ratchet baseline that only shrinks. It costs one reference page, one explanation page, two check extensions, a small code cleanup and the retirement of a dozen user strings. Doing nothing leaves every new surface free to mint its own words, and the drift compounds: the two-thread wording and the twin `RoundKind` unions are what a year of that looks like.

## Today at `dd45f6f9`

Every claim verified at head.

| Claim | Proof at `dd45f6f9` |
| --- | --- |
| No glossary or vocabulary page exists anywhere in the docs tree | `docs/reference/` holds README, authorization, cli, code-map, configuration, dashboard-routes, migrations, slack-commands and specs; no file in `docs/` defines the product's nouns |
| "Session" has six code meanings | `UnitSession` (`src/core/ship/coordinator.ts` line 795), `RunSession` (`src/core/runRecord.ts`), `SessionSeed`/`SessionTail` (`src/core/dispatch/seed.ts` lines 42 and 55), `HarnessSession` (`src/core/dispatch/runLoop.ts`), `SessionCapability`/`SessionAssets` (`src/tools/session.ts` lines 30 and 55), `SessionSearchHit` (`src/core/runsService.ts` line 316) — plus the sandbox's exec sessions (`src/execution/sandboxLifecycle.ts` line 21) |
| `UnitSession` is a lease-segment counter with no transcript | `src/core/ship/coordinator.ts` lines 795 to 802: `segment`, `renewalsSpent`, `spendUsd`, `continueFrom`, the previous run and handoff — nothing conversational |
| Two `RoundKind` unions disagree | `src/core/budgets.ts` line 146: `"coding" \| "review" \| "fix" \| "merge"`, with `fix` carved a floor in `FLOORS` (line 164); `src/core/ship/coordinator.ts` line 402: `"coding" \| "review" \| "findings"`, whose comment says the findings step's child is a coding run — no `fix` child exists, and `findings` has no `FLOORS` entry |
| Three surfaces and a reference table still say a unit has two threads | `src/core/commands/runs.ts` line 348 (the `runs unit` summary line: "coding thread …, review thread …") and line 365 (the command summary, which is also the `runs_unit` MCP tool's description); `web/src/pages/UnitPage.vue` lines 201 to 218 and 272; `docs/reference/dashboard-routes.md` lines 17 and 63 — after accepted record 0055 made a unit one thread |
| The run page labels the same link two ways | `web/src/pages/RunPage.vue` lines 588 to 589: `"pipeline run"` when the lineage names a unit, `"parent run"` otherwise |
| The Delivery page's "Unit" column is an issue plus its pull requests, unrelated to a plan unit | `web/src/pages/DeliveryPage.vue` line 160; the table is "one row per board issue the pull requests link" (line 151) |
| `attempt`, `runner`, `owner-gap` and `idle` reach user surfaces with no user-facing definition | `web/src/pages/UnitPage.vue` line 233 (`attempt {{ … }}`) and line 287 ("the runner has not started this unit"); `web/src/pages/PlanePage.vue` line 82 (`owner-gap`); `src/core/plane/table.ts` line 46 (`UnitHealth` includes `idle` and `owner-gap`) |
| The Plane page is routed and undocumented | `web/src/routes.ts` line 30 routes `GET /plane`; `docs/reference/dashboard-routes.md` lists `/api/plane.show` (line 93) and no `/plane` page row |
| "Lease" is spec vocabulary that never reaches a user doc | 197 word hits across `docs/reference/specs/*.md`; zero in `docs/how-to/` and `docs/tutorials/` (the only non-spec hits are record titles quoted in generated indexes); the product's own knob is `--boundary.maxMinutes`, glossed as a budget (`docs/how-to/configure-your-defaults.md` line 57) |
| A how-to contradicts an accepted record on stop semantics | `docs/how-to/watch-a-run.md` line 44: "A follow-up to a stopped run is not run"; accepted record 0051: a stopped pipeline unit idles and a reply wakes it |
| The records that define coordinator, session, conversation and chat are still proposed | records 0031, 0034, 0035 and 0043 all carry `status: proposed` while shipped specs cite them (agent-ship.md, live-view.md, web-chat.md, command-registry.md among others) |
| A docstring sits above the wrong type | `src/core/coordinator/contract.ts` lines 377 to 381: the comment "One unit of the plan an instance runs …" sits directly above `RoundGate` (line 383), not `CoordinatorUnit` (line 388) |

## The shape

### The twelve nouns

Each noun has one meaning, one containment and one carrying code type; the vocabulary page states all three per row.

| Noun | Meaning |
| --- | --- |
| **thread** | Where you talk — a Slack thread or a web conversation. Holds runs, one live at a time. |
| **run** | One piece of work: one request, one agent, one transcript, one outcome. Belongs to one thread. |
| **agent** | The kind of run: general, coding, review, ship, research, explore, conductor. |
| **pipeline** | Ship's job on a plan: asked in one thread, ending with a report there. Holds units. |
| **unit** | One deliverable of a pipeline: its own branch, its own pull request, its own thread. Holds rounds. |
| **round** | One pass over a unit — coding, review or findings; each spawns child runs. |
| **budget** | The minutes a run or a pipeline may spend; renewable. |
| **follow-up** | A reply in a thread, during or after a run. |
| **verdict** | The review's findings joined with the checks at the reviewed head. |
| **outcome** | How a run or a unit ended. |
| **card** | The message Switchboard keeps updating in a thread for a run. |
| **pull request** | GitHub's own noun, unchanged. |

The person is the **requester** — one word on every surface, whoever they are to GitHub or to the config.

### The collapse

Every synonym a surface prints today reads as its noun:

- **conversation** and **chat** become **thread** (the web rail keeps its "Threads" heading — decided, see the maintainer calls).
- **instance**, **attempt**, **hosted parent**, **parent run**, **pipeline run**, **plan runner** and **coordinator** all read as **pipeline**.
- **task** and the plan's U-ids read as **unit**.
- **fix round** and **findings step** read as **round** (a round is named by its pass: coding, review, findings).
- **lease**, **segment**, **renewal** and **grant** read as **budget** — a budget is "renewed", never "segment 2".
- **steer**, **nudge**, **wake** and **thread event** read as **follow-up**.
- **ending** reads as **outcome**.
- the model-and-effort "card" or "tier" is just **model** and **effort** — "card" belongs to the thread message alone.
- **owner**, **actor**, **maintainer** and operator-as-a-person read as **requester**.
- **turn** reads as **run** (the home page's turn is a run's rendering, and says so).
- the **owner-gap** badge reads as **merge-ready, unmerged**.
- the Delivery page's "Unit" column reads as **issue**, which is what it counts.
- **conductor** stays a preset name; **coordinator** is never printed.

### The internal words

Allowed in specs, decision records and code — never on a user surface: session, lease (the ledger's claim), segment, instance, attempt, hosted, host key, coordinator, runner, admission, intake, door, carve, floor, fit, ask, handoff, fold, wind-down, tier, operator (the model turn). The specs keep their precision; the boundary translates.

### Two maintainer calls to record

1. **The web rail says "Threads"** — decided. The rail is the thread noun's own surface; renaming it to anything else would contradict the collapse.
2. **Command and door rows are hidden from the user's Runs list by default** — recommended, to confirm at acceptance. A run whose agent is `command` or `door` is bookkeeping, not one of the twelve nouns' referents; a toggle shows them.

### The pages

- **`docs/reference/vocabulary.md`** — one row per noun: the meaning, what it holds, what it belongs to, the code type that carries it (`RunSummary`, `CoordinatorUnit`, …), and the surfaces that print it. Linked first from AGENTS.md and from the docs landing page, before the code map.
- **One explanation page** carries the containment diagram: a thread holds runs; a pipeline is asked in a thread and each unit gets its own thread; rounds spawn child runs into it.
- **Every spec links the vocabulary row at a noun's first use**, so a spec's internal words are read against the user noun they surface as.

### Two checks make it a guarantee

- **`docs:check` gains a binding check**: every vocabulary row's code type must exist in the tree, resolved the way spec proofs are resolved today. A rename that orphans a row fails the build by the row's name.
- **`hygiene:check` gains a `vocabulary` class**: an internal word on a user-facing site fails. The user-facing set is: card and reply strings in the dispatch and ship modules, the command registry's summaries, web labels, and the non-spec reference, how-to and tutorial docs. The current violations are recorded as the ratchet's baseline, which only shrinks — the mechanism `hygiene:gen` already enforces for its other classes. No allow-list over prose: a violation is rewritten or it stays on the shrinking baseline; nothing is granted a permanent exception.

## One trace: a stopped unit, a waking reply, and every word on the way

The hard case is the one where today's surfaces use the most synonyms at once: a pipeline's unit idles at its budget, the requester replies, and the unit wakes (record 0051's semantics).

1. A requester asks for a two-unit plan in a Slack thread. Today the card says the work was "handed to the plan runner" and the run page's lineage link may say "parent run"; the runs list shows the parent, its children, and — interleaved — `command` and `door` rows. After: the card says the **pipeline** started, the link says **pipeline**, and the bookkeeping rows are hidden by default.
2. The first unit's coding run exhausts its lease segment. Today the unit page could say `attempt 2`, the plane table says `idle`, and a spec-literate reader knows a "renewal" was "spent" on a "segment". After: the card and the unit page say the unit's **budget** ran out and the unit is **idle**; a renewal prints as "budget renewed", never "segment 2".
3. The requester replies in the unit's thread. Today `docs/how-to/watch-a-run.md` says a follow-up to a stopped run "is not run" — false for this case since record 0051. After: the how-to says a **follow-up** to an idle unit wakes it, and the vocabulary row for follow-up covers steer, nudge and wake alike.
4. The woken coding run pushes; the review round requests changes; the findings pass runs. Today one union calls the next child a `fix` round with its own floor while the other says no fix child exists. After: one `RoundKind` — coding, review, findings — with a floor entry for each; the surfaces print **round**.
5. The review approves and the checks pass; the pull request sits open, nobody's. Today the plane badge says `owner-gap`. After: it reads **merge-ready, unmerged** — the same fact in the user's nouns.
6. The pipeline reports in the asking thread. Today the report's ending words and the record's "ending" field mix with the page's "outcome". After: every surface says **outcome**.

At every step the internal machinery kept its words — the ledger still holds a lease, the runner still counts segments — and the boundary translated once. The property: a requester can read the whole trace without meeting a word the vocabulary page does not define.

## The difficulty map

1. **The hygiene surface set** (the checks): deciding mechanically what is "user-facing" — card and reply strings in dispatch and ship, registry summaries, web labels, non-spec docs — without an allow-list over prose; a wrong boundary either misses a surface or fails the specs. (most work)
2. **The binding check**: resolving a vocabulary row's code type like a spec proof; cheap, but the resolution must survive renames with a clear failure sentence.
3. **The retirements**: a dozen strings across the bot, the web bundle and the reference docs, each with tests and screenshots pinning the old words.
4. **The four records**: 0031, 0034, 0035 and 0043 define coordinator, session, conversation and chat and are cited by shipped specs while still proposed; each is accepted or superseded so the vocabulary page has settled ground to bind to, and `decisions:check`'s rules (supersede, never edit) shape how.

## Why not X

**Why not rename the internal words too, one vocabulary everywhere?** The specs' precision is load-bearing: "lease" names a ledger claim with expiry semantics "budget" does not carry, and 197 spec uses would blur into a word that means minutes to a user. The boundary is cheaper than the flattening, and the anti-corruption layer is the named pattern for exactly this.

**Why not an allow-list over prose instead of a ratchet?** An allow-list grows; a baseline shrinks. The hygiene mechanism already proves the ratchet works, and an exception that can be granted forever is discipline again, not a guarantee.

**Why not a style guide instead of checks?** The two-thread wording survived an accepted record that removed the second thread; the twin `RoundKind` unions survived in one file pair. Discipline was tried; the drift is the evidence.

## Boundaries

Not changed: the specs' and records' internal vocabulary; the code's type names except where they lie (`UnitSession` is a lease-segment counter and will be named as one); the plane table's health axis beyond the `owner-gap` badge's rendering; the conductor preset's name. Not owned here: record 0064's plane conditions and record 0065's standing vocabulary — their stage words are the round and outcome nouns' values, not new nouns. Compatibility: the vocabulary page and the checks are additive; the string retirements change words, never shapes or routes (the `/threads` rail keeps its path and heading).

## What would change our mind

- *A thirteenth noun keeps forcing itself in.* If the retirements cannot express a surface without a new word (the plane's health axis is the candidate), the vocabulary page gains a row by amendment, not by a surface minting one silently.
- *The hygiene class drowns in false hits.* "Ask", "fit" and "door" are common English; if the class cannot be scoped to hit the internal senses without an allow-list over prose, the class narrows to the unambiguous words and the ambiguous ones stay editorial, and this record is amended to say so.

## Rollout

One plan, `docs/plans/2026-09-19-003-feat-twelve-user-nouns-plan.md`, in the same pull request as this record. Six units: the vocabulary and explanation pages with the AGENTS.md and landing links; the acceptance or supersession of records 0031, 0034, 0035 and 0043 plus the spec links at first noun use; the `docs:check` binding; the `hygiene:check` vocabulary class with its baseline; the code cleanup (one `RoundKind` with a findings floor, `UnitSession` renamed to what it is, the misplaced docstring moved); and the retirement of the user strings (the two-thread wording, the parent-run and pipeline-run labels, the Delivery column, the owner-gap badge, the stop-semantics how-to, the dashboard-routes rows for `/threads` and `/plane`, and hiding command and door rows by default). Each unit binds its criteria to test ids or check names in the plan's Verification Contract; every row is `[gap]` until its unit merges.

## Sources

Records 0031, 0034, 0035, 0043, 0051, 0055, 0060, 0064, 0065; `docs/reference/specs/public-hygiene.md`; the survey above, verified at `dd45f6f9`.
