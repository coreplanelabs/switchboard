---
title: Memory keeps lessons, not status; a deterministic gate on every fact, a repository's newest lessons in every run, and a restated lesson merges instead of multiplying
status: proposed
date: 2026-09-18
pattern: One rule at two sites (a gate on the way in, a sweep over what is already there); upsert by meaning (a restatement bumps the record it restates); a recency window in place of a search for the scope whose lessons are all relevant
---

# Memory keeps lessons, not status; a deterministic gate on every fact, a repository's newest lessons in every run, and a restated lesson merges instead of multiplying

**The ask.** Decide (the maintainer, before the plan is written and before the release that follows the current deploy): memory's write path gains a deterministic gate that rejects one-moment status and a `restates` merge; its read path injects a repository's newest lessons outright; the extractor moves to Sonnet 5; one sweep retires the status rows already stored. Written for an engineer who knows the dispatcher and has read [memory.md](../reference/specs/memory.md) once. Success is judged on:

1. A lesson a coding run learns in a repository (a failing check and its cause, a command that must run first, a convention) is in the system prompt of every later run in that repository for as long as it is among the repository's newest lessons, whether or not the later run's brief mentions it.
2. No fact whose text is the state of one pull request at one moment (a number, a sha, a test count, a verdict) is ever written again, and the ones already written are gone from every read. Summaries, which are episodic by design, are out of this criterion (boundaries).
3. A lesson learned twice is one record that got stronger, not two records.
4. Each of these is visible in a counter a person can read after a day without opening the store.

## TL;DR

Memory has been on since its production config landed eleven days before this record and holds about 2,450 records; the twenty facts it has about the license check are pull-request status lines that were never once retrieved, because every block's eight slots go to the newest status. The bet: memory becomes a ledger of lessons. A deterministic gate rejects any fact carrying a pull-request number, a sha, a test count or a verdict before it is stored; a fact that restates a shown record bumps that record instead of inserting; and every run in a repository gets that repository's newest lessons outright, 24 records or 3,000 tokens. It costs one Sonnet 5 call per run, 3,000 tokens of context per run, one Worker route and one sweep. The gate, window and sweep are decided; the merge is the model's judgement, bounded to bump-only; the window's size is a guess a counter settles in a week. Doing nothing leaves memory a per-run cost that changes no run.

## Today at `56e78a45`

The delta from what a reader of memory.md expects; the full survey is in the [appendix](#appendix-the-survey).

1. **Retrieval is a recency pick, not a relevance search.** The keyword term is `hits ÷ brief tokens`; a brief has hundreds of tokens, so it is a few hundredths for every candidate and recency decides within a scope. The block is, in effect, each scope's eight newest rows that share a long word with the brief, merged by how many words they share.
2. **The store is status.** Measured through `memory list` the day this record was written: the repository scope has minted 858 ids, the organization scope 1,599; a filter on the license check returns 31 repository records, 20 of them facts, nearly all `useCount 0`, of the shape "pull request N was pushed at sha S with all T tests passing". A dry run of the gate below over the 39 newest repository facts rejects 22 and keeps 17; over the 39 newest organization facts, 14 and 25. The prompt forbids exactly this; the extractor is Haiku 4.5 and does not comply (issue 1770: an invented test count stored as an organization fact).
3. **Eviction removes the lessons first.** A scope holds 500 active records; over the cap the store evicts by `lastUsedAt ?? createdAt`, oldest first, so a lesson nobody retrieved goes before a status line a recent read bumped.
4. **Dedup is by normalized text only.** An exact restatement bumps; any paraphrase inserts. The extractor can `supersede` a shown record but cannot say "same as". Twenty license facts are the result.
5. **`list` already exists on every store**: newest first, at most 50, no usage bump; but no kind filter (summaries share the repository scope) and it throws where `retrieve` degrades. The window needs a `kind` parameter and a catching read, not a new route. `MemoryStore.write` returns nothing, though the Worker already answers counts.

## The shape

Memory stays what record [0017](0017-memory-off-by-default.md) made it: distilled, advisory, budgeted, off by default. What changes is what a record may be and how a repository's records reach a run. A **lesson** is a fact that will be true in a future unrelated run: a cause and its remedy, a command that must run first, a convention. **Status** is the state of one pull request at one moment. The **gate** is a pure function over a candidate's text that rejects status by its markers; it runs in the bot before every write and, once, as a **sweep** over the rows already stored. A **restatement** is a candidate the extractor tags with the id of a shown record that says the same thing; the store bumps that record's use count, recency and confidence and inserts nothing. The **repository window** is the newest 24 lessons of the run's repository scope, injected outright ahead of the keyword-matched records of the other scopes, under one raised budget.

The closest known shape is a changelog that a release script refuses to append a build number to, read from the top; the one difference is that an entry that says what an earlier entry said merges into the earlier entry instead of being appended.

```mermaid
sequenceDiagram
    participant R as coding run
    participant D as dispatcher
    participant S as memory store
    participant X as extractor (Sonnet)
    D->>S: list(repo scope, 24)  and  retrieve(org, user, channel; brief)
    S-->>D: newest repo lessons + keyword hits
    D->>R: system prompt: window then hits, ≤ 3,000 tokens
    R-->>D: reply (verify failed on the license check; recovered)
    D->>X: transcript + shown records with ids
    X-->>D: facts, each with confidence, audience, restates? supersedes?
    D->>D: gate: reject status by marker; count offered/rejected/restated/inserted
    D->>S: write(candidates)
    S->>S: restates → bump that record; else dedup/supersede/insert
```

## One trace

A ship child in this repository is briefed to add a registry drift check; the brief never mentions licenses. Two days earlier another child learned that the resident's dependency store dropped nested `node_modules`, so `npm ls` attributed a hoisted package's LGPL subtree to production and the license check failed on a tree that passes on a clean install.

1. The dispatch reads memory: `list` on the repository scope returns its 24 newest lessons, among them "the license check fails on a resident tree whose nested node_modules were dropped; a clean npm ci of the same commit passes; the allowlist is never the fix". The other scopes are read by keyword as today.
2. The block renders the window first, then the keyword hits, and stops at 3,000 tokens; it opens with the same advisory line and fence as today.
3. Verify fails on the license check. The remedy is in the system prompt; the child reinstalls instead of editing the allowlist or reporting a known failure. Acting on the line is the model's choice; the design guarantees only that the line is there.
4. After the reply the extractor (one Sonnet call over the 24,000-character transcript tail) returns four facts and a summary: "pull request N pushed at sha S with 10,5xx tests passing"; "the license check false positive comes from nested node_modules loss; npm ci fixes it" with `restates: <the id from step 1>`; "check:deps-drift names any tree or lockfile drift" (audience `repo`); "this user prefers the fix over the allowlist" (audience `user`).
5. The gate rejects the first (a pull-request number, a sha and a test count each suffice) and passes the other three.
6. The store bumps the restated record (`useCount`, `lastUsedAt`, `confidence` to the higher of the two) and inserts nothing for it; the drift-check fact inserts in the repository scope; the user fact routes as today.
7. The `[memory]` line for the run reads `offered 4, rejected 1, restated 1, inserted 2, summary 1`.

The property: a lesson reached a run whose brief did not name it, and the store grew by three rows (two facts and the summary) where today it grows by five.

## The difficulty map

1. **The gate's rule** ([The gate](#the-gate)): the status-versus-lesson boundary drawn by markers; wrong either way shows in the counters but costs a week to notice.
2. **The window's size** ([The repository window](#the-repository-window)): 24 is a guess against how fast a scope grows once only lessons are written.
3. **Over-merging by `restates`** ([Restatement](#restatement), most work): a new fact lost as a bump; bounded to bump-only over shown ids; touches the engine, both stores, the Worker's validator and the prompt.
4. **The sweep and the deploy order** ([The sweep](#the-sweep)): a route, a command, and two generations that must tolerate each other.

## The gate

The constraint: the prompt has said "PR-specific state must never become a fact" since the write path shipped, and the store holds hundreds of such facts. A rule the model is asked to follow is a rule the model follows on average; a store is filled by the tail. The gate therefore lives in code, in the shared engine (`src/core/memory/engine.ts`, the module the Worker's Durable Object bundles by relative import), as one pure function `rejectionMarkers(text): string[]` whose non-empty answer rejects a fact. It runs in `parseReflection` on every fact candidate before authorization and write.

Two classes of marker, each a named pattern with a fixture that trips it and a fixture that does not. **Status markers** name one moment:

- a pull-request or issue reference **as the fact's subject**: the fact opens with "PR", "pull request", "issue" or "unit" and a number, or a `#`-number, `pull/` or `issues/` reference sits in the same clause as a delivery predicate. A reference elsewhere ("the staged rebuild (issue 170) must budget the swap") is a citation inside a lesson and does not reject on its own; the dry run's rejected side held about five such lessons among 22, and that is the marker's cost the subject-position rule removes;
- a commit: a run of 7 to 40 hexadecimal characters containing at least one digit and at least one letter, bounded by non-alphanumerics (the letter keeps a timestamp or an id out, the digit keeps "defaced" and "accede" out; a sha that is all digits or all letters is missed and accepted as the cost);
- a test or check count as an outcome: a number within three words of "tests", "test cases", "checks" or "rows" and "pass", "passing", "green" or "fail" in the same clause, in either order;
- a delivery predicate: "was/is pushed", "was/is merged", "was/is approved", "all green", "LGTM", "ready for review", "awaits CI", "is complete";
- a run or branch identifier: "run" followed by eight hexadecimal characters, "branch" followed by a path-like name.

**Change-description markers** name what one change did, which the spec and the diff already say and which rots as the code moves: "now" followed within one word by "documents", "preserves", "displays", "includes", "carries", "has", "is", "supports", "shows", "maps", "controls", "applies" or "uses"; "was/were/has been/have been" followed by "implemented", "added", "updated", "fixed", "documented", "removed", "renamed", "introduced" or "extended"; a plan-unit reference ("unit" followed by a unit id); "spec row" or "spec rows".

The dry run in the today section is the calibration: 22 of the 39 newest repository facts are rejected, of which about five are lessons that cite an issue or say what a spec row now documents (the subject-position rule above and the extractor's rewritten instruction are the answer to those). Of the 17 survivors, a reading found lessons about configuration ranges, idle endings and the dependency store, and some descriptions of behaviour phrased in the present tense that no marker can tell from a lesson. Those are left to the extractor's rewritten instruction, which asks for each fact in the shape *what fails or surprises, why, and what to do*, and to the `rejected` counter, which says whether the shape is honoured. A second, semantic gate is not proposed: it would be another model judging the first.

**The counters.** The `[memory]` line per reflection gains `offered` and `rejected` (bot-side, from the gate) and `restated`, `inserted`, `deduped` (from the store's answer). That needs the seam to speak: `MemoryStore.write` returns `WriteCounts` instead of nothing, the Worker's existing answer is read by the client instead of discarded, and the in-process store counts the same way.

Invariants, stated so a test can check them: a fact carrying any marker is never written to any scope by a bot of this generation; the gate is pure and total (never throws; empty text is rejected upstream as today); the same exported function decides the sweep; a summary candidate is never gated (a summary is episodic by definition and never enters the window). Failure modes: a lesson that legitimately names a sha (a pinned action version) or says "once it was merged" is rejected, which loses one lesson and costs nothing else; a status line phrased without any marker passes and occupies one slot of the window until 24 newer lessons push it out; an older bot generation still live after the sweep writes status until it drains, which is why the sweep runs after the cutover and is idempotent.

The alternative it beat: raise `MIN_REFLECTION_CONFIDENCE`. The invented test count in issue 1770 came with confidence above the floor; confidence measures the model's certainty, not durability.

## The repository window

The constraint: a lesson is relevant to a run in its repository whether or not the brief mentions it, and the brief is the only query the read path has. The keyword search cannot express "everything recent about this repository", and today it approximates it badly (today, item 1).

The design: `memoryContextBlock` reads the repository scope with `list(scopeKey, WINDOW, { kind: "fact" })`, newest first, with `WINDOW` from `memory.repoWindow` (default 24), and renders those records first; the organization, user and channel scopes are read with `retrieve` and the brief as today and follow. `list` gains the optional `kind` filter on every store (the Worker adds one `AND kind = ?`), and the block builder reads it **advisorily**: a Worker failure on the window read is caught, logged as one `[memory]` warning, and costs the run its window, never the run, matching what `retrieve` does today and what memory.md item 19 promises. The human `memory list` keeps throwing, because there a person asked. The budget is one pool as today with `memory.limit` raised to 32 and `memory.maxTokens` to 3,000 by default; the first record is always kept as today. At 324 characters per repository fact today, 24 records render in about 2,000 tokens; the rest of the budget is the keyword hits.

**When a repository record's `lastUsedAt` moves**, stated once. Never on the window read: `list` bumps nothing, and the window's copy in the extractor's shown set is the same `list` read, so display never reinforces. On a restatement. And on the reflection-time `retrieve` per scope, which keeps the request and answer as its query and bumps the eight records per scope it returns: a record whose words the run's own transcript matched. The shown set is the window plus those hits, which is why `memory.limit` becomes 32 (24 window plus 8 hits). So a record is reinforced when a later run restates it or when a later run's transcript matched it, never because it was shown. Eviction is unchanged in code (LRU by `lastUsedAt ?? createdAt`) and in effect becomes age plus reinforcement, which is the retention rule we want: a lesson restated last week outlives a lesson stated once a month ago.

Invariants: the window contains only `fact` records of the run's own repository scope; a run with no bound repository has no window and reads as today; a failed window read yields no window and no error; the block never exceeds `maxTokens` at the rendered size; with memory off the model input is byte-identical to today (record 0017 stands). Failure modes: a scope that gains more than 24 lessons a day pushes a two-day-old lesson out of the window, and the `inserted` counter for the scope says so; the remedy is a larger window or the deferred keyword expansion, never a looser gate.

The alternative it beat: keep keyword retrieval and raise `limit` to 32. On a long brief that is the window with extra steps (today, item 1), and `retrieve` bumps `lastUsedAt` on everything it returns, which turns eviction into a coin toss. Reading by `list` says what it does.

Why the organization scope keeps its keyword read: it is shared across every repository the installation serves, so its newest 24 are mostly another repository's lessons; a per-repository window is the right unit, and the organization scope's turn comes with the deferred expansion if the counters ask for it.

## Restatement

The constraint: text dedup never fires on a paraphrase, and a lesson recurs precisely because it keeps being relearned in new words. The extractor already sees the existing records with their ids and already emits `supersedes`; the cheapest meaning-level merge is to let it say "same as".

The design: the reflection output gains `restates: <shown id>`, validated and routed exactly as `supersedes` is: an id not in the shown set is dropped and the fact is kept as a plain candidate; the candidate follows its target's scope whatever its `audience` tag says; and when the authorization policy narrows the write, the `restates` is dropped the way a `supersedes` is, so a merge never crosses a visibility line. `planWrite` gains a third action, `restate`, taken before dedup: the target must be an active record of the same scope; the store bumps `useCount` and `lastUsedAt`, sets `confidence` to the higher of the target's and the candidate's, inserts nothing and keeps the target's text. Both stores implement it; the Worker's `parseCandidate` learns the field. Because the shown set is the window plus the reflection-time hits, the record a lesson restates is in front of the extractor whenever it was in front of the run, and often when it was not (the transcript names the failure even when the brief did not).

Invariants: a restatement never deletes, never rewrites text, never moves a record between scopes, and never targets a record the extractor was not shown; a `restates` naming a `superseded`, `forgotten`, `swept` or `evicted` row falls through to insert. Failure modes: the extractor tags a new fact as a restatement of a near one, and the new fact is lost as a bump; the cost is one missing lesson and a strengthened neighbour, visible as a `restated` count that outruns `inserted` by an implausible margin, which is the review trigger in the open questions. A lesson that has left the window and that the transcript's words do not hit is relearned as a fresh row; the window then carries the newer copy and the older one ages out, which is a duplicate for a while, not a loss. A Worker older than the bot ignores the field (its validator copies known fields), so a restatement degrades to today's insert-or-dedup.

The alternative it beat: an embeddings index beside the Durable Object with a similarity threshold for dedup. It needs a backfill, a second ranking and a threshold nobody can defend before the store holds lessons; `restates` needs one field.

## The sweep

The rows already stored do not go away by themselves: with the gate in place the window is repopulated at the rate lessons are learned, and until then the newest 24 are yesterday's status lines. The Worker gains `POST /sweep {scopeKey, dryRun?}`: inside one transaction it runs the shared gate over every active `fact` row of the scope and flips the ones with markers to `swept`, a fifth status that every reader treats exactly as `forgotten` (row and provenance kept; invisible to list, retrieve, dedup and the window) and that is distinguishable from a human `forget` so the receipt can be audited; it answers the count, and with `dryRun` the count and the ids only. The in-process store implements the same over its map. The registry gains `memory sweep --scope <org|repo|channel|all> [--repo owner/name] [--dry-run]` under `memory:write`, the same gate as `forget`, one inline run with a receipt. It is idempotent and safe to run any day; it is run once per scope by the maintainer after the release's cutover, when no older bot generation is live, and its counts are the receipt for success criterion 2.

Deploy order: the Worker and the bot ship in one release as every release does; a bot generation older than the Worker sends no `restates` and asks for no sweep, and a Worker older than the bot ignores `restates` and answers the sweep with a 404 the command reports as a `⚠️` line, never a throw.

## Why not X

**Why not just move the extractor to Sonnet 5?** Do that too; `memory.model` is one line in the production config. A stronger model lowers the `rejected` count; the gate makes the written count zero; and no model change touches the rows already stored.

**Why not fix the scorer instead (a stop list, a keyword term not divided by the brief's length, no bump on `retrieve`) so relevance actually ranks?** Any search is a search with the brief as its query, and a brief about a drift check shares no useful word with a lesson about the license check however the terms are weighted; a better scorer changes which status lines win, not that status lines win. The bump removal is taken anyway for the window (it reads by `list`); the scorer stays for the scopes where a search is the right shape.

**Why not wipe the store and start over behind the gate?** A wipe loses the 17 in 39 survivors, and the user scopes with them, to save one route; the sweep is the wipe of exactly the rows the gate would have refused, with the ids kept for the audit that success criterion 2 needs. Both are one route; only one is reversible.

**Why not filter at read time and skip the sweep?** A read-time filter leaves the status rows counting against the 500-record cap and being evicted in place of lessons, costs every read, and hides the rows from the person's `memory list` without saying so. The rows have to go, once.

**Why not semantic retrieval (embeddings) so the license lesson matches "deps store"?** Retrieval is not where the miss is today: the tokenizer has no stop list, the prefilter takes the 24 longest words, and the ranking is recency, so the block already is "the newest rows about this repository", and they are status. Embeddings would rank status semantically well. Once the store holds lessons, keyword expansion of the brief is the cheaper next step; it is deferred with the counters as its trigger.

**Why not a `remember` tool the agent calls when it learns something?** The coding harnesses are external binaries with their own tool tables; the in-process general agent could take one, and it is the agent that produced the invented count in issue 1770. An agent deciding what is memorable is the extractor with less context. Reflection over the whole transcript stays the one writer.

## Boundaries

Not in this record: a lookup at the moment a tool call fails (it pays off only for lessons older than the window; it is the retention-era follow-up); keyword expansion of the brief or any embeddings index (a second record, if the `inserted` counter shows the window is too small); any change to the authorization routing of writes, to `memory list` and `memory forget`, or to the organization, user and channel reads; the settings surface for the new fields (configuration only). The window is per repository scope; a run with no bound repository gets none.

Summaries are unchanged: ungated, keeping their keyword slots in the other scopes, status-shaped by nature. Since the session log became the thread's transcript store (record 0035), whether summaries earn their rows at all is a separate record.

Compatibility: the wire format gains one optional candidate field, one `list` parameter and one route; records and ids are unchanged; statuses gain `swept`; an installation with memory off runs today's bytes.

## Cost

Reflecting runs (coding and general; review and ship never reflect) ran at 39 in the 13.5 hours before this record was written, about 70 a day. Each reflection is one extractor call of about 7,000 input tokens (the 24,000-character transcript tail plus the shown records) and at most five facts and a summary out; the Sonnet move is that call at Sonnet's price, read off the costs page after the first day. Each run's block grows from at most 800 to at most 3,000 system-prompt tokens, on roughly 100 runs a day.

## What would change our mind

- **Lessons per repository per day are far above 24.** Measured by the `inserted` counter for the repository scope over the first week. Above about 40, the window is too small and the expansion record moves up.
- **The gate rejects more than one in ten of Sonnet's facts.** The prompt asks for the wrong shape or the markers are too broad; read the rejected texts (the log carries counts; the sweep's dry run lists ids) and adjust the markers before widening the window.
- **`restated` exceeds `inserted` in the repository scope.** Over-merging; inspect twenty restatements against their targets.
- Reversibility: every piece is behind existing configuration; `repoWindow: 0` restores today's read, the gate is a flag in the same section, `swept` rows are rows. Nothing is deleted.

## Rollout

One release. Unit one: the gate, its fixtures from the real texts (paraphrased), the counters on the `[memory]` line. Unit two: the `kind` filter on `list`, the window and the raised budget. Unit three: `restates` in the engine, both stores, the Worker validator and the prompt. Unit four: the sweep route, the `swept` status and the command. Then the configuration change in the infrastructure repository (`memory.model` to Sonnet 5, `repoWindow`, `limit`, `maxTokens`), the release, and one `memory sweep` per scope with its counts posted as the receipt. The execution plan holds the unit contents.

## Open questions

| Question | Owner | Resolved by | Needed before |
|---|---|---|---|
| Is 24 records / 3,000 tokens the right window? | the maintainer | the `inserted` counter for this repository over one week after the release | the expansion record, not this one |
| Does `restates` over-merge? | the maintainer | twenty sampled restatements against their targets, one week after the release | the same |
| What does the Sonnet extractor cost per day? | the maintainer | the costs page one day after the release | nothing; recorded for the retention decision |

## Validation criteria

| Criterion | Proof |
|---|---|
| A fact carrying a status or change-description marker is rejected; a lesson naming a command, file, cause or remedy is not; the paraphrased real fixtures reproduce the dry run's split | `[gap]` unit one: `src/core/memory/engine.test.ts::rejectionMarkers` |
| `MemoryStore.write` answers `WriteCounts` on every store and the `[memory]` line carries offered, rejected, restated, inserted, deduped, summary | `[gap]` unit one: `src/core/memory/stores.test.ts`, `workerStore.test.ts`, `reflection.test.ts` |
| `list` with `kind: "fact"` returns only facts on every store; the block leads with the repository's newest facts, at most `repoWindow`, then keyword hits, within `maxTokens`; no window without a bound repository; a failed window read logs one warning and yields no window; byte-identical with memory off | `[gap]` unit two: `src/core/memory/stores.test.ts`, `deploy/cloudflare-memory/worker.test.ts`, `src/core/memory/memory.test.ts`, `src/core/dispatcher.test.ts` |
| A `restates` naming a shown active record bumps it and inserts nothing; an unknown, foreign or non-active id inserts; text and scope never change; it follows its target's scope and is dropped on a narrowed write; the shown set is the window plus the reflection-time hits | `[gap]` unit three: `engine.test.ts::planWrite restate`, `stores.test.ts`, `worker.test.ts`, `reflection.test.ts` |
| `/sweep` and `memory sweep` flip exactly the marker-carrying active facts to `swept`, answer the count, list ids under `dryRun`, are idempotent, and refuse outside `memory:write`; `swept` rows are invisible everywhere `forgotten` rows are | `[gap]` unit four: `worker.test.ts`, `stores.test.ts`, `src/core/commands/memory.test.ts` |
| After the release, `memory list` on this repository's scope shows no status rows and the sweep's counts are posted | human-gated, the maintainer, on the receipts issue |

## Sources

- [memory.md](../reference/specs/memory.md) items 5, 6, 8, 10, 13, 14, 22, 27 (the rows this design changes); [0017](0017-memory-off-by-default.md).
- The filed case of an invented number stored as a fact: issue 1770.
- The license check's history in this repository: the nested `node_modules` cause and fix, pull request 1835.

## Appendix: the survey

| Claim | Proof at `56e78a45` |
|---|---|
| Tokenizer is `[a-z0-9]+`, no stop list | `src/core/memory/scorer.ts` `tokenize` |
| Keyword term is hits ÷ query tokens; α 0.7, β 0.3, τ one week | `src/core/memory/scorer.ts` `keywordMatch`, `RECENCY_TAU_MS`; memory.md item 5 |
| Worker prefilter: BM25 over the 24 longest tokens, `max(50, 5 × limit)` candidates | `deploy/cloudflare-memory/worker.ts` `MAX_MATCH_TOKENS`, `FTS_CANDIDATES_FLOOR`, `FTS_CANDIDATES_PER_LIMIT` |
| `retrieve` bumps `lastUsedAt`/`useCount`; `list` does not, newest first, cap 50 | memory.md items 5, 24; `worker.ts` `MAX_LIMIT` |
| Defaults: 8 records, 800 tokens, cap 500 active per scope, eviction LRU by `lastUsedAt ?? createdAt` | `scorer.ts` `DEFAULT_MEMORY_LIMIT`, `DEFAULT_MEMORY_TOKENS`; `engine.ts` `DEFAULT_SCOPE_CAP`, `planEviction` |
| Dedup by normalized text; `supersedes` validated against shown ids; confidence floor 0.6; 5 facts + 1 summary | `engine.ts` `planWrite`, `normalizeText`; `reflection.ts` `parseReflection`, `MIN_REFLECTION_CONFIDENCE`, `MAX_REFLECTION_FACTS` |
| Extractor model is `memory.model`, else the run's model; production sets Haiku 4.5 | `src/core/memory/index.ts` `scheduleReflection`; the production config's `memory.model` |
| Shown records: `retrieve` per scope with request + answer as the query | `reflection.ts` `reflect` (`EXISTING_LIMIT`) |
| Review and ship runs never reflect; coding children are ordinary dispatches as the requester and do | `reflection.ts` `NO_REFLECT_AGENTS`; `src/channels/adminCoordinator.ts` (the spawn builds an `IncomingMessage` and calls `dispatch`) |
| Worker's candidate validator copies known fields and ignores unknown ones | `worker.ts` `parseCandidate` |
| Statuses: `active`, `superseded`, `forgotten`, `evicted` | `src/core/memory/types.ts` |
| Store contents (858 repo ids, 1,599 org ids, 31 license records, 20 facts, `useCount 0`) | `memory list` over the dashboard's command route, the day this record was written |
| Memory on in production since the deployment profile landed | the infrastructure repository's production config history |
