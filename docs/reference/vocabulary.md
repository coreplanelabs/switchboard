# Vocabulary

The product speaks twelve nouns, each with exactly one meaning. Every surface a user reads — a card, a reply, a web label, a command summary, a how-to — prints these nouns, their values, plain English and proper names, and nothing else. Every other word the system uses is internal: allowed in specs, decision records and code, never printed. The rule and its argument: [record 0066](../decisions/0066-a-user-meets-twelve-nouns-and-no-others-the-vocabulary-is-a-reference-page-bound-to-the-code-and-the-consistency-check-fails-a-user-surface-that-prints-an-internal-word.md); how the nouns fit together: [What holds what](../explanation/what-holds-what.md).

## The twelve nouns

Every row carries the same five facts: the meaning, what it holds, what it belongs to, the carrying code type, and the surfaces that print it.

<!-- generated:vocabulary-nouns · npm run docs:gen — rendered from src/docs/vocabulary.ts, do not edit by hand -->

| Noun | Meaning | Holds | Belongs to | Carried by | Printed by |
| --- | --- | --- | --- | --- | --- |
| <a id="thread"></a>**thread** | Where you talk — a Slack thread or a web thread. One live model run at a time; a pipeline's own hosted run occupies no thread. | runs | a channel | the thread key on `RunSummary` (`src/core/runRegistry/projections.ts`) | cards and replies, the web rail's Threads list, the runs index |
| <a id="run"></a>**run** | One piece of work: one request, one agent, one outcome. A pipeline is a run. | its events and outcome | one thread | `RunRecord` (`src/core/runRecord.ts`) | the run page, the runs index, cards |
| <a id="agent"></a>**agent** | The kind of run: general, coding, review, ship, research, explore, conductor. | — | a run | `Preset` (`src/core/budgets.ts`) | cards, the runs index, command summaries |
| <a id="pipeline"></a>**pipeline** | Ship's job on a plan: asked in one thread, ending with a report there. | units | the asking thread | `CoordinatorInstance` (`src/core/coordinator/contract.ts`) | the asking thread's card, the run page's unit lineage, the unit page |
| <a id="unit"></a>**unit** | One deliverable of a pipeline: its own branch, its own pull request, its own thread. | rounds | a pipeline | `CoordinatorUnit` (`src/core/coordinator/contract.ts`) | the unit page, the `runs unit` summary, the plane table |
| <a id="round"></a>**round** | One pass over a unit — coding, review, findings or merge; the first three spawn child runs, the merge round waits on the guards. | a child run (except merge) | a unit | `RoundKind` (`src/core/budgets.ts`) | the unit page's runs-by-round list, cards |
| <a id="budget"></a>**budget** | The minutes a run, a unit or a pipeline may spend; renewable. | minutes and renewals | a run, a unit or a pipeline | `Grant` and the lease arithmetic (`src/core/budgets.ts`) | cards, the run page |
| <a id="follow-up"></a>**follow-up** | A reply in a thread, during or after a run. | — | a thread | `FollowUpInput` (`src/core/threadAdmission.ts`) | cards, replies |
| <a id="verdict"></a>**verdict** | The review's findings joined with the checks at the reviewed head. | findings and check results | a review round | `ReviewVerdict` (`src/core/reviewVerdict.ts`) | review replies, the unit page |
| <a id="outcome"></a>**outcome** | How a run or a unit stands once it is not working — ended or idle; merged, merge-ready, idle, failed, stopped are its values. | its value | a run or a unit | `UnitEnding` (`src/core/ship/coordinator.ts`), the status on `RunSummary` | cards, the runs index, the plane table |
| <a id="card"></a>**card** | The message Switchboard keeps updating in a thread for a run. | the run's live status | a thread | `StatusUpdate`/`StatusHandle` on `ChannelIO` (`src/core/types.ts`) | the thread itself — Slack and web |
| <a id="pull-request"></a>**pull request** | GitHub's own noun, unchanged. | — | a unit | the pull request fields on `CoordinatorUnit`; `PlanePullRequestRow` (`src/core/plane/table.ts`) | the unit page, the plane table, the delivery report |

<!-- /generated:vocabulary-nouns -->

The person is the <a id="requester"></a>**requester** — one word on every surface, whoever they are to GitHub or to the config.

## Nouns versus values

The twelve are the domain nouns. A noun's **values** — an outcome's `merged`, `merge-ready`, `idle`, `aborted`, `failed`, `stopped`, `held`, `round cap reached`, `out of budget`; an agent's preset names; a model's name — and **plain English** (issue, minutes, branch, model, effort) are not nouns and need no row. A surface prints a value or plain English freely; what it may not print is an internal word: the outcome and round-outcome tokens the code keeps (`merge_ready`, `round_cap`, `checks_failed`, …) are translated at every surface by `ENDING_WORDS`/`ROUND_OUTCOME_WORDS` (`src/core/pipelineStanding.ts`), the binding [agent-ship.md](specs/agent-ship.md) item 12a proves.

## By rule, not only by enumeration

- A **user surface** is anything the product prints to a person who has not opened the repository: a card or reply string the bot code prints, a command or tool summary the registry publishes, a web label, and the non-spec docs trees (reference, how-to, tutorials, explanation). Specs, decision records, plans, code and code comments are not user surfaces.
- An **internal word** is a word whose product sense exists only behind a seam — it names a mechanism (a ledger claim, a scheduler's counter, a host's key) rather than a thing the requester asked for or received. A word with a common English sense is internal only in its product sense, which is why the mechanical check is scoped to the unambiguous ones and the rest stay editorial.

## The collapse

Every synonym a surface prints today reads as its noun:

- **conversation** and **chat** become **thread** (the web rail keeps its "Threads" heading — the rail is the thread noun's own surface).
- **instance**, **hosted parent**, **plan runner** and — on the unit lineage only — **parent run** and **pipeline run** all read as **pipeline**. A conductor's child keeps "parent run": its parent is a run, not a pipeline.
- **attempt** is an ordinal, not a synonym: a surface says "the second pipeline for this plan", never `attempt 2`.
- **task** and a plan's U-ids read as **unit**.
- the **fix** round is renamed **findings** end to end (the rename lands with a later unit of the same plan); a round is named by its pass: coding, review, findings, merge.
- **lease**, **segment**, **renewal** and **grant** read as **budget** — a budget is "renewed", never "segment 2".
- **steer**, **nudge**, **wake** and **thread event** read as **follow-up**.
- **ending** reads as **outcome**.
- the model-and-effort "card" or "tier" is just **model** and **effort** — "card" belongs to the thread message alone.
- **owner**, **actor**, **maintainer** and operator-as-a-person read as **requester**.
- **turn** reads as **run** (the home page's turn is a run's rendering, and says so).
- the **owner-gap** badge reads as **merge-ready, unmerged**.
- the Delivery page's "Unit" column reads as **issue**, which is what it counts.
- **conductor** stays a preset name.

## The internal words

Allowed in specs, decision records and code — never on a user surface, and policed mechanically by `vocabulary:check` (arriving with a later unit of the same plan): **session, lease** (the ledger's claim)**, segment, instance, attempt, hosted** (as "hosted run/parent/pipeline" only)**, host key, coordinator, runner** (as "plan runner" only)**, admission, intake, handoff, wind-down, tier**. One rule for **coordinator**: an internal word whose user referent is **pipeline** — it is never printed. The remaining boundary words (door, carve, floor, fit, ask, fold, wake, operator in the model-turn sense) are editorial: the review holds them, not the check. The specs keep their precision; the boundary translates.
