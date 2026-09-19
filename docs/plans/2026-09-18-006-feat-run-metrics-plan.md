---
title: Every finished run writes one metrics point, and a metrics page reads the trend - Plan
type: feat
date: 2026-09-18
status: proposed
artifact_contract: ce-unified-plan/v1
artifact_readiness: implementation-ready
product_contract_source: ce-plan-bootstrap
execution: code
extends: ../decisions/0063-every-finished-run-writes-one-metrics-point-and-a-metrics-page-reads-the-trend.md
---

# Every finished run writes one metrics point, and a metrics page reads the trend - Plan

## Goal Capsule

- **Objective**: Build [record 0063](../decisions/0063-every-finished-run-writes-one-metrics-point-and-a-metrics-page-reads-the-trend.md): the bot computes one flat metrics point beside every final record it writes; the state Worker writes that point to a Workers Analytics Engine dataset after the record's commit, only when the row turned final; the bot reads the dataset over the Analytics Engine SQL API with the costs token and serves a `/metrics` page, its JSON twin and a `metrics trend` command on every surface.
- **Authority**: record 0063 (proposed; this plan is the artifact its acceptance is judged on) over [run-history.md](../reference/specs/run-history.md) (the record contract and the store, whose rows change in U1), [costs.md](../reference/specs/costs.md) (the token and the price table the reader and the point reuse; unchanged) and [capabilities.md](../reference/specs/capabilities.md) (the new `metrics` capability, U3). A new living spec, `docs/reference/specs/run-metrics.md`, is created in U1 and grown by every later unit.
- **Execution profile**: four code units in this repository, each one pull request through the review loop, tests first in every unit; then one configuration change in the infrastructure repository and the release. U1 is the base of U2 (the binding it renders) and U3 (the point columns it names); U3 is the base of U4. U2 and U3 are independent of each other.
- **Stop conditions**: a unit that finds a writer of finished records outside `RunHistoryDO.upsertInTransaction`, a second place that prices a run's tokens, or a fourth surface the registry does not derive by itself hands back a deviation before changing it. Nothing here adds a Durable Object, a table, a credential or a snapshot; the state Worker gains one optional binding, one body field on two routes and one guard in its upsert, the bot one config block, one capability, one command and one page.
- **Tail ownership**: each pull request merges through the review loop; the profile and configuration change and the release are the maintainer's; the live receipt (a terminal `sum(_sample_interval)` equal to the page's runs tile) is posted by the maintainer on the receipts issue.

---

## Product Contract

### Summary

The run store holds every number a trend needs and keeps about ten days of them at the current rate, behind a listing that pages two hundred rows at a time. Record 0063 hangs a second store off the one commit every final record already makes: one point per run into Workers Analytics Engine, three months of retention, SQL from anywhere, and a page in the costs dash's shape over it.

### Problem Frame

Measured over the live store: 583 finished runs across two consecutive days, 20 to 36 an hour, median record 101 KiB, 57 failed; the store's `maxRuns 5000` therefore holds about ten days and its `maxBytes 2 GiB` about a month, and no SQL reaches it from outside the bot. The costs cube aggregates on read from 31 days of usage rows once a day into a snapshot; a trend of runtimes and failure rates has no home. Record 0063 holds the measurements, the alternatives and the argument.

### Requirements

**The point (record 0063, "The point")**

- R1. `src/core/runMetrics.ts` exports `RunMetricsPoint` (`{ indexes: [string]; blobs: string[]; doubles: number[] }`, the platform's own shape), `POINT_COLUMNS` (one ordered table naming every blob and double position once, typed so a position added without a name fails to compile), `pointOf(record, prices)` and `isRunMetricsPoint`. `pointOf` returns `undefined` for a record with `provisional: true` (and for nothing else: a final record whose `startedAt` equals its `finishedAt` is counted with a zero wall), and otherwise the sixteen blobs and twenty doubles the record names, in `POINT_COLUMNS` order: schema `"1"`, agent, preset, model, status, failure kind, dominant friction category (the `FrictionCategory` with the largest `durationMs`; empty when no category has a count), channel id, repository, machine class (`MachineClass`), route class (`routed` | `chosen`), reply (`ok` | `failed` | `none`), lineage (`root` | `child`), requester id, identity (`Identity`: `none` | `read` | `write`), run id (`record.id`); an absent optional field is the empty string. Doubles: wall (`finishedAt − (receivedAt ?? startedAt)`), the seven partition terms (zero when `diagnosis.shape` is absent), turns, the four token counts, dollars (`llmUsdOfUsage(usage, prices).usd`; zero without turns), step count, tool calls, event count, unpriced tokens (`llmUsdOfUsage(usage, prices).unpricedTokens`), the profile's minutes (zero when absent), `finishedAt`. The index is the agent name (`unknown` for a record naming none). Every blob is at most 96 bytes; `pointOf` never reads `activity`, `label`, `events`, `verdict`, `handoff`, `dispositions` or `diagnosis.verdict`.
- R2. `isRunMetricsPoint` accepts exactly one index, sixteen strings each at most 96 bytes, twenty finite numbers, and nothing else; the state Worker validates an incoming point with it and answers 400 by name (`point must be a RunMetricsPoint`) for anything else.

**The wire (record 0063, "The shape")**

- R3. `POST /runs/put` and `POST /runs/finish` accept an optional `point` beside `record` (`parseRunPut`); a body without one is exactly today's. `WorkerRunStore.put` and `WorkerRunLedger.finish` compute `pointOf(record, prices)` and send it when defined; `buildRunStore` and `buildRunLedger` take `prices?: ModelPriceTable` in their deps and `src/index.ts` passes the same table `RunsService` prices with. `InMemoryRunStore` and `FileRunStore` are unchanged.

**The emission rule (record 0063, "The emission rule")**

- R4. `pointTurnsFinal(existing, stored)` in `src/core/runMetrics.ts` (node-free, imported by the Worker and its tests) is true when `stored.provisional` is absent and `existing` is `undefined` or carries `provisional: true`; there is no `finishedAt > startedAt` term. `upsertInTransaction` reads `summary_json` beside the three columns it already reads for the existing row, parses only its `provisional` field, and returns `turnedFinal` beside `stored`, `retained` and `rewritten`.
- R4b. **A provisional record never overwrites a final row** (record 0063, "The emission rule"; run-history item 27 gains the sentence): `upsertInTransaction` answers a `put` of a `provisional: true` record over an existing non-provisional row as `{ ok, stored: true, retained, rewritten: false, turnedFinal: false }` and writes nothing, to the row, its events or the sessions table. The in-process stand-down in `src/core/runHistoryWriter.ts` is unchanged.
- R5. `RunMetricsSink` (`deploy/cloudflare-memory/runMetricsSink.ts`: `write(point: RunMetricsPoint): void`) has two implementations, `AnalyticsEngineSink(env.RUN_METRICS)` and `NullSink`; `Env.RUN_METRICS?: AnalyticsEngineDataset` is optional and selects between them at construction. `put` and `finish` call `sink.write(point)` after their transaction when `turnedFinal && stored` and a point was sent, inside a try whose catch is one `console.warn` line carrying the run id and the error's constructor name. The answers of `put` and `finish` are byte-identical with and without the binding, with and without a point, and when the write throws.
- R6. The state Worker's `/healthz` `features` gains `runMetrics:<dataset>` when the binding is present, from a `RUN_METRICS_DATASET` var rendered beside the binding.

**The deploy (record 0063, "The point", the dataset name)**

- R7. The deployment profile gains an optional `metrics: { dataset }` (`src/deploy/profile.ts`; the platform's dataset-name rules); `deploy/cloudflare-memory/wrangler.template.jsonc` renders `analytics_engine_datasets: [{ binding: "RUN_METRICS", dataset: "{{metrics.dataset}}" }]` and the `RUN_METRICS_DATASET` var under `{{#if metrics}}`; `deploy plan` names the binding in the state Worker's step when the profile names a dataset. No resource is created ahead of the deploy: the platform creates a dataset on first write.
- R8. The bot's boot probe of the state Worker reads `features` and logs one `[runs]` warning when its configured `metrics.dataset` and the Worker's `runMetrics:<dataset>` differ or when only one side names one; neither side refuses to start.

**The reader (record 0063, "The reader")**

- R9. `metrics: { dataset, days? }` is a config block (`parseMetricsConfig`, validated in `validateConfig`: `dataset` matches the platform's name rule, `days` in 1..90, default 30); the `metrics` capability is on when the block names a dataset and the `costs` block's account id and token env are present in the environment. Three installation snapshots (`minimal`, `local-full`, `cloud-full`) carry the capability's value.
- R10. `MetricsSource` is `query(sql: string) → Promise<MetricsRow[]>`. `AnalyticsEngineSqlSource({ accountId, token, fetchImpl? })` posts the query text to `https://api.cloudflare.com/client/v4/accounts/<accountId>/analytics_engine/sql` with the bearer and `FORMAT JSON` appended, and parses `data`; a non-2xx is a `MetricsSourceError` carrying the status and never the token. `InMemoryMetricsSource(points)` evaluates the three report queries over held points. `NullMetricsSource` is the off state.
- R11. `metricsQueries({ sinceMs, untilMs, agent? }, dataset)` returns three SQL texts, each over `<dataset>` with `timestamp >= toDateTime(<since>) AND timestamp < toDateTime(<until>)` and, when given, `index1 = '<agent>'` (the agent escaped; the range and agent are the only interpolations, both validated): `byDayStatus` (day, status, `sum(_sample_interval)`), `byAgent` (agent, `sum(_sample_interval)`, `sumIf(_sample_interval, blob5 = 'failed')`, `quantileExactWeighted(0.5)(double1, _sample_interval)`, `quantileExactWeighted(0.95)(double1, _sample_interval)`, `sum(double14 * _sample_interval)`, `sum(double18 * _sample_interval)`, `sum(double9 * _sample_interval)`), `byDayAgentP50` (day, agent, `quantileExactWeighted(0.5)(double1, _sample_interval)`). Column positions come from `POINT_COLUMNS`; no query counts rows or averages a raw column.
- R12. `buildMetricsReport(rows, range)` is pure: tiles (runs, failed, failure rate, p50 wall, p95 wall, dollars, unpriced tokens, turns), `byDay` zero-filled for every UTC day in range with a count per status, `byAgent` largest first, `p50ByDayAgent`, and `range` with `sinceMs`, `untilMs`, `days`, `agent?`, `bucket: "write time"`, `retentionDays: 90`, `pricing: "at finish"`, `completeness: "at most once"`. An empty result is a zero-filled report, never an error.
- R13. `metrics.trend` is a registry command (action `metrics:read`, effect read, `enabledWhen: caps.metrics`), options `--days 1..90` and `--agent`; derived forms `metrics trend` in chat and on the CLI, `GET /api/metrics.trend`, the `metrics_trend` MCP tool; the JSON is the twin's exactly; the text render is a header (range, agent filter, dataset), the tiles as ` · `-joined bullets, one line per agent row largest first, then the footer sentence (bucket, pricing, completeness). Off is `unavailable` with `METRICS_OFF_MESSAGE`; a source error is `unavailable` with the error's class. A grant for the read follows `costs.by`: a browser session's baseline, a grant for a Slack user or a token, never a chat baseline.

**The page (record 0063, "The reader", surfaces)**

- R14. `GET /metrics` and `/metrics.json` (`?days`, `?agent`) sit in the same fail-closed Access branch as `/costs*`; the handler (`src/channels/metricsView.ts`) serves the shared web shell with the report as the `MetricsSeed` and the twin answers the seed's report; off answers the costs dash's 503 words. The startup log states `GET /metrics (<dataset>)` or the reason it is off.
- R15. `web/src/pages/MetricsPage.vue` renders, in the costs page's tokens and layout: the tiles; a runs-per-day chart stacked by status; a failure-rate-per-day line; a p50-wall-per-day line per agent; the by-agent table; the range pills (7, 30, 90) and an agent filter; a footer carrying the report's `bucket`, `pricing`, `completeness` and `retentionDays` sentences. `navSections.ts` gains `metrics` shown on `c.metrics`; `seedRouting` releases `/metrics`. Screenshots are regenerated (`screenshots:gen`) and the fixture render carries a 30-day fixture.

### Scope Boundaries

- No lake, no ad-hoc SQL surface in the product, no by-user tab, no export, no reconciliation with the run store, no snapshot, no refresh loop, no change to any record field, any retention rule or any existing command.
- A build without the binding and without the `metrics:` block behaves byte-identically to today.

### Deferred to Follow-Up Work

- A `"2"` schema carrying the plan and unit a ship child ran under (record 0063, open question 1).
- Hourly buckets for the last 48 hours (open question 2).
- A second `MetricsSink` into Pipelines and R2 (record 0063, "Why not X").

### Open Questions

None that block a unit; the record's two open questions resolve after the first month of use.

---

## Planning Contract

### Key Technical Decisions

- **The bot computes the point; the object decides whether to write it.** Prices and the typed vocabularies live in `src/core`; only the object knows whether the run was already counted. `pointOf` and `pointTurnsFinal` are two pure functions, one per side, both in `src/core/runMetrics.ts` so the object's tests and the bot's share fixtures.
- **The point travels beside the record, never on it.** `RunRecord` is untouched: dollars priced at finish would otherwise sit beside dollars priced at read (`RunView.cost`, costs item 4c) and lie about which is which.
- **Positional columns named once.** `POINT_COLUMNS` is the single table the writer builds from and the reader's SQL aliases from; a query names `double14`, never a magic number.
- **Weighted from the first release.** Every query is written with `_sample_interval`; the tests pin the text.
- **No snapshot.** Three sub-second queries per read against a query engine; the costs dash snapshots because its sources are slow and rate-limited.
- **Advisory on both sides.** The binding is optional in `Env`; the write is a try with one warning; the dataset-name mismatch is a boot warning; the capability is off without the block. Nothing here can fail a run or a boot.
- **One guard on the store, and only one.** A provisional record over a final row is refused inside `upsertInTransaction`, because a regression there is the one way the emission rule double-counts; every other store behaviour is untouched.

### High-Level Technical Design

Write path: `assembleRunRecord` (unchanged) → `WorkerRunStore.put` / `WorkerRunLedger.finish` compute `pointOf(record, prices)` → `POST /runs/put|finish {…, point?}` → `parseRunPut` validates `point` with `isRunMetricsPoint` → `RunHistoryDO.put|finish` → `upsertInTransaction` reads the existing row's `summary_json.provisional`, upserts, trims, returns `turnedFinal` → after the transaction, `writeDataPoint(point)` when `turnedFinal && stored && point && env.RUN_METRICS`, in a try.

Read path: `/metrics` or `metrics trend` → `MetricsService.report({ days, agent })` → `metricsQueries(range, dataset)` → `MetricsSource.query` × 3 → `buildMetricsReport(rows, range)` → the seed, the twin, the text render.

Files, by unit: U1 `src/core/runMetrics.ts` (+ test), `src/core/runStoreWorker.ts`, `src/core/runLedgerWorker.ts`, `src/core/runStore.ts` (`BuildRunStoreDeps.prices`), `src/index.ts` (pass prices), `deploy/cloudflare-memory/worker.ts` (`Env.RUN_METRICS?`, `parseRunPut`, `upsertInTransaction`, `put`, `finish`, `/healthz`), `deploy/cloudflare-memory/runs.test.ts`, `docs/reference/specs/run-metrics.md` (new), `docs/reference/specs/run-history.md` (items 33, 44 gain the point's sentence), `docs/reference/specs/README.md`, `docs/reference/code-map.md`. U2 `src/deploy/profile.ts`, `deploy/cloudflare-memory/wrangler.template.jsonc`, `src/deploy/wranglerTemplate.ts` (if the conditional needs a new key), the `deploy plan` renderer and its snapshot tests, `src/core/runStoreWorker.ts` (the boot probe's warning), `config/config.example.yaml`, `deploy/profile.example.json`. U3 `src/core/metrics.ts` (config, source, queries, report), `src/core/metricsService.ts`, `src/core/commands/metrics.ts`, `src/core/capabilities.ts` and its snapshots, `src/config.ts`, `src/config/validate.ts`, `src/core/commandCatalogue.ts`, `src/index.ts`, the conformance suite, `docs/reference/specs/capabilities.md`, the generated command tables (`docs:gen`). U4 `src/channels/metricsView.ts`, `src/index.ts` (route + gate + startup line), `web/src/pages/MetricsPage.vue`, `web/src/lib/metrics.ts`, `web/src/lib/navSections.ts`, `web/src/lib/seedRouting.ts`, `web/src/pages/metrics.test.ts`, `screenshots:gen`.

### Assumptions

- `AnalyticsEngineDataset.writeDataPoint` is synchronous and does not throw on a platform-side drop; the try exists for a missing or misconfigured binding.
- The SQL API accepts `FORMAT JSON` and returns `{ data: [...] }`; the in-memory source mirrors that shape.
- The platform stamps `timestamp` at write; a point cannot carry its own time, which is why `finishedAt` rides in `double20` and the footer names the bucket.

---

## Implementation Units

### U1. The point, the wire and the emission rule

- **Goal**: Every final record the bot writes carries a point; the state Worker writes it once per run, after the commit, only when the row turned final, and behaves byte-identically without the binding.
- **Requirements**: R1, R2, R3, R4, R4b, R5, R6 (run-metrics.md, new; run-history.md items 27, 33 and 44).
- **Dependencies**: none.
- **Files**: `src/core/runMetrics.ts` and `src/core/runMetrics.test.ts`; `src/core/runStoreWorker.ts`, `src/core/runLedgerWorker.ts`, `src/core/runStore.ts` and their tests; `src/index.ts`; `deploy/cloudflare-memory/worker.ts`, `deploy/cloudflare-memory/runMetricsSink.ts` and `deploy/cloudflare-memory/runs.test.ts`; `docs/reference/specs/run-metrics.md`, `docs/reference/specs/run-history.md`, `docs/reference/specs/README.md`, `docs/reference/code-map.md`.
- **Approach**:
  1. Tests first: `pointOf` over a final record fixture asserting every position by `POINT_COLUMNS` name; a provisional record yields `undefined` and a final `finishedAt === startedAt` record yields a point with a zero wall; a fixture whose `activity`, `label`, `diagnosis.verdict` and an event body carry a sentinel string yields no blob containing it; an unpriced model's tokens land in `unpriced tokens` and `dollars` counts only the priced ones; `blob16` equals `record.id`; `isRunMetricsPoint` rejects seventeen blobs, a 97-byte blob, a NaN double, a second index. `pointTurnsFinal` over the six combinations.
  2. Inside workerd, with a recording `RunMetricsSink`: tombstone then finish writes one point; finish then a review-artifact `put` writes one; finish then the same record as a `put` (the retry's landing) writes one; a plain `put` of an `interrupted` record over no row writes one; a provisional `put` over a final row writes nothing and leaves the row, its events and the sessions table untouched; `stored: false` writes none; a sink whose `write` throws leaves the JSON answers deep-equal to the recording run and emits one `console.warn`; a Worker constructed without the binding answers exactly as before.
  3. `src/core/runMetrics.ts`: `POINT_COLUMNS`, `pointOf`, `isRunMetricsPoint`, `pointTurnsFinal`; the dominant-friction rule as its own exported function.
  4. The clients: prices through `BuildRunStoreDeps` and `buildRunLedger`'s deps; `src/index.ts` passes the table `RunsService` already receives.
  5. The Worker: `Env.RUN_METRICS?`, the sink and its selection, `parseRunPut`'s `point`, the `summary_json` read, `turnedFinal` and the provisional-over-final guard, the write after the transaction in `put` and `finish`, `features`.
  6. Spec: `run-metrics.md` with a Code/Tests header, items for the point, the rule, the guard, the wire and the off state, and the validation table binding every row above; run-history item 27 gains the guard's sentence and items 33 and 44 one sentence each naming the point; README and code-map rows.
- **Execution note**: the `summary_json` parse reads one field; do not deserialize the whole summary into a `RunRecord` on every upsert.
- **Patterns to follow**: `applyRetention` (one pure function both sides import); `SHIP_COORDINATOR?` (an optional binding with a warning, never a throw); `sendRunFinished`'s placement after the transaction.
- **Test scenarios**:
  - A `ship` child record with `usage.turns 14` and a price table yields `double14` equal to `llmUsdOfUsage` of the same inputs and `blob13 = "child"`.
  - A record with `route` present yields `blob11 = "routed"`; without, `"chosen"`.
  - A diagnosis with `slow_tool { count 3, durationMs 9000 }` and `failed_tool { count 5, durationMs 800 }` yields `blob7 = "slow_tool"`; all zero counts yield `""`.
  - `pointTurnsFinal(undefined, final) === true`; `(provisionalRow, final) === true`; `(finalRow, final) === false`; `(undefined, provisional) === false`; `(provisionalRow, provisional) === false`; `(finalRow, provisional) === false`.
  - A final record over a final row whose events grew (the review artifact) answers `rewritten: true, turnedFinal: false`; a provisional record over a final row answers `rewritten: false, turnedFinal: false` and a following `get` returns the final record unchanged.
- **Verification**: the test files green, red first; `npm run specs:check`; `npm run docs:check`; `npm run verify`.

### U2. The binding in the deploy, and the name held on both sides

- **Goal**: A profile naming `metrics.dataset` deploys the state Worker with the binding and the var; the bot warns at boot when its dataset and the Worker's differ.
- **Requirements**: R7, R8 (run-metrics.md; release-and-deploy.md's profile rows).
- **Dependencies**: U1 (the binding and `features` it reads).
- **Files**: `src/deploy/profile.ts` and its test; `deploy/cloudflare-memory/wrangler.template.jsonc`; `src/deploy/wranglerTemplate.ts` and the render tests; the `deploy plan` snapshot tests; `src/core/runStoreWorker.ts` (the boot probe) and its test; `deploy/profile.example.json`; `config/config.example.yaml` (the `metrics:` block, documented ahead of U3 as a comment); `docs/reference/specs/run-metrics.md`, `docs/reference/specs/release-and-deploy.md`.
- **Approach**:
  1. Tests first: a profile with `metrics.dataset` renders the binding and the var, one without renders neither and the rendered file equals today's byte for byte; `deploy plan` names the binding; the boot probe warns on a mismatch and on a one-sided name, and says nothing when both agree or both are absent.
  2. The profile field and the template conditional, the way `artifacts` renders the bot's bucket.
  3. The probe reads `features` it already fetches and compares.
  4. Spec rows.
- **Patterns to follow**: `{{#if artifacts}}` and `artifacts` in `src/deploy/profile.ts`; the existing boot probe's warning shape.
- **Test scenarios**: as in the approach; a dataset name that breaks the platform's rule is refused by the profile parser by name.
- **Verification**: the test files green, red first; `npm run specs:check`; `npm run verify`.

### U3. The reader, the capability and the command

- **Goal**: `metrics trend` answers the report on every command surface from the dataset over the SQL API, weighted for sampling, off by capability.
- **Requirements**: R9, R10, R11, R12, R13 (run-metrics.md; capabilities.md; command-registry.md's derived surfaces).
- **Dependencies**: U1 (`POINT_COLUMNS`).
- **Files**: `src/core/metrics.ts` and `src/core/metrics.test.ts`; `src/core/metricsService.ts` and its test; `src/core/commands/metrics.ts` and its test; `src/core/capabilities.ts`, its snapshots and `docs/reference/specs/capabilities.md`; `src/config.ts`, `src/config/validate.ts` and `src/config.test.ts`; `src/core/commandCatalogue.ts`; `src/index.ts`; the conformance suite's fixtures; `config/config.example.yaml`; `docs/reference/specs/run-metrics.md`; the generated command tables.
- **Approach**:
  1. Tests first: the three query texts pinned as fixtures (each containing `_sample_interval`; `double1`, `double9`, `double14`, `blob5`, `index1` resolved from `POINT_COLUMNS`); `buildMetricsReport` over rows from the in-memory source equals the report over the same points computed by hand; an empty window is zero-filled; `AnalyticsEngineSqlSource` posts the text with the bearer and `FORMAT JSON` and turns a 403 into a `MetricsSourceError` without the token in its message; the command's off, error and happy answers on chat, CLI, HTTP and MCP through the conformance suite.
  2. `parseMetricsConfig`, the capability, the three sources, `metricsQueries`, `buildMetricsReport`, `createMetricsService` and `NullMetricsService`.
  3. The command and its render; the catalogue and `src/index.ts` wiring; `docs:gen`.
- **Execution note**: the agent filter is the only user string in a query; validate it against the agent-name rule before interpolation and quote it; the range is two integers.
- **Patterns to follow**: `costs.by` (grant shape, off and error codes, render), `CloudflareGraphqlUsageSource` (the token in the header only), `buildCostsByReport` (a pure builder over rows).
- **Test scenarios**: a 7-day range over points on three of the days yields seven `byDay` rows with four zero rows; an agent filter leaves other agents' points out of every table; a `failed` share of 2 in 20 renders as `10%`.
- **Verification**: the test files green, red first; `npm run specs:check`; `npm run docs:gen` then `npm run docs:check`; `npm run verify`.

### U4. The page

- **Goal**: `/metrics` shows the report in the costs dash's shape, gated like it, with the footer that names the bucket, the pricing and the completeness.
- **Requirements**: R14, R15 (run-metrics.md; live-view.md's shell rows; the screenshots gate).
- **Dependencies**: U3.
- **Files**: `src/channels/metricsView.ts` and its test; `src/index.ts`; `web/src/pages/MetricsPage.vue`, `web/src/lib/metrics.ts`, `web/src/lib/navSections.ts`, `web/src/lib/seedRouting.ts` and their tests; `web/src/pages/metrics.test.ts`; the screenshot manifest and PNGs; `docs/reference/specs/run-metrics.md`.
- **Approach**:
  1. Tests first: the handler's routing and seed (`/metrics`, `/metrics.json`, `?days`, `?agent`, off → 503 words, a source error → 503 with the class); the page renders the tiles, three charts and the table from a fixture seed and nothing the twin does not carry; the nav entry appears on `c.metrics` only.
  2. The handler in `costsView.ts`'s shape; the route and gate beside `/costs*`; the startup line.
  3. The page in `CostsPage.vue`'s tokens with `CostChart.vue` reused for the day series.
  4. `npm run screenshots:gen`; the PNGs are committed.
- **Patterns to follow**: `costsView.ts`, `CostsPage.vue`, `navSections.ts`.
- **Test scenarios**: as in the approach; a 90-day seed renders ninety x-axis buckets; the footer text equals the report's four sentences.
- **Verification**: the test files green, red first; `npm run screenshots:check`; `npm run build -w docs`; `npm run verify`.

### U5. Profile, configuration, release and the receipt

- **Goal**: Production writes points and the page reads them.
- **Requirements**: record 0063, "Rollout".
- **Dependencies**: U1 to U4 released, and every bot generation on a build that sends the point (U1's release or later) before the profile names the dataset, so no row turns final under the binding without its point.
- **Files**: the infrastructure repository's deployment profile (`metrics.dataset`) and bot config (`metrics:` block); no file in this repository.
- **Approach**: the profile names the dataset; the release deploys the state Worker with the binding; the bot config gains the block and the bot restarts; the receipt is `/healthz` `features` carrying `runMetrics:<dataset>`, a terminal `SELECT sum(_sample_interval) FROM <dataset> WHERE timestamp >= …` equal to the page's runs tile for the same window, `max(_sample_interval)` over the same window (1 expected), the wall-clock of the three report queries from the terminal, and one `[runs]` boot line with no dataset warning. Human-gated.

---

## Verification Contract

| Proof | Command or procedure | Units |
|---|---|---|
| Unit tests red then green, per unit | `npx vitest run <the unit's test files>` | U1 to U4 |
| The Worker's tests inside workerd (the emission rule's six cases, the throwing binding, the absent binding) | `npx vitest run deploy/cloudflare-memory/runs.test.ts` | U1 |
| The render is byte-identical without `metrics` in the profile | `npx vitest run src/deploy` | U2 |
| Every surface answers the command identically; off hides it | the conformance suite, `npx vitest run src/core/commands` | U3 |
| Spec bindings resolve, coverage holds | `npm run specs:check` | U1 to U4 |
| Derived command tables regenerated | `npm run docs:gen` then `npm run docs:check` | U3 |
| Screenshots regenerated after the web change | `npm run screenshots:gen` then `npm run screenshots:check` | U4 |
| The docs site builds over the spec rows | `npm run build -w docs` | U1 to U4 |
| The whole gate | `npm run verify` | U1 to U4 |
| Live, human-gated: the binding | `/healthz` of the state Worker carries `runMetrics:<dataset>` after the release | U5 |
| Live, human-gated: the count | a terminal `sum(_sample_interval)` over the dataset for the page's window equals the runs tile within the at-most-once tolerance; posted on the receipts issue | U5 |

---

## Definition of Done

- Every unit's tests are green and failed before its change; `npm run verify` passes on each pull request; each pull request carries its spec rows in `run-metrics.md`.
- No Durable Object, table, credential or snapshot was added; the state Worker gained one optional binding, one var and one body field on two routes; the bot one config block, one capability, one command and one page.
- A build without the binding and the block is byte-identical to today on `put`, `finish`, every existing command and every existing page.
- No blob in any fixture or any query is free text; no query text lacks `_sample_interval` weighting.
- Production writes points, the page and the command read them, and the receipt is posted; record 0063 moves to accepted by the maintainer once the receipt is posted, with its two open questions answered a month after the release.
