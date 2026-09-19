---
title: Every finished run writes one metrics point to Workers Analytics Engine, and a metrics page reads the trend from it
status: proposed
date: 2026-09-18
pattern: Observer at the one commit point (the sink hangs off the write every final record already makes); a flat fact row with closed vocabularies (a star-schema fact, never text); a seam for the sink and one for the reader so a second store can join later
---

# Every finished run writes one metrics point to Workers Analytics Engine, and a metrics page reads the trend from it

**The ask.** Decide (the maintainer, before the plan is seeded): the state Worker gains an optional Workers Analytics Engine binding and writes one flat **metrics point** per run at the moment the run's final record commits; the bot gains a reader over the Analytics Engine SQL API and a `/metrics` page, a JSON twin and a `metrics trend` command in the costs page's shape. Written for an engineer who knows the run history ([run-history.md](../reference/specs/run-history.md)) and the costs dash ([costs.md](../reference/specs/costs.md)) and has not looked at Analytics Engine. Success is judged on:

1. The maintainer can see, for any window up to 90 days, runs per day by status, failure rate per day, and p50/p95 wall-clock per agent, on a page and as JSON, and can run the same numbers as SQL from a terminal with the account token.
2. Every run whose final record lands contributes exactly one point, whichever generation lands it and whether it finished, was stopped, or was closed `interrupted` by a reclaim; a run whose record is rewritten after finish contributes no second one. A run whose last record is a start tombstone contributes none, exactly as the run store shows it: unfinished, no finish recorded.
3. A failure of the metrics store never fails, delays or changes a run's finish, its reply or its record.
4. Nothing free-text leaves the run store for the metrics store: every string column is an id or a value from a closed vocabulary the code already types.

## TL;DR

The run store holds everything a trend needs, per run, and cannot answer a trend: its retention is sized by event bytes (median record 101 KiB, 2 GiB budget) and by a run cap of 5,000 whose configurable ceiling is 20,000, so at the measured 20 to 36 runs an hour it keeps six to ten days and can never be configured to keep ninety; it is also a single-threaded Durable Object that admits live runs, so nobody should run `GROUP BY` over it. The bet is to hang a second, purpose-shaped store off the one commit every final record already makes: the bot computes a flat point (twenty numbers, sixteen strings: fifteen closed-vocabulary values and the run id) beside each record it writes, and the Durable Object writes that point to Workers Analytics Engine after the commit, only when the row turned final. The cost is one optional binding, one pure function each side of the wire, a reader that reuses the costs token (the same Cloudflare permission), and one page; the retention is three months and the store is queryable with SQL from anywhere. Decided: the sink, the point's shape, the emission rule and the reader's queries; open: whether a point should also carry the plan and unit a ship child ran under, which the first month of use decides. Doing nothing means the trend stays what it is today: two hundred rows at a time through the runs listing, hand-summed.

## Today at `853e0cd8`

Five facts the design depends on, each different from what a reader of the costs dash would expect. The full survey is the appendix.

- **Every final record passes one function.** `RunHistoryDO.upsertInTransaction` (`deploy/cloudflare-memory/worker.ts`) is the body of both `put` and `finish`; the ledger's `finish` checks its fence, writes the record and deletes the live rows in one `transactionSync`. A reader would expect two write paths; there is one.
- **A run writes its record two to four times, and some runs never write a final one.** A start tombstone (`provisional: true`, `finishedAt === startedAt`) lands at admission; the drain deadline may upgrade it, still `provisional`, with `finishedAt` set to the drain clock; the final record replaces it; a review run's abridged diff re-`put`s the whole final record afterwards (`appendReviewArtifact`, run-history item 44). A run the ledger does not track (a detached run, a process killed outright) leaves the tombstone as its last record, and the store renders it as unfinished (run-history item 27). `upsertInTransaction` already reads the existing row and derives `rewritten` and `unchanged` from `event_count`, `finished_at`, `bytes`; the existing row's `summary_json` is the record minus its events, `provisional` included.
- **The dollars are not on the record.** `RunRecord.usage` holds tokens per model; `RunsService` prices them on read (`costOf` → `runCostOf`, costs item 4c), and answers `null` rather than `$0` when a model has no price (`llmUsdOfUsage` returns `usd` and `unpricedTokens`). The Durable Object has no prices.
- **A retry after `finish` lands as a `put`.** Once `finish` has deleted the live row, a retried `finish` is refused `unknown-run`, and the bot's `land` falls back to a plain `put` of the same record (`src/core/runLedger/writeThrough.ts`), which the object stores as `unchanged`.
- **The costs dash already holds the credential the reader needs.** `costs.cloudflareTokenEnv` names an API token with `Account Analytics:Read` (`src/core/costs.ts`, `CloudflareGraphqlUsageSource`); the Analytics Engine SQL API needs exactly that permission on the same account.

Measured on the live store, three pages of two hundred finished runs each over two consecutive days: 583 distinct runs, 20 to 36 finishing per hour (480 to 860 a day), median record 101 KiB (mean 126 KiB), 57 of 583 `failed` and 37 of those `ship`, and none of the 583 rows provisional (the listing propagates the flag; a tombstone left behind would show). The store's defaults are `retentionDays 30, maxRuns 5000, maxBytes 2 GiB` (`DEFAULT_RETENTION_POLICY`, `src/core/runRecord.ts`, which also holds a `sessionLogMaxBytes`); `RETENTION_BOUNDS` caps `maxRuns` at 20,000; production sets none of them.

## The shape

The point is a **fact row** in the star-schema sense: one row per finished run, its dimensions as short strings from vocabularies the code already types (`RunStatus`, `FrictionCategory`, `MachineClass`, `Identity`, the preset name), its measures as numbers (the seven terms of the window partition, tokens by kind, turns, dollars). The bot builds it from the record and its price table with one pure function, `pointOf(record, prices)`, for every record that is not provisional, and sends it beside the record on `/runs/put` and `/runs/finish`. The Durable Object commits the record as today, then, outside the transaction, hands the point to a **`RunMetricsSink`** (`write(point): void`; the Analytics Engine implementation calls `writeDataPoint`, the null implementation does nothing) if and only if the row it just wrote is final and the row it replaced was absent or provisional. `writeDataPoint` is synchronous and returns nothing; nothing waits on it and nothing reads a result beyond one warning line if it throws. The reader is the mirror: a `MetricsSource` seam whose production implementation posts SQL to the Analytics Engine SQL API with the costs token, a pure report builder over the rows it returns, and the costs page's three surfaces (page, JSON twin, registry command) over the report.

The closest known shape is an application emitting one StatsD or OpenTelemetry metric event per request into a time-series store that a Grafana panel queries. The one difference is that the event is not emitted by the process that ran the request but by the store's commit of the request's durable record, so a run that finished in a generation that died still produces its point when the reclaim writes its record, and a record written twice produces it once.

## One trace

A `ship` child run on a repository, two hundred and eleven seconds of wall-clock, is mid-push when a deploy lands. Real names; the numbers are from the sample.

1. At admission the bot writes the start tombstone through `/runs/put`: `status: interrupted, provisional: true, finishedAt === startedAt`. `pointOf` returns nothing for a provisional record, so the body carries no point. The Durable Object stores the row; the emission rule sees no existing row and a provisional new one: no point.
2. SIGTERM. The old generation marks the run `handoff` (run-history item 33). Nothing is written to the metrics store.
3. The new generation boots, reclaims the run (item 31), resumes it on the same transcript, and the agent finishes. `deliverAnswer` takes `finishing`, replies, and the ledger's `finish` is called with the final record: `status: completed`, `receivedAt`, `sealedAt`, `replyOk: true`, `usage.turns: 14`, `diagnosis.shape.windowMs: 211_000`.
4. The bot's `WorkerRunLedger.finish` computes `pointOf(record, prices)`: index `ship`; blobs `["1", "ship", "ship", "anthropic/claude-fable-5", "completed", "", "slow_tool", "slack:C…", "owner/repo", "repo-resident", "chosen", "ok", "child", "slack:U…", "write", "<run id>"]`; doubles `[211000, 9400, 102000, 88000, 6100, 5500, 0, 0, 14, 812000, 19000, 640000, 71000, 0.93, 61, 23, 84, 0, 90, 1789775195983]`. It posts `{storeKey, runId, gen, record, point}`.
5. `RunHistoryDO.finish` opens one `transactionSync`: the fence check, the upsert, the deletion of the live rows. `upsertInTransaction` read the existing row's `summary_json` and saw `provisional: true`; the new row has no `provisional`: **the row turned final**. The transaction commits.
6. After the commit, the object calls `sink.write(point)`. The binding is present in production; `writeDataPoint` returns. Had it thrown, one `console.warn` line with the run id and the error's class would be the whole consequence; the finish already committed and the caller's answer is unchanged.
7. The finish answers `{ok: true, stored: true}` and sends `run-finished-<id>` to the coordinator as today. The reply reached the thread in step 3; nothing in steps 4 to 6 was on that path.
8. The old generation's zombie retries the same `finish` after a network blip. The live row is gone, so the object refuses it `unknown-run`; the bot's `land` falls back to a plain `put` of the identical record. `unchanged` is true and the existing row is final: no second point.
9. The pipeline's review child finishes the same way: its own final record, its own point. Afterwards `appendReviewArtifact` re-`put`s that review child's record with the abridged diff. The body carries a point (the record is final); the Durable Object sees the existing row final: **no second point**. `rewritten: true` as today.
10. A month later the maintainer opens `/metrics?days=30&agent=ship`. The reader posts three queries; the row from step 6 is one of the `sum(_sample_interval)` counted under `completed` on its day and one weight in `quantileExactWeighted(0.5)(double1, _sample_interval)`.

The trace proves the emission property: one point per run id, written by whichever generation commits the final record, and never by a rewrite or a retry of a record that was already final.

## The difficulty map

1. **Exactly one point per run** ([The emission rule](#the-emission-rule)): the tombstone, the drain upgrade, the reclaim's `interrupted` via `put`, the retry that lands as a `put`, the review-artifact rewrite, a late provisional record over a final row, and a store that throws.
2. **Right under sampling and inside the window** ([The reader](#the-reader)): every count, sum and quantile weighted by `_sample_interval`; the day bucket is the write time, not `finishedAt`.
3. **The point's vocabulary** ([The point](#the-point)): closed sets only, positional columns named once for writer and reader, dollars that never read `$0` for an unpriced model.
4. **The page and the command** (most work; [The reader](#the-reader)): the seam, the report, the three surfaces, the capability, the screenshots.

## The emission rule

A run's record is written between two and four times by different callers in different generations, and the metrics store is append-only with no key: a second `writeDataPoint` for the same run is a second run in every query, and there is no delete. The decision is therefore made where the previous state of the row is known, which is only inside the Durable Object, and made from the row alone, never from who is calling.

The rule, as a pure function both the object and its tests import: `pointTurnsFinal(existing, stored)` is true when `stored.provisional` is absent and `existing` is undefined or carries `provisional: true`. The `finishedAt > startedAt` test the object uses elsewhere is deliberately not part of it: `assembleRunRecord` gives a record with no start snapshot `startedAt = finishedAt`, and such a record is final and counted. `upsertInTransaction` gains `summary_json` in the `SELECT` it already makes for the existing row, parses only its `provisional` field, and returns `turnedFinal` beside `stored`, `retained` and `rewritten`. `put` and `finish` call `sink.write(point)` after their transaction when `turnedFinal && stored && point !== undefined`, and only then. The write is inside a try; the catch is one `console.warn` naming the run id and the error's class, never its message body. `RUN_METRICS` is optional in `Env` like `SHIP_COORDINATOR`: a Worker deployed without the binding gets the null sink and commits every record exactly as today.

The rule needs one guard the store lacks today: **a provisional record never overwrites a final row.** The old generation's drain upgrade can land after the new generation's reclaim finished the run; today the row regresses to provisional, and under the rule the next final rewrite (the review artifact) would count the run again. `upsertInTransaction` answers such a `put` the way it answers an identical retry: the row is kept as it is (`stored: true`, since the run is in the store), nothing is rewritten (`rewritten: false`), nothing is written; the in-process stand-down in `runHistoryWriter.ts` already refuses this within one process, and the object now refuses it across generations. This is a run-history change in its own right (item 27 gains the sentence) and is the one place this record touches the store's own behaviour.

Invariants a test can check:

- A record with `provisional: true` never produces a write, whatever the body carries, and never replaces a final row.
- A final record over an absent row writes once; over a provisional row writes once; over a final row writes nothing, whether or not the events changed.
- A retry of a final record, as `finish` or as the `put` it falls back to, writes nothing.
- A point with `stored: false` (the record fell outside retention in its own write) is not written: a run the store does not keep is not counted, so the store and the trend agree on what a run is.
- A throwing sink leaves `put`'s and `finish`'s answers byte-identical to a build with the null sink, and the record readable.

Failure modes: the binding is absent (nothing written, the page says the source is off); the write throws or the platform drops it (one point missing, one warning; the trend is at-most-once and says so in its footer); a run whose last record is a tombstone (a detached run, a process killed before any close) writes nothing and is absent from the trend, as the store shows it unfinished (none of the 583 sampled rows; the weekly receipt counts the provisional rows in the listing so the gap stays measured); a restart is a new run id whose old row closes `interrupted`, so one request that restarted counts as two runs, one `interrupted` and one with its outcome; a record arrives final with no tombstone before it (the plain `put` of a detached run, a reclaim's `interrupted`): existing absent, written once.

The alternative this beat is emitting from the bot at `assembleRunRecord`, where the record is built once. The bot's shim Worker could hold the binding and the container could reach it through a route, but the record is built by whichever generation finishes or reclaims the run, and only the store knows whether an earlier generation already counted it; the rule has to live where the previous row is.

## The point

A point is twenty doubles and sixteen blobs plus one index, well inside the platform's caps (twenty of each, one index of 96 bytes, 16 KB of blobs). The **index** is the agent name, because the platform samples per index value and equitably, so a burst of `door` runs cannot starve the `ship` series, and because every query filters or groups by agent first. The columns are positional in the store (`blob1..blob16`, `double1..double20`); one table, `POINT_COLUMNS` in `src/core/runMetrics.ts`, names each position once as a `const` tuple, the writer builds its arrays by mapping that tuple over the record, and the reader's SQL is generated from the same tuple (`col("usd")` → `double14`), so a position renamed, added or removed is a type error on whichever side did not follow.

Blobs, in order: schema version (`"1"`), agent, preset (`profile.preset`), model, status, failure kind (`failure.kind` or empty), dominant friction category (the `FrictionCategory` with the largest `durationMs`, empty when none has a count), channel id, repository, machine class (`MachineClass`: `none | blank | repo-cold | repo-resident`), route class (`routed` when `route` is present, else `chosen`), reply (`ok`, `failed`, `none`), lineage (`child` when `parentRunId` is present, else `root`), requester id, identity (`Identity`: `none | read | write`), and the run id, so a terminal query can name the run page a point came from and a suspected double count can be found (`sum(_sample_interval) GROUP BY blob16 HAVING … > 1`) and repaired by hand. Absent optional fields are the empty string. Every value is an id the run store already prints on its index page or a member of a typed union; `activity`, `label`, the verdict headline and every event body are excluded by construction, since `pointOf` never reads them.

Doubles, in order: wall (`finishedAt − (receivedAt ?? startedAt)`), the seven partition terms from `diagnosis.shape` (getting ready, thinking, tools, finishing up, overhead, not recorded, not loaded; zero when the shape is absent), turns, input tokens, output tokens, cache-read tokens, cache-write tokens, dollars (`llmUsdOfUsage(usage, prices).usd`), step count, tool calls, event count, unpriced tokens (`llmUsdOfUsage(usage, prices).unpricedTokens`), the profile's minutes (zero when absent), and `finishedAt` as epoch milliseconds (exact in a float64).

Dollars are priced at write, not at read as the costs dash does. A trend is a record of what a run cost when it ran; a later price-table change re-prices the costs dash's history and leaves the trend alone, and the two differ by design after such a change. A model without a price contributes its tokens to `unpriced tokens` and nothing to `dollars`, and the page shows unpriced tokens beside the dollars whenever they are non-zero, so a trend never reads `$0` for a run the costs dash would refuse to price.

## The reader

The platform's contract is that writes are sampled per index when they arrive too fast and reads are sampled when a query is heavy, and every row carries `_sample_interval`, the count of unsampled points it stands for. The platform publishes no threshold. A query that counts rows or averages a column is wrong the day sampling starts, and that day is invisible, so every query is written weighted from the first release: a count is `sum(_sample_interval)`, a sum is `sum(doubleN * _sample_interval)`, an average is the ratio of the two, a quantile is `quantileExactWeighted(q)(doubleN, _sample_interval)`. At today's volume (480 to 860 points a day against a paid-plan allotment of 10 million points and 1 million reads a month, not yet billed) no row is sampled and the weighted forms reduce to the plain ones; the tests pin the weighted text so the reduction is never relied on, and the first month's receipts include `max(_sample_interval)` over the window so the first sampled row is seen.

`MetricsSource` is the seam: `query(sql) → rows`. `AnalyticsEngineSqlSource` posts to `accounts/<id>/analytics_engine/sql` with the costs token and `FORMAT JSON`; `InMemoryMetricsSource` holds points and evaluates the three report queries over them in TypeScript, so the report builder is tested against the same shapes the real source returns. The report is `buildMetricsReport(rows, range)` over three queries, all with `timestamp >= toDateTime(<since>)` and an optional `index1 = <agent>`: per UTC day and status, the weighted count; per agent over the range, the weighted count, the weighted `failed` count, p50 and p95 of wall, the weighted sums of dollars, unpriced tokens and turns; per UTC day and agent, p50 of wall. The tiles are runs, failure rate, p50 wall, p95 wall, dollars (with unpriced tokens beside them when non-zero) and the range; the charts are runs per day stacked by status, failure rate per day, and p50 wall per day by agent; the table is by agent. The range is `?days` from 1 to 90 (the store's retention), default 30. The day bucket is the point's write time, which differs from `finishedAt` for a record written by a reclaim; the footer states it and `double20` carries the exact finish for anyone querying by hand.

Surfaces follow the costs dash exactly:

- `/metrics` and `/metrics.json`, gated in the same fail-closed Access branch as `/costs*`, rendered by `web/src/pages/MetricsPage.vue` in the costs page's tokens, with a `metrics` nav section shown when the capability is on.
- `metrics.trend` in the command registry (action `metrics:read`, effect read, `enabledWhen: caps.metrics`), which the registry derives into `metrics trend --days 7 --agent ship` in chat and on the CLI, `GET /api/metrics.trend`, and the `metrics_trend` MCP tool, all answering the twin's JSON.
- The `metrics` capability is on when a `metrics:` block names a dataset and the costs block's account id and token are present. Off is `unavailable` with the costs dash's words; a source error is `unavailable` with the error's class.

There is no snapshot and no refresh loop: a read is three queries against a query engine, not a rate-limited billing read. The SQL API's latency for a 90-day aggregate is unmeasured and is the first receipt the plan collects; a snapshot behind the same seam is the fallback if it exceeds a page load.

Invariants: every query text the reader emits contains `_sample_interval` or is a pure `GROUP BY` key; the in-memory source and the SQL text agree on every fixture; a report over an empty window is a zero-filled range, never an error; the page renders no value that is not in the twin.

## Why not X

**Why not write a point on every record write and dedupe by run id at read?** The run id is in the point, but read-side dedupe cannot carry the weights: a sampled row stands for `_sample_interval` runs and a `count(DISTINCT blob16)` counts it as one; every sum and quantile would first need one row per id, which the store's SQL dialect (no joins, no window functions) cannot express under a weight; and a duplicate is a permanent lie in every ad-hoc terminal query, which success criterion 1 is about. The write-side rule costs one `summary_json` read the object already pays for; the run id stays for detection and repair.

**Why not a slim `metrics` table in the same Durable Object, 35 columns per run, and `GROUP BY` over it?** It answers the retention argument (45,000 rows are a few megabytes) and nothing else: every aggregate is a hand-written route on the object that also admits live runs (run-history item 33 keeps the live tables there on purpose), its retention is our own sweep, and nothing outside the bot can ask it SQL, which success criterion 1 requires. Analytics Engine is a query engine with retention, sampling and an HTTP SQL door for the price of one binding.

**Why not raise `maxRuns` and `GROUP BY` over the run store, the way the costs cube reads `/runs/usage`?** `maxRuns` is bounded at 20,000, under two months at today's rate; 2 GiB of events holds about 16,600 records, a month; ninety days would keep 5 to 10 GiB of event JSON for the sake of 35 numbers per run. The costs cube gets away with reading the store because it reads 31 days, one row per run, on its snapshot interval.

**Why not Pipelines into R2 and R2 SQL, the shape the company's other product runs?** That is the right second sink: unlimited retention, joinable with the other product's lake, the same admin MCP. It is also a stream, a sink, a schema file, a bucket and a catalog to provision for the same 35 columns, and no page comes with it. It joins as a second `RunMetricsSink` when 90 days stops being enough; Workers Logs, which hold every span line for days, are searchable and not summable and are not a candidate.

**Why not emit from the bot and skip the Durable Object?** Only the object knows whether the run was already counted ([The emission rule](#the-emission-rule)).

## Boundaries

Not a lake: no ad-hoc SQL surface in the product, no joins with pull requests or with the other product's events, no export. Retention is the platform's three months; a longer trend is the second sink. Not a reconciliation: the trend is at-most-once, omits runs that never wrote a final record, and the page says both; a count that differs from the run store's by a few is expected. Not a per-user surface: the requester id is a blob so the maintainer can slice by it in SQL, but the page shows no by-user tab; the costs dash owns who spent what. The one change to existing behaviour is the guard above: a provisional record no longer overwrites a final row. Everything else is additive: a build without the binding and without the `metrics:` block is byte-identical to today on every route, command and page. Self-hosted installations without Cloudflare have no metrics store and see the capability off, like the costs dash.

## What would change our mind

- **Sampling arrives sooner than expected.** Cheap test: `max(_sample_interval)` over the last day, posted with the first month's receipts; a value above 1 is the signal, and the weighted queries already handle it.
- **The SQL API is slow enough to feel.** Cheap test: the first receipt times the three queries; above a page load, the reader gains the costs dash's snapshot behind the same seam.
- **The dominant-friction blob is not what a reader wants to slice by.** Cheap test: the first month's questions; if they ask for the finding kinds rather than the category, the schema version becomes `"2"` and the reader reads both.
- **Ninety days is not enough.** The lake sink, behind `RunMetricsSink`; no point is lost in the meantime because the trend was never the record.
- Reversibility: remove the binding and the `metrics:` block and the system is today's plus the provisional-over-final guard, with three months of points expiring on their own.

## Rollout

One record, one plan with four units in this repository and one configuration change in the infrastructure repository. Unit 1 lands the point, the emission rule, the guard and the spec, with no binding anywhere: from that release on every final record the bot writes carries its point and the object drops it on the null sink. Unit 2 lands the deploy side: the deployment profile's `metrics.dataset` renders the binding on the state Worker (`{{#if metrics}}`, the way `artifacts.bucket` renders the bot's bucket) and its name into `/healthz` `features` as `runMetrics:<dataset>`; the bot's boot probe, which already reads `features` for `runs`, gains one warning when its own `metrics.dataset` and the Worker's differ, and refuses nothing. Unit 3 lands the reader, the capability and the command; unit 4 lands the page. Only then does the profile name the dataset, so the binding never exists before every bot generation sends points: a row that turns final under a bot build without the point is impossible in this order (the state Worker deploys ahead of the bot already, run-history's ordering rule). The bot's config gains the `metrics:` block, and the receipt is the first `sum(_sample_interval)` over the dataset from a terminal, the page showing the same number, and the three query timings.

## Open questions

| Question | Owner | Resolves it | Needed before |
|---|---|---|---|
| Should a point carry the plan and unit a ship child ran under, so a trend can be sliced per plan? | the maintainer | the first month's questions asked of the page; a `"2"` schema adds two blobs | never blocks; a later unit |
| Does the range need hourly buckets for the last 48 hours? | the maintainer | whether the per-day chart hides a within-day incident during the first month | never blocks; a later unit |

## Validation criteria

Each is `[gap]` until its unit binds it to a test id in the new spec, `docs/reference/specs/run-metrics.md`.

| Criterion | Proof |
|---|---|
| `pointOf` returns nothing for a provisional record and builds the documented arrays from a final one, a zero-wall record included; no blob is ever free text (a fixture with a hostile `activity`, `label` and verdict headline yields no blob containing them); an unpriced model lands in `unpriced tokens`, not in `dollars` | `[gap]` unit 1, `src/core/runMetrics.test.ts` |
| `pointTurnsFinal` over the six existing/new combinations (absent, provisional, final × provisional, final) | `[gap]` unit 1, `src/core/runMetrics.test.ts` |
| Inside workerd: a tombstone then a finish writes one point; a finish then a review-artifact `put` writes one; a finish then the same record as a `put` writes one; a `put` of an `interrupted` record over no row writes one; a provisional `put` over a final row writes nothing and leaves the row final; `stored: false` writes none; a throwing sink leaves the answers byte-identical and one warning | `[gap]` unit 1, `deploy/cloudflare-memory/runs.test.ts` |
| A Worker without the binding answers `put` and `finish` exactly as before | `[gap]` unit 1, `deploy/cloudflare-memory/runs.test.ts` |
| Every query text carries `_sample_interval` weighting; the in-memory source and the SQL text agree on the fixtures; an empty window is a zero-filled range | `[gap]` unit 3, `src/core/metrics.test.ts` |
| `metrics.trend` on every surface answers the twin's JSON; off is `unavailable`; the capability axis snapshots hide it when off | `[gap]` unit 3, `src/core/commands/metrics.test.ts`, the conformance suite |
| The page renders the report's tiles, three charts and the table, and the JSON twin is the seed's report | `[gap]` unit 4, `web/src/pages/metrics.test.ts`, `screenshots:check` |
| Live, human-gated: the release's state Worker reports `runMetrics:<dataset>` on `/healthz`; a `sum(_sample_interval)` over the dataset from a terminal equals the page's runs tile for the same window within the at-most-once tolerance; the three query timings and `max(_sample_interval)` are posted | `[gap]` the release; receipt on the receipts issue |

## Sources

- [run-history.md](../reference/specs/run-history.md) items 27, 31, 33, 39, 44 and 56; [costs.md](../reference/specs/costs.md) items 4c, 6, 10 and 10b; [tracing.md](../reference/specs/tracing.md) items 3 and 5; [capabilities.md](../reference/specs/capabilities.md).
- [Record 0020](0020-spans-one-measurement-primitive.md), spans as the one measurement primitive: the partition terms the point carries.
- Workers Analytics Engine documentation: limits (twenty blobs, twenty doubles, one index of 96 bytes, 16 KB of blobs, three months), the SQL API (`Account Analytics: Read`, `FORMAT JSON`), sampling (`_sample_interval`, `quantileExactWeighted`), pricing (10 million points and 1 million reads a month included on the paid plan; billing not yet started).

## Appendix: the survey

| Fact | Proof at `853e0cd8` |
|---|---|
| One upsert body for `put` and `finish`; `finish` checks the fence, upserts and deletes live rows in one transaction | `deploy/cloudflare-memory/worker.ts`, `RunHistoryDO.finish`, `RunHistoryDO.put`, `upsertInTransaction` |
| The existing row is read as `event_count, finished_at, bytes`; `rewritten` and `unchanged` derive from it | `upsertInTransaction`, the `SELECT … FROM runs WHERE run_id = ?` |
| `summary_json` holds the record minus its events, `provisional` included | `upsertInTransaction`, `const { events, ...summary } = stored` |
| Tombstones are `provisional: true` with `finishedAt === startedAt`; the drain upgrade keeps `provisional` and sets `finishedAt` to the drain clock | `src/core/runRecord.ts` (`provisional`), `src/core/dispatch/record.ts` (`writeTombstone`, the upgrade), `src/index.ts` (the drain) |
| Reclaim and restart closes are final `interrupted` records; a restart is a new run id | `src/core/dispatch/record.ts` (`interruptedRunRecord`, `reclaimedRunRecord`), `src/core/dispatch/admission.ts` (`closeRestartRow`), `src/core/boot.ts` |
| A retried `finish` after the live row is gone is `unknown-run` and lands as a `put` | `src/core/runLedger/decisions.ts`, `src/core/runLedger/writeThrough.ts` (`land`) |
| The in-process writer refuses a provisional record over a final one; the object does not | `src/core/runHistoryWriter.ts`; `upsertInTransaction` |
| `assembleRunRecord` gives a record with no start snapshot `startedAt = finishedAt` | `src/core/dispatch/record.ts`, `assembleRunRecord` |
| The review artifact re-`put`s a whole final record | `src/core/reviewAbridge.ts`, `appendReviewArtifact`; run-history item 44 |
| `RunRecord` has `usage` and no dollars; `RunsService` prices on read and refuses `$0` for an unpriced model | `src/core/runRecord.ts`; `src/core/runsService.ts` (`costOf`); `src/core/modelPricing.ts` (`runCostOf`, `llmUsdOfUsage`, `unpricedTokens`) |
| The window partition's seven terms, the friction categories, `MachineClass` and `Identity` are typed unions | `src/core/trace/partition.ts` (`Partition`); `src/core/runFriction.ts` (`FrictionCategory`, `RunShape`); `src/core/agents/registry.ts`; `src/core/config/profile.ts` |
| The costs token is `Account Analytics:Read` on the configured account | `src/core/costs.ts`, `cloudflareTokenEnv` and `CloudflareGraphqlUsageSource` |
| Optional cross-script binding precedent | `deploy/cloudflare-memory/worker.ts`, `Env.SHIP_COORDINATOR?` |
| Conditional binding render precedent | `deploy/cloudflare/wrangler.template.jsonc`, `{{#if artifacts}}`; `src/deploy/profile.ts`, `artifacts` |
| `/healthz` `features` on the state Worker; the bot's boot probe reads it for `runs` | `deploy/cloudflare-memory/worker.ts`, the `/healthz` handler; `src/index.ts`, the run-history probe |
| Retention defaults, the `maxRuns` bound of 20,000, and the cap order (age, then `maxRuns`, then `maxBytes`) | `src/core/runRecord.ts`, `DEFAULT_RETENTION_POLICY`, `RETENTION_BOUNDS`, `applyRetention`; run-history items 4 and 5 |
| Production sets no retention field | the infrastructure repository's bot config, `runHistory:` block (store and worker only) |
| Capability gating and the costs page's surfaces | `src/core/capabilities.ts` (`costs`); `src/channels/costsView.ts`; `src/core/commands/costs.ts`; `web/src/lib/navSections.ts` |
| Measured rate, sizes and failure mix | three `runs.list` pages of 200 over the live store, two consecutive days: 583 runs, 20 to 36 an hour, median 101 KiB, mean 126 KiB, 57 failed |
