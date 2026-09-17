---
title: The costs snapshot archives the days it saw whole, so the page outlives the providers' retention
status: proposed
date: 2026-09-17
pattern: A write-behind archive keyed by the natural period, fed by the cache refresh that already runs; the writer decides finality, the store only upserts; the same pure builders over merged rows; coverage said, never invented
---

# The costs snapshot archives the days it saw whole, so the page outlives the providers' retention

**The ask.** Decide (the maintainer, before the plan is written): adopt this archive as the way the costs page offers more than 31 days. Reader: an engineer who knows the costs page and its snapshot ([costs.md](../reference/specs/costs.md) item 6) and has not followed why the 90-day preset disappeared. Frame assumed from the maintainer's "all of them" on 2026-09-17, which took this item with three others; correct the frame if the history is not wanted.

Success criteria: (1) `/costs/<group>.json?days=365` and the By user twin answer from the bot's own store, under two seconds, with every day the store has seen whole since the archive shipped; (2) a day the store never saw is said to be uncovered, never shown as $0; (3) no take reads a provider for more than the 31 days it reads today, and nothing reads a store in a page request; (4) a group renamed or a Worker added is attributed retroactively over the whole history; (5) for ranges up to 31 days the live snapshot and its readers keep behaving as item 6 says, the one visible change being a By user coverage that reaches back as far as the archive.

**Parked, 2026-09-17.** The maintainer's decision on the ask: keep the page at 31 days; the history is not needed now and this record can be picked up later. Nothing below is built, and costs.md items 3 and 6 stay as they are. The record stays `proposed` so the design, its correctness review and its cold reads are on file for whoever picks it up; a pick-up starts with re-checking the "Today at" table against the sha of that day.

## TL;DR

Cloudflare's analytics on this account hold 32 days and refuse anything older, so the page's history is capped at 31 days (PR #1451) and a year's view is impossible from the providers. The bet: every take already carries 31 days of raw rows keyed by UTC day, so the bot hands the Durable Object that stores the snapshot the days it **saw whole** (every closed day for the billing rows, every day fully inside run retention for the per-user rows) as per-day **archive** rows written in the same transaction, and a report of any width is the same pure builders over archive rows for the days the live snapshot no longer covers plus the live rows for the days it does. It costs one table on the existing object, one read route, an in-memory copy of a few megabytes a year, a coverage field on the daily report, and a second unit for the page's presets; it never recovers anything older than 31 days before it ships. Decided: raw rows not priced ones, the writer decides which days are final and the store only upserts, an archived row never shrinks to empty, the archive read once at startup and kept in memory, coverage said on both twins with one meaning; open: whether Anthropic's cost report can seed LLM rows further back, and how a year draws on a 960-pixel chart. Doing nothing keeps a costs page that cannot answer "what did last quarter cost".

## Today at `c36222a6`

| You would expect | What is true | Proof |
|---|---|---|
| The provider holds the history | Cloudflare GraphQL on this account refuses a range wider than 4w4d and data older than 4w4d, so `MAX_DAYS` = `SNAPSHOT_DAYS` = 31 (the second is a literal alias of the first) and the presets are `today · 7d · 30d` | [`src/core/costs.ts`](../../src/core/costs.ts) `MAX_DAYS`; [`src/core/costsSnapshot.ts`](../../src/core/costsSnapshot.ts) `SNAPSHOT_DAYS`; costs.md item 3 |
| The snapshot is a cache of a report | It is the raw rows: every Cloudflare meter's rows over the window, Anthropic's daily cost rows, and the run history's per-user rows (one per user per UTC day), each keyed by `date` or `day`; a report is `buildCostReport` / `buildUserCostReport` over those rows for the asked range, and `buildCostReport` zero-fills every day of the range | [`src/core/costsSnapshotStore.ts`](../../src/core/costsSnapshotStore.ts) `CostsSnapshot`; [`src/core/costs.ts`](../../src/core/costs.ts) `buildCostReport`, `eachDay` |
| A take's 31 days are 31 days of everything | The run store clamps its own query to retention: `usageByUser` reads from `max(since, now − retentionDays)`, and retention defaults to 30 days, one short of the window. The oldest day of every take therefore carries only the runs that finished after the take's time of day, and a shorter retention leaves it empty | [`deploy/cloudflare-memory/worker.ts`](../../deploy/cloudflare-memory/worker.ts) `RunStoreDO.usageByUser`; [`config/config.example.yaml`](../../config/config.example.yaml) `runHistory.retentionDays` |
| The store keeps history | `CostsSnapshotDO` holds one snapshot as one row per part (`parts(part, body)`, 11 parts: the meta, eight Cloudflare datasets, `llm`, `runUsage`), deleted and rewritten in one `transactionSync` on every put; the put body is fenced at 16 MB and a put lands in 66–162 ms | [`deploy/cloudflare-memory/worker.ts`](../../deploy/cloudflare-memory/worker.ts) `CostsSnapshotDO.put`, `USAGE_PARTS`, `MAX_SNAPSHOT_BODY_BYTES`; the memory Worker's `state.fetch` spans, 2026-09-17 01:49–02:34Z |
| Yesterday's rows are final | Anthropic's cost report closes a day hours after midnight; the trailing three open days (`MAX_ESTIMATED_DAYS`) are the hourly usage report priced at list and flagged `estimated`, and a closed day the report has no bucket for yields no row at all; Cloudflare's last day is still accruing (`partialLastDay`). By user clamps its coverage to the later of the range's start, the store's oldest finish and the retention cutoff (`coverageFrom`), and rewrites `range.from` to it | [`src/core/costs.ts`](../../src/core/costs.ts) `LlmCostRow.estimated`, `MAX_ESTIMATED_DAYS`; [`src/core/costsByUser.ts`](../../src/core/costsByUser.ts) `coverageFrom` |

Two numbers are guesses. A day's bytes across the ten dated parts: the store's own comment puts a 90-day snapshot at a few hundred KB, about 3 KB a day; sixty rows at 150 bytes says 10 KB; unit 1 logs the put body's bytes on the Worker and replaces both. The build over a year: `buildCostReport` rescans every row of every dataset once per day of the range, so a 366-day read over a year of rows is about 140 times today's arithmetic; unit 1 measures the builders over a synthetic year before the route is written.

## The shape

The archive is a write-behind copy of the cache, keyed by the period the data is already bucketed in, and the writer decides what is final. The take keeps reading 31 days and the live snapshot keeps being the one document every reader uses. Beside the snapshot, the bot computes the **archive rows** of the take: for each dated part, the rows of every day the take saw whole (`archiveRowsOf`, pure, in `costsSnapshot.ts`). The put carries both; the Durable Object rewrites the live parts and upserts a `days(date, part, body)` row for each archive row in the same transaction, refusing to replace a stored non-empty row with an empty one. A day is rewritten by every later take that saw it whole, so its archived value is the latest whole sighting: for the billing rows the take 30 days after the day, when both providers have long closed it. Reading is a merge: for a range wider than the live window the bot takes archive rows for the days before the live window's start and live rows for the rest, and hands the union to the builders that exist today. Nothing is sampled or downsampled, so a report over any range is the report a 365-day provider read would have given. Every row already carries its day: the eight Cloudflare datasets and the LLM rows as `date`, the per-user rows as `day`; the split knows those two field names and nothing else about the rows.

```mermaid
sequenceDiagram
  participant L as refresh loop / costs snapshot
  participant S as CostsSnapshotter (bot)
  participant P as providers (31 days)
  participant D as CostsSnapshotDO
  L->>S: refresh(by)
  S->>P: fetchUsage(31d) · fetchDailyCost(31d) · usageByUser(31d, clamped to retention)
  P-->>S: rows keyed by UTC day
  S->>S: archive = archiveRowsOf(snapshot): billing parts for [from, to), runUsage for [retentionFloor, to)
  S->>D: POST /costs/snapshot/put {snapshot, archive}
  D->>D: one transaction: replace parts(*); upsert days(date, part) per archive row, never empty over non-empty
  D-->>S: ok
  S->>S: memory.snapshot = snapshot; memory.archive[date][part] = rows, per archive row
  Note over S: a report for ?days=365 = builders over archive[date < live.from] ∪ live rows
```

## One trace

The page is asked `/costs/switchboard/users.json?days=90` on 2026-12-15, 89 days after the archive shipped on 2026-09-17; run retention is 30 days.

1. The gate admits the browser session; the handler asks the service for the By user report with `daysParam = "90"`.
2. `resolveRange("90", takenAt)` gives `2026-09-17 .. 2026-12-15`, 90 days, `partialLastDay: true`; `MAX_DAYS` is now 366, the page's ceiling; `SNAPSHOT_DAYS` is the literal 31.
3. The live snapshot, taken 2026-12-15 02:00Z, covers `2026-11-15 .. 2026-12-15`. Its `runUsage` rows for 2026-11-15 are the runs that finished after 02:00Z that day, because the store's retention clamp cut the rest.
4. The service asks the snapshotter for rows over the range: the in-memory archive answers `2026-09-17 .. 2026-11-14` (59 days), the live snapshot answers the rest. The archive's per-user row for 2026-11-14 is the one written by the take of 2026-12-12, the last take whose retention floor (hard part 1) was at or before that day; the takes of 2026-12-13 and later saw it cut and did not write it.
5. `buildCostReport` runs over the merged Cloudflare and LLM rows exactly as today; the daily report gains `coverage: { from: "2026-09-17" }`, the later of the range's start and the archive's first day (2026-08-18), so every day is covered.
6. For By user the service hands `buildUserCostReport` one `RunUsageReport` of the merged per-user rows and `historyFrom: "2026-08-20"` (hard part 2); it prices and allocates over 90 days, its coverage line reads from 2026-09-17 instead of 2026-11-15, and `coverage.retentionDays` still says 30, which is still true of the run store.
7. The same request on 2026-09-20, three days after ship: the first take on 2026-09-17 carried its 31 days, so the archive already begins on 2026-08-18; the range asks from 2026-06-23, so `coverage.from` = 2026-08-18 and the report's 56 leading days are uncovered; the page draws them as no data, the range total and the chart cover 34 days and say so, and the line says `history begins Aug 18`.
8. A user who was billed on 2026-10-01 left the workspace on 2026-11-20; run retention has dropped their runs from the store, but the archive's `runUsage` row for 2026-10-01, last written whole by the take of 2026-10-29, still names them, so the 90-day By user report still shows the row.

The property: a wide range reads only what the bot already holds and saw whole, says where its history begins, and prices the old days under today's tables and groups.

## The difficulty map

1. **Which days a take saw whole, per part** ([hard part 1](#hard-part-1-the-writer-decides-finality-per-part)): the retention clamp makes the oldest day of every take a truncated sighting of the per-user rows; a rule that lets it overwrite a whole sighting empties the By user history a day at a time.
2. **The By user read over merged history** ([hard part 2](#hard-part-2-the-by-user-read-must-not-be-clamped-by-run-retention)): the coverage rule was written for one store's retention; a wrong merge silently cuts a year to 30 days.
3. **Coverage on the daily report** ([hard part 3](#hard-part-3-a-day-the-store-never-saw-is-uncovered-not-free)): the builder zero-fills; without a coverage field a year-old day reads $0 and the total, the chart and the day count lie.
4. **Size, build time and the fences** ([hard part 4](#hard-part-4-size-build-time-and-the-fences)): two guessed bytes-per-day figures and an unmeasured 140× arithmetic; wrong by 10× still fits, wrong by 100× does not.
5. **The page** (most work, least risk): two presets, a coverage line, a year on one chart; a separate unit, gated on the maintainer's check-in for UI work.

## Hard part 1: the writer decides finality, per part

The constraint: a take's 31 days are not 31 whole days. The billing rows for the take day are still accruing and the trailing three LLM days are estimates; the per-user rows are clamped by the run store to `now − retentionDays`, so with the default 30-day retention the window's oldest day holds only the runs that finished after the take's time of day, and with a shorter retention it holds nothing. A rule of "every take rewrites every day it covers" therefore replaces a whole sighting of a day's per-user rows, written at D+1 through D+29, with the truncated one of D+30, and the By user archive is hollowed out one day at a time as the window passes. The first draft of this record had exactly that rule; the correctness review found it against `usageByUser`.

The design: the bot computes `archiveRowsOf(snapshot)`, one pure function beside the take, and the store only upserts what it is handed. Every take reads the same window (`takeCostsSnapshot` always asks for `SNAPSHOT_DAYS` ending on the take day, on schedule or on demand), so the rule has one shape. For the eight Cloudflare datasets and the LLM rows a day is whole when it is closed: `range.from ≤ D < range.to`; the take day is excluded, and an estimated LLM row inside that span is still written, since the next take overwrites it with the closed figure. For the per-user rows a day is whole when the store held all of it, and the store says how much it held: `RunUsageReport.retentionDays` travels with the rows, so the bot reads the retention the store applied rather than the config it might not share. The **retention floor** is then:

```
cutoffDay = dayOf(takenAt − retentionDays × 1 day)   // the day the store's clamp fell in
retentionFloor = cutoffDay + 2 days                   // skip the cut day and one day of margin
```

The margin is for clocks: the store clamps by its own clock at query time, a few seconds after the bot read `takenAt`, so the day right after `cutoffDay` can be short by the runs that finished in its first seconds; skipping it costs nothing, because the next take writes it whole. With `retentionDays` 0 (the Null run store, or no retention) the floor is `range.from`. In the trace: the take of 2026-12-15 has `cutoffDay` 2026-11-15 and a floor of 2026-11-17, so it writes per-user rows for 2026-11-17 onward and leaves 2026-11-14 to the take of 2026-12-12, whose floor was 2026-11-14.

The Durable Object upserts each `(date, part)` row and refuses to replace a stored non-empty row with an empty one, so a provider that answers nothing for an old day on one take (a transient gap, a cost report with no bucket) cannot erase a day another take saw. That guard is decided and revisable: the one true zero it hides is a day whose earlier sighting was non-zero and whose later closed figure is exactly nothing, which no meter here produces for a live account.

Invariants: (a) an archived `(date, part)` row was written by a take that saw the day whole for that part, by the rule above; (b) for the per-user part no archived row was ever written by a take whose `cutoffDay` was less than two days before the day; (c) an archived row's rows are never replaced by an empty list; (d) the archive rows of a take are a subset of the snapshot's rows, day by day.

Failure modes: retention is raised in config: the floor moves earlier and later takes write older days whole, which is correct; retention is lowered below the window: fewer days per take are archived, and a retention under one day archives nothing for the per-user part, which the startup log names. A take lands with `llm: null` (no admin key): no LLM archive rows are written for its days, and the guard keeps earlier ones. Thirty-one takes in a row fail: the days that passed through the window meanwhile were written by the last successful take that saw them whole, so a day is lost only if no successful take ever saw it whole, and the alert of item 6 has posted long before.

The alternative it beat: a finality rule in the Durable Object. The Object would need the snapshot's `takenAt`, its range and the run store's retention to compute the same floor, three facts it holds no other reason to know; the bot already holds all three, the function is pure and unit-tested, and the Object stays a store.

## Hard part 2: the By user read must not be clamped by run retention

The constraint: `coverageFrom(range, usage, generatedAt)` was written when the only source of per-user rows was the live run store, so it clamps the range to `generatedAt − retentionDays` and to the store's oldest finish. Hand it a merged row set with the live metadata and it cuts a 365-day range to 30 days while the rows for the other 335 sit unused, and the coverage line lies in the honest direction.

The design: `buildUserCostReport` takes an optional `historyFrom` day, and `coverageFrom` uses it in place of the retention candidate when given. The snapshotter answers every range, wide or narrow, with one synthesized `RunUsageReport` once the archive has rows: rows are the archive's per-user rows for every date before the live window's start plus the live rows; `pending` and `retentionDays` are the live report's, still true of the store; `earliestFinishedAt` is the earlier of the live value and the archive's first day at midnight; `historyFrom` is the archive's first day. `coverageFrom` then answers the later of the range's start and the archive's first day, which is the truth, and answers it continuously: `?days=31` and `?days=32` reach back the same distance, instead of one clamping to retention and the other not.

Invariants: (a) for any range within the live window the synthesized report's rows equal the live report's rows, so item 10a's pricing and allocation tests pass unchanged, and only the coverage reaches back further; (b) `coverage.from` = max(range.from, archive.firstDay) whenever the archive has rows; (c) a date is answered by exactly one side, the archive for dates before the live window's start and the live snapshot for every date from it on, so no `(userId, day)` appears twice; (d) a user present only in archived days appears with those days' figures and nothing else.

Failure modes: the archive read at startup fails (Worker down): the bot holds an empty archive, wide ranges answer with coverage from the live window's start, the line says so, a warning names the read, and the read is retried on the next loop tick until it succeeds, the way `current()` retries the snapshot read; the bot's own takes fill the in-memory archive meanwhile and the retried read merges under them (a take's row wins over the store's for the same `(date, part)`). Between process start and the read returning, the same.

The alternative it beat: synthesizing `retentionDays: 0` to switch the clamp off. It works, because 0 already means "no cutoff" to `coverageFrom`, but the report echoes `coverage.retentionDays` to the JSON twin, and a twin that says the run store keeps runs for zero days lies about the store to make the coverage true.

## Hard part 3: a day the store never saw is uncovered, not free

The constraint: `buildCostReport` zero-fills every day in the range (costs.md item 3, "one row per UTC day, zero-filled"), which is right when the provider answered the whole range and wrong when the archive begins in the middle of it. A year requested three days after the archive ships would show 331 days of $0, a total that is a twelfth of the truth, and a chart that draws the gap as spend.

The design: the daily report gains `coverage: { from: string }` with the same meaning as By user's: the later of the range's start and the first day the merged rows can speak for (the archive's first date when the archive has rows, else the live window's start). The builders do not change; the service sets the field from what it merged. The page treats a day before `coverage.from` as no data: no bar, greyed, excluded from the range total and the day count, with `history begins <Mon D>` on the coverage line the By user tab already has. The 7-day average and the projection already stand on the last full days and skip leading zero days, so they need no change. The JSON twin carries the field so a script can do the same.

Invariants: (a) every day from `coverage.from` to `range.to` was seen by a take, live or archived, for at least one part; (b) a report over a range fully inside coverage equals today's report except for the `coverage` field.

Failure modes: a closed LLM day the cost report has no bucket for produces no row and archives as LLM $0 inside coverage, as it reads $0 on the live page today; the guard of hard part 1 keeps an earlier sighting if there was one. A take with `llm: null` writes no LLM rows for its days, and an admin key added later fills only days from then on; coverage is per report, not per source, so those days read LLM $0 inside coverage. Those are the two places the design shows a zero it cannot vouch for; the seeding question below is the way to fill the second.

The alternative it beat: clamping the range to coverage the way By user rewrites its `range.from`. A cost report that quietly answers 34 days for a 365-day ask hides the gap; a report that answers 365 days and marks 331 uncovered shows it.

## Hard part 4: size, build time and the fences

The constraint: each `(date, part)` row is one JSON value in Durable Object SQLite, whose single value limit is 2 MB; the put body is fenced at 16 MB, and the archive rows ride in it beside the snapshot, roughly doubling a body the store's own comment puts at a few hundred KB. The archive adds rows: up to 31 dates × 10 parts = 310 upserts a take, in the same transaction as the live parts. Takes are one a day on schedule plus the on-demand ones, three on the first live day; a busy day of a dozen takes is 4,000 upserts, all replacing the same 310 rows. The read is the unmeasured part: `buildCostReport` is O(days × rows), so a 366-day report over a year of rows is about 140 times today's arithmetic.

The design: parts stay per dataset, so the largest value is one day of one dataset's rows, guessed at a few KB, more than two orders of magnitude under the limit. Growth is 3–10 KB a day, 1–4 MB a year, under the Object's 10 GB and under any reasonable in-memory copy; the bot reads the archive once at startup (`POST /costs/archive/get {}` → every day, in date order) and after that keeps it current from its own takes, so no page request reads a store. The builders are guessed to stay under a second over a year, because the 31-day build is arithmetic over about sixty rows a day and the twins' 0.8–1.7 s (the receipts of 2026-09-17 on the costs tracker) is the shim and the container, not the builders; unit 1 measures a synthetic year and, if the guess fails, the merged report is built once per take per group and preset and cached beside the archive. There is no retention: the archive keeps every day forever until a number says otherwise; a `costs.archive.keepDays` is refused as speculation.

Invariants: (a) the put transaction writes the live parts and the archive rows together or neither; (b) an archive row's body never exceeds the live part's body for the same dataset.

Failure modes: the bytes guess is wrong by 100× (1 MB a day): the startup read is 365 MB a year and must page; the read route takes `{from, to}` from unit 1 so the change is the caller's loop, not a new route. The Object's storage fails mid-transaction: SQLite rolls both back; the bot warns `costs snapshot not stored` and memory serves, as today.

The alternative it beat: one row per date with all parts in one body. Simpler to read, but the largest value becomes a whole day, and a day with a burst of Durable Object namespaces or a busy By user table is where the 2 MB limit would first bite.

## Why not X

**Why not archive a day once, when it falls out of the window, instead of upserting every whole day on every take?** Archiving once needs the take to know what the previous take covered, and a take that does not happen on the boundary day (thirty-one failed takes are one outage; a restart with a stale store is another) loses that day for good. Upserting every whole day makes each take self-contained and idempotent: any single successful take in a month restores the month's whole days. The price is up to 310 small upserts in the put's transaction, which the first live take after deploy measures.

**Why not archive the priced report rows (`DailyCost` per group) instead of raw rows?** A group is config: a Worker added to `costs.groups.<group>.workers` tomorrow must be attributed over last quarter too, and Cloudflare's price table (`CLOUDFLARE_PRICES`) changes with a code change. Priced rows freeze both. Raw rows are re-priced and re-attributed by the same builders on every read, which is what success criterion 4 asks.

**Why not keep every snapshot whole and stitch them?** Each snapshot repeats 30 of its 31 days from the previous one; a year is 365 documents of 31 days, 31× the bytes of the archive, and the read is the same merge with the duplicates removed first, and with the same finality question unanswered.

**Why not push the rows to the event lake, or R2, and query there?** The page needs arithmetic over a few thousand daily rows the bot already holds in memory; a lake is a second system with its own credential, schema and query latency for a few megabytes a year. The lake stays the place for run-level forensics; item 10a's reconciliation reads nothing from it either.

## Boundaries

The archive begins 31 days before it ships (the first take's oldest day for the billing parts, 2026-08-18 if this ships on 2026-09-17; the per-user part begins at the first take's retention floor, 2026-08-20 with 30-day retention), and nothing older will ever be shown for Cloudflare. Anthropic's cost report may reach further back and could seed `llm` rows for older days; that is the open question, not this design. The live snapshot, its take, its loop, its command and its status feed do not change. `SNAPSHOT_DAYS` becomes the literal 31 and `MAX_DAYS` the page's ceiling (366); the two are one alias today, and the rollout names the order. The page's presets and the drawing of a year are a second unit, gated on the maintainer's check-in for UI work. Compatibility: the JSON twins gain `coverage` (the daily one) and reach back further (By user); nothing is removed; `?days` over 31 stops clamping to 31 and clamps to 366.

## What would change our mind

- A day's rows are 100× the guess. Evidence: the put body's byte count logged on the Worker in unit 1, before the archive table is written. Consequence: paging the startup read by date range; the design survives.
- The builders over a year take seconds, not under one. Evidence: the synthetic-year measurement in unit 1. Consequence: the merged report is built once per take per group and preset and cached in memory beside the archive, the same way the snapshot itself is the cache in front of the providers.
- The Durable Object's SQLite refuses 310 upserts in one transaction within its time budget. Evidence: the first live take after deploy, its `state.fetch` span. Consequence: the archive rows go in a second transaction after the live parts, accepting a live snapshot without its archive rows for one take.
- The run store's retention clamp changes shape (a query that reads past retention, a store that deletes rather than hides, a retention no longer reported on the answer). Evidence: `usageByUser` at the sha unit 1 starts from. Consequence: the store answers with the first day it held whole instead of a retention count, and `archiveRowsOf` reads that.

Reversibility: the table can be dropped and the route removed with the presets; the live snapshot is untouched throughout.

## Rollout

Unit 1, the store, in this order: the put body's byte count logged on the Worker and read off one live take (the sizing question closes before anything is built); `SNAPSHOT_DAYS` the literal 31 first, then `MAX_DAYS` 366 (today `SNAPSHOT_DAYS = MAX_DAYS`, so the other order makes every take ask Cloudflare for 366 days and fail), with the `resolveRange` clamp tests, costs.md item 3 and criterion 5, and the `MAX_DAYS` comment that still calls it the snapshot's window; `archiveRowsOf` and its tests; the `days` table, the upsert inside `put` with the non-empty guard, `POST /costs/archive/get {from?, to?}`; the in-memory archive on the snapshotter with the retried startup read; `coverage` on the daily report; `historyFrom` on `buildUserCostReport` and the merged By user read; the byte and build-time measurements; live receipt: `/costs/switchboard.json?days=60` a day after deploy carries `coverage.from` = the first take's oldest day and answers under two seconds, and `/costs/switchboard/users.json?days=60` reaches back past 30 days. Unit 2, the page: `90d · 1y` presets, uncovered days drawn as no data, the coverage line; check-in first. The seeding question resolves between the two.

## Open questions

| Question | Owner | Resolves it | Needed before |
|---|---|---|---|
| Does Anthropic's cost report answer a `starting_at` a year back within `MAX_COST_PAGES` (20) pages, so `llm` rows can be seeded for days the archive never saw? | the maintainer's session | one probe with the admin key (never printed), `bucket_width=1d`, `starting_at` 365 days ago, reporting pages consumed | unit 2 |
| If it does, is a day with LLM rows and no Cloudflare rows shown inside coverage with cloud $0, or does coverage become per source? | the maintainer | the probe's answer and one look at the By user reconciliation line for such a day | unit 2 |
| How does a year draw at 960 pixels: 365 bars, or weekly buckets from 90 days up? | the maintainer | a check-in with two renders from `scripts/web-preview.ts` | unit 2 |

## Validation criteria

| # | Criterion | Proof |
|---|---|---|
| 1 | `archiveRowsOf`: billing parts for every closed day of the range, the per-user part for every day at or after the retention floor read from the store's answer (`cutoffDay` + 2), nothing for the take day; retention 0 → the range's start; the rows a subset of the snapshot's, day by day | `[gap]` unit 1: `src/core/costsSnapshot.test.ts::archiveRowsOf::*` |
| 2 | A put writes the live parts and the archive rows in one transaction; a later put replaces the rows it carries and leaves the rest; an empty list never replaces a stored non-empty row; the read answers every archived day in date order, or a `{from, to}` slice | `[gap]` unit 1: `deploy/cloudflare-memory/costs.test.ts::CostsSnapshotDO routes::*` |
| 3 | The bot reads the archive once at startup, retries a failed read on the next tick, keeps it current from its own takes with a take's row winning over the store's | `[gap]` unit 1: `src/core/costsSnapshot.test.ts::CostsSnapshotter::*` |
| 4 | A range inside the live window builds today's rows (the daily report plus `coverage`; By user with the same rows and a coverage that reaches back to the archive); a wider range merges archive rows for dates before the live window's start with live rows, no `(date)` or `(userId, day)` twice | `[gap]` unit 1: `src/core/costsSnapshot.test.ts::reportFromSnapshot / usersReportFromSnapshot::*` |
| 5 | `coverage.from` = max(range.from, archive.firstDay) on both twins; By user's `coverage.retentionDays` stays the store's | `[gap]` unit 1: same file; `src/core/costsByUser.test.ts::coverageFrom::*` |
| 6 | `SNAPSHOT_DAYS` is 31 and no take asks a provider for more; `?days` clamps to 366 | `[gap]` unit 1: `src/core/costsSnapshot.test.ts::takeCostsSnapshot::*`, `src/core/costs.test.ts::resolveRange::*` |
| 7 | Deployed: a day after the release, `/costs/switchboard.json?days=60` carries `coverage.from` = the first take's oldest day and answers under two seconds; the By user twin reaches back past 30 days | `[gap]` `[agent]` receipt on the costs receipts tracker |
| 8 | The page draws an uncovered day as no data and says where history begins | `[gap]` unit 2, human-gated |

## Sources

- costs.md items 3, 6, 10a; PRs #1427, #1436, #1451; the receipts of 2026-09-17 on the costs receipts tracker (twins 0.77, 1.53 and 1.70 s).
- Cloudflare's refusals, measured live 2026-09-17 00:35Z: `cannot request a time range wider than 4w4d`, `cannot request data older than 4w4d`.
- The memory Worker's `state.fetch` spans for `/costs/snapshot/put`, 2026-09-17 01:49–02:34Z: 66, 98 and 162 ms.
- The correctness review of this record's first draft, 2026-09-17, which found the retention clamp against the "last take wins" rule.
