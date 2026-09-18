---
title: A ship pipeline is a live run for its whole life, so every channel that can open a thread runs it and every surface is a projection of one record
status: proposed
date: 2026-09-18
pattern: One store, many projections (the run record is the truth; Slack's card and the web's turn render it); a hosted run with no process, kept alive by the heartbeat every run has and claimed under a key of its own so it occupies no thread; capability over name at the channel seam
---

# A ship pipeline is a live run for its whole life, so every channel that can open a thread runs it and every surface is a projection of one record

**The ask.** Decide (the maintainer, before the plan is written): a ship pipeline's parent run stays live from the hand-off to the pipeline's end and carries everything the runner says as events; the preflight admits any channel whose request handle can open a thread; the web adapter gains a handle rebuilt from a thread key. Reject a message store for the web. Written for an engineer who knows the dispatcher, the run ledger and the plan runner and has not read the web-chat record. Success criteria:

1. A person types an `agent:ship` task in a web conversation and watches the pipeline there, with the same rounds, card content and unit threads a Slack thread gets, refreshing the page at any point without losing a line.
2. Slack changes in no visible way.
3. HTTP `/ingress` and the MCP tool still refuse ship, with a reason that is true.
4. No new kind of stored thing: the web stores nothing of its own and a conversation remains the runs of one thread.

## TL;DR

The web chat refuses `agent:ship` with "this adapter is single-shot", which is false: a web run outlives its request, takes steers and reads history, and the check is a channel-name allowlist written before the browser became a channel. The real gap is that the runner speaks into threads at four moments with no run live to record it (a unit thread's lead, the card redraw, a unit's ending report, the plan summary), which Slack absorbs because Slack is also a message store and the web cannot because a conversation is the runs of its thread. The bet: the pipeline's parent run, which today ends the moment the runner takes the hand-off and is rewritten at the end, stays live for the whole pipeline, **hosted** by whichever bot generation is up with the heartbeat every run already has, so those posts become events on a run and the web renders them as it renders every run. It costs a hosted marker at the run's birth, a **host key** on the ledger so the parent never occupies the thread its children need, a host-only write path whose refusal the runner's driver learns one release earlier, hand-off and reclaim rules for a row with no process, and a web handle rebuilt from a thread key. Doing nothing leaves ship Slack-only and leaves every web conversation with a pipeline turn that says "handed off" for two hours and then rewrites itself.

## Today at `78a2ef9e`

The delta from what a reader of the specs expects; the survey is in the [appendix](#appendix-the-survey).

1. **The ship channel rule is a name check.** `shipPreflight` refuses any channel id not starting `slack:` or `cli:` and calls the rest "single-shot". The spawn path refuses the live request's handle by capability: no `openThread`, `spawn_unsupported`. The HTTP, MCP and web request handles all lack it today.
2. **The parent run ends at the hand-off and is rewritten at the end.** The `agent:ship` request's run finishes `completed` once the runner has taken it; the runner's `finish` route later writes a record under the same id from the instance and its unit rows (`parentRunRecord`). The parent is claimed on the ledger without a seed, and run-history item 39 excludes a ship pipeline from the hand-off by name, so a deploy tombstones it.
3. **Thread occupancy has four readers, and admission is the only one that releases early.** `ThreadAdmission` holds the in-process slot until the dispatch returns. The ledger's `live_runs` table has `thread_key UNIQUE`, and a run whose claim is refused runs untracked: no session log, no durable inbox, no hand-off. The coordinator's `spawn` route lists active runs by thread key and answers `busy`. The dispatcher's `threadsElsewhere` map, rebuilt each sweep from the ledger's rows, refuses a coordinator spawn and steers a person's message into an inbox. A live parent in the requesting thread trips the last three.
4. **The runner rebuilds a channel handle from a bare thread key, and only Slack answers.** `threadIoFor` knows `slack:`, hands `http:` and `mcp:` the null channel, and returns nothing for `web:`. The runner asks for this handle in five places.
5. **Writes are fenced and the driver's retry set is closed.** A ledger `append` from a non-owning generation is refused. The runner's driver re-asks a step only for four named refusals whose body carries `at`, twelve times two minutes apart, and throws on any other `ok: false`. The driver is bundled into the bot's own Worker script beside the container class, so the two deploy together in one release.

## The shape

A ship pipeline becomes a run like every other run: born at the hand-off, live for its whole life, finished by the runner's `finish`. It has no process of its own. The bot **hosts** it: the generation that took the hand-off keeps the registry row and the ledger claim it already made, heartbeats it as it heartbeats every run, and appends the runner's posts to it as events. The parent is marked `hosted` at birth. On the ledger its row is claimed under a **host key**, the thread key with a `#host` suffix, while the row's metadata names the thread itself: the ledger's own occupancy checks read the key column and never see the parent, everything that lists, files or renders a run reads the metadata and finds it under its conversation, and the two in-process readers that decide occupancy from a view skip the marker. At SIGTERM the hosting generation hands the row off like a resumable run; the next generation's reclaim re-hosts it instead of closing it. The **card** in Slack and the **turn** on the web are then two renderings of one record. The channel rule becomes what the spawn path already applies to a request: a channel runs ship when the handle its request arrived on can open a thread. The web gets that handle, and a second one rebuilt from a key for the runner.

The closest known shape is a Temporal parent workflow whose history holds each child's completion, the UI a projection of that history; the one difference is that our parent has no worker, so its liveness is a heartbeat the bot pays on its behalf and hands to the next generation at a deploy.

```mermaid
sequenceDiagram
    participant P as person (web)
    participant A as bot gen A
    participant L as ledger (state Worker)
    participant R as plan runner
    participant B as bot gen B
    P->>A: POST /threads/c9/send "agent:ship … plan … units Ua Ub"
    A->>L: claim r1 under web:s:c9#host (meta: thread web:s:c9, hosted)
    A->>R: hand-off (instance i7, runId r1)
    A->>L: state.hosting = i7; run_meta { instanceId: i7 }
    A-->>P: 202, turn r1 live (token); slot released, row stays
    R->>A: unit-start Ua
    A->>A: web handle for web:s:c9 opens sibling web:s:c9-u1
    A->>L: append to r1: ship_unit Ua started (thread, lead)
    Note over A: SIGTERM: r1 handed off (hosted rows are resumable)
    B->>L: reclaim moves r1 to gen B → re-host
    R->>B: unit-end Ua merge_ready
    B->>L: host append to r1: ship_unit Ua merge_ready (report)
    P->>B: refresh /threads/c9
    B-->>P: turn r1 live with Ua's report; composer reads send
    R->>B: finish completed
    B->>L: finish r1 (answer = plan summary), one record
```

## One trace: a two-unit plan from a web conversation, refreshed mid-round, the bot redeployed once

The requester's session is `access:s`; the conversation is `web:s:c9`. The bot is at generation A.

1. The person sends `agent:ship in <owner>/<repo>: plan <path> units Ua Ub`. The ship branch creates run `r1` in the registry with `meta.hosted: true` and its label, claims the ledger under `web:s:c9#host` with the same metadata, and calls the preflight with the request handle's capability (`canOpenThread: true`); the channel check passes. Had another pipeline been hosted in this thread, the claim would answer `thread-live` on the host key and the branch would refuse by name: one pipeline per thread.
2. The hand-off writes instance `i7` with `runId: r1` and asks the shim, then sets the row's state `hosting: i7` and publishes `run_meta { agent: ship, instanceId: i7 }`, the fact the unit listing keys on. The dispatch returns and the admission slot is released as today; the branch's finish, `finishing` and seal are skipped. The web answers `202` with `r1`'s view path; the page mounts the turn with a live token, and because the turn carries `hosted` the composer reads `send`.
3. The runner's `unit-start` for Ua asks A for the handle of `web:s:c9`. The web handle is rebuilt from the key alone (the session sub is in the key; the actor is the row's `userId`). Its `openThread(lead)` mints conversation `c9-u1` under the same sub and returns the key and a bound handle. A hosts `r1`, so it publishes `ship_unit { unit: Ua, state: started, threadKey: web:s:c9-u1, lead }`; the write-through mirrors it to the ledger in seq order.
4. The coding child for Ua dispatches into `web:s:c9-u1` as a coordinator child, carrying the instance tag as today and no `parentRunId`. Its ledger claim is on `web:s:c9-u1`, no collision; a one-unit task's child would claim `web:s:c9` while the parent holds `web:s:c9#host`, no collision either.
5. A release lands. A receives SIGTERM. The hosted row counts as resumable, so A marks it `handoff`, the drain does not wait on it, and the abandonment pass writes no tombstone for it.
6. B boots and reclaims. The reclaim is one ledger transaction that moves every taken row's `ownerGen` to B; a generation racing it finds the row already B's with a live lease and skips it. `r1` has no transcript, so today's rule would close it "no transcript stored". The new rule runs first: a row whose `state.hosting` is set is `rehost`. B recreates the registry row with `r1`'s id, metadata, label and the ledger's events as a replay (a fresh token comes with it), adopts the ledger row, subscribes the write-through and starts the heartbeat. Nothing about it enters the elsewhere map: `rehost` is its own outcome kind, and a foreign hosted row's key column reads `#host`, which no message's thread can match.
7. The person refreshes `/threads/c9`. The seed lists `r1` live with B's token; the turn paints `r1`'s events, `ship_unit Ua started` with its thread link among them. The composer still reads `send`.
8. The review child approves Ua and the runner's `unit-end` lands on B. B hosts `r1`, so it publishes `ship_unit { unit: Ua, state: merge_ready, report }`. The route also replies the report into the unit thread, for Slack's sake; on the web that reply resolves and is logged undeliverable, as the null channel's is.
9. The person opens `/threads/c9-u1`. Its runs carry the instance tag `i7`, so the seed reads the instance's `runId`, `r1`, and lists `r1`'s `ship_unit` events that name `web:s:c9-u1`, drawn as turns of the parent linked to `r1`: the report sits where Slack's message would.
10. Had `unit-end` landed on a generation that does not host `r1` (a rollout overlap), it would answer `409 { ok: false, error: "not_host", at }`. The driver counts `not_host` among its passing conditions and asks again under its policy, twelve tries two minutes apart, a 24-minute window against a re-host gap of at most 60 seconds.
11. Ub runs the same way. `finish` lands on B: B publishes the `answer` (the plan summary), finishes the registry row and writes the one record through the ledger, `ship_round` and `ship_unit` events in seq order, its thread the metadata's. No `parentRunRecord` is assembled.

The property: the pipeline's every visible word is an event on a run that was live the whole time and occupied no thread, so no surface needs a store of its own and no refresh or redeploy loses a line or strips a child of its ledger row.

## The difficulty map

1. **The hosted parent** (section below): the host key against the occupancy readers and the column readers that must switch to metadata, the driver's passing condition a release ahead, hand-off, reclaim and stop. A reader this record missed is where it breaks.
2. **The web handle and the sibling conversation** (section below): a handle from a key, a conversation nobody has sent into yet, the parent's word drawn in a child's conversation.
3. **The channel rule in the preflight** (one paragraph).
4. Spec rows across six living specs and one record note, and a new run event variant (most work, lowest risk).

## The hosted parent run

**Constraint.** A run's liveness has two meanings today and they coincide at the end of every dispatch: the admission slot, released when the dispatch returns, and the registry row with its ledger claim, heartbeat every 10 s, lease 30 s, reclaimed by the next generation when the lease lapses or the phase is `handoff`. The parent must be live in the second sense for one to two hours (a pipeline runs 27 minutes to two hours in this month's worklog; a coding child's ask is 90 minutes) while occupying no thread, because a one-unit task's children dispatch into the requesting thread itself (record 0055 item 3), and the ledger enforces one live run per thread with a unique index: a child refused there is not told `busy`, it runs untracked. The parent has no process, no seed and no transcript, so the hand-off skips it by rule, the drain waits on it for 15 minutes and tombstones it, and the reclaim closes it. The ledger fences writes to the owning generation, and the driver kills an instance on any refusal it does not know.

**Design.** Eight changes, each in code that exists.

- *The marker and the host key.* The ship branch creates the registry row with `meta.hosted: true` and the label, and claims the ledger row under the host key with the same metadata (the branch calls the ledger's `open` itself, before any reservation, so the ledger key and the message's thread key part there and nowhere else). `hosted` and `label` are threaded through the registry's meta and summary, the ledger's meta and both view builders, so the hosting generation's own row and a foreign row both carry them. One helper mints and recognises the suffix and enforces the ledger's 256-character key cap; nothing else knows it. After the hand-off the branch sets `state.hosting: <instanceId>` and publishes `run_meta { instanceId }`. `open` learns to answer with the same discriminated shape `reserve` already uses (tracked, fenced, untracked with its reason), so the branch refuses the request by name on `thread-live` and still hands off untracked on an outage, as today.
- *The readers.* On the ledger, the claim and the elsewhere map read the key column and miss the parent by construction. Four readers that file or address a run read the column today and switch to the metadata: the reclaim's record assembly, the interrupted-run notice (the key is copied at the reclaim's `closed` outcome), the resume launcher's message and its handle. `liveOnThread` in the coordinator's spawn route reads views, so it filters `!r.hosted`. The web's turn seed carries `hosted`; the page keeps the turn live and excludes hosted turns from the composer's mode and stop control. `ThreadAdmission` needs nothing.
- *The hand-off and the drain.* The write-through's tracked run learns `hosted` from `open` and reports `resumable` for it; the hand-off marking, the drain count and the abandonment pass all read that property today, so they follow. Run-history item 39's "never a ship pipeline" goes.
- *The reclaim.* Before the transcript rule, a row with `state.hosting` is `rehost`: `registry.create` with the id, metadata, label and the events as a replay; `adopt`, the existing seedless take-over that starts the heartbeat; a fresh write-through subscription. One store read guards it: a run id the store already holds finished means the runner's `finish` landed in the plain store because the ledger refused it, and the row is `abandon`ed, the fenced delete-without-record the ledger already has. A row claimed under the host key whose hand-off never happened (a crash between steps 1 and 2 of the trace) carries no `state.hosting`, falls to the transcript rule and closes "no transcript stored", filed under its conversation because the record assembly now reads the metadata.
- *The host-only write.* The runner's `unit-start`, `round`, `unit-end` and `finish` routes call one bot-side `hostPublish(runId, events)`: when this generation's registry holds the run, `registry.publish`, which assigns `seq` and is mirrored to the ledger; otherwise `409 { ok: false, error: "not_host", at }`. `unit-start` publishes `ship_unit` with state `started`, the thread key and the lead; `round` publishes the round's `ship_round` and a `ship_unit` state; `unit-end` publishes `ship_unit` with the ending and the report; `finish` publishes the `answer`, finishes the registry row and seals the record through the ledger with the metadata's thread. `parentRunRecord` is deleted. `drawCard` keeps redrawing the Slack card from the unit rows; the card and the events are two renderings of the same rows.
- *The driver, one release ahead.* The driver's passing-condition set gains `not_host`, one line. The driver ships inside the bot's Worker script, so this lands in a release before the bot starts answering `not_host`; the plan's first unit is that line alone.
- *`ship_unit`.* A new run event variant: unit, state (`started`, a round's outcome, an ending kind), thread key, lead or report, pull request when known. The run page's model draws it as a step with the report as detail; the friction analyzer's type filter learns the name.
- *Stop.* A hosted run is not stoppable. The refusal sits in the registry's stop, which the run page's token route and `stopRun` both reach, and in `stopRun`'s ledger branch for a foreign row, so `runs stop`, the token route and the tokenless route all answer `409 hosted` pointing at the units; the run page's seed makes `stopUrl` optional and draws no control without it. A pipeline is stopped as it is today, by stopping the child in flight, whose ending the runner reads. A runner-side cancel is an open question below.

**Invariants.**

- A pipeline has exactly one parent record for its life, under the id the hand-off minted; `finish` seals it and no second record is assembled.
- A hosted run occupies no thread on any read: admission's slot, the ledger's claim, the coordinator's `liveOnThread`, the dispatcher's `threadsElsewhere`, the web composer.
- Every record, notice and rebuilt handle derives a run's thread from the row's metadata, never from the ledger's key column.
- The parent is live in exactly one generation's registry, or on the ledger under a dead generation for at most one lease plus one sweep (60 s), or in `handoff` between the two.
- Every runner post a Slack thread shows is an event on the parent; a write to it lands only through the hosting generation, and every other generation answers `not_host`.

**Failure modes.** A fifth occupancy reader, or a fifth column reader, exists that this record missed: the plan's first tests are a one-unit task's child claiming its ledger row through the coordinator's spawn route with a hosted parent live, asserting the child is tracked, and a hosted row closed by the reclaim filing under the conversation. The store is unreadable at reclaim: the row is re-hosted anyway, and a `finish` that already landed is caught by the runner's retry, which finds a finished registry row and answers idempotently. The driver change misses its release: a rollout overlap during a pipeline kills the instance on the first `not_host`, which is why it ships alone and first. A hosted parent ever gains a seed (record 0057's session design): the ledger's session registration files the session under the claim key, so the session row and the record would disagree; the helper's metadata rule extends to that registration before any seeded hosted run exists.

**The alternative it beat.** The runner owns the parent's ledger row itself and no bot hosts it. Killed by the lease and the token: the runner's steps are minutes to ninety minutes apart while a child runs, the lease is 30 s, so a Workflow would have to wake every 10 s for two hours to keep a row the bot keeps for free; and a row nobody's registry holds has no token, so the web's turn paints frozen.

## The web handle and the sibling conversation

**Constraint.** The runner asks for a handle with a thread key and a user id, no request, no session cookie. A web conversation is the runs of its thread, so a thread with no run yet has no row anywhere. A unit's ending report is posted into the unit's thread on Slack, where the web has no run to carry it. And a child may not name its parent run: lineage is mechanical on a thread's newest run, so a `parentRunId` on a coordinator child would make every person's reply in a unit thread a lineage child of the hosted parent and steer it into an inbox nothing reads.

**Design.** `threadIoFor` learns `web:`: the key carries the session sub, so the handle is a `WebIO` whose history reads the thread's runs as `access:<sub>`. Its `openThread(lead)` mints a conversation id under the same sub with the adapter's own generator and returns the key and a bound handle; the caller records the lead on the run it acts for, which for the runner is the `ship_unit` event. A rebuilt web handle's out-of-run `reply` resolves and logs with `undeliverable` set, as the null channel's does. Children keep carrying the instance tag and nothing more. The conversation seed gains one read, a new runs-service method over the instance store the service already holds for the unit page: when a conversation's runs carry an instance tag, the seed reads the instance's `runId` and lists that parent's `ship_unit` events that name this thread key, drawn as turns of the parent linked to its run. The sibling becomes a rail row when its first run registers, as any thread does; before that it is a link on the parent's turn.

**Invariants.** A sibling conversation is in the requester's own lane and readable by exactly the people who may read its runs. Opening a thread writes nothing to the run store. A web handle never posts a message of its own. A coordinator child carries no `parentRunId`.

**Failure modes.** The requester's session is revoked mid-pipeline: the handle still rebuilds (it needs the sub, not the session) and the children run as the person, which is what a Slack requester who logs out gets today. A spawn from a plain agent loses its lead text on the web: the child's own run carries the request, as on the CLI.

## The channel rule in the preflight

The preflight takes a channel id and answers before the handle is consulted. It gains one input, `canOpenThread`, derived by the ship branch from the request handle it already holds. HTTP and MCP request handles lack it and are refused with the spawn's reason, "the channel cannot open a thread of its own"; the rebuilt null channel's `openThread` is irrelevant because the check runs on the request. The refusal text stops calling the web single-shot. The CLI's handle has `openThread` and keeps passing.

## Why not X

**Why not leave the parent finished and let the runner append to the finished record?** A finished record is written once and sealed; appending afterwards is the rewrite-at-the-end this record removes, spread over two hours, and a finished run has no token, so the web's turn paints frozen. Liveness is also the true state of a pipeline.

**Why not store bot messages, so the web is a message log like Slack?** Parity already holds for everything a run says, and the orphans are four posts that are facts about the pipeline. A message store would hold each run's answer twice, add a retention schedule, and reverse record 0043's one-store decision, which names it as the change to avoid.

**Why not make each runner post its own tiny run in the thread?** A card redraw is one message edited over two hours; as runs it is a turn per redraw and a card per redraw on Slack, the noise record 0055 removed. Each such run would also claim the thread on the ledger for its life, colliding with the child there.

**Why not one conversation for the whole plan, no siblings?** Record 0055 rejected one thread per plan on the session key and record 0057 removes that key; neither has decided the topology. This record keeps today's topology so the web matches Slack and takes no position on merging the threads.

## Boundaries

Not here: gate refusals as inline records (record 0043's own fallback; the same refusal vanishes on refresh today and deserves its own unit), ship over HTTP or MCP (still refused; a job-shaped ingress stays agent-ship's listed gap), thread-per-unit versus thread-per-plan, record 0057's session design, and a runner-side cancel. Migration: none; a pipeline in flight at the release has a finished parent, as today, and its rows are untouched.

## What would change our mind

- *Assumption:* the readers named in fact 3 and in the design are all of them. *Test, before the hosted-parent unit:* grep every reader of `live_runs.thread_key`, every `threadKey` read off a ledger row, and every `listRuns` with `status: "active"` or a thread-key compare; then the two first tests above.
- *Assumption:* the run page's model draws `ship_unit` events as steps without a new view model. *Test:* a fixture parent with three `ship_unit` events through `createRunPageModel`.
- *Assumption:* every runner route that writes tolerates `not_host` once the driver knows it. *Test:* the driver suite with a `409 not_host` answer carrying `at` on each of the four routes.
- *Unknown:* how many pipelines a generation hosts at once. Measured by `runs list --agent ship --status active` over a week; the heartbeat is one call per 10 s per hosted run, the cost every live coding run already pays.
- Reversibility: the ship branch's finish, `finishing` and seal come back as one block; `rehost` is one classification before the transcript rule; the web handle is one `case` in `threadIoFor`; `parentRunRecord` returns from history.

## Rollout

Four pull requests in this order, the first in a release of its own: (0) the driver learns `not_host`; (1) the hosted parent (the marker, the host key and its helper, the four column readers switched, `liveOnThread`'s filter, `open`'s shape, the tracked run's `hosted`, `rehost`, `hostPublish`, `ship_unit`, `finish` sealing the run, stop refused in the registry) with the two tests first; (2) the web handle, `openThread`, the seed's parent read, the composer's `hosted` exclusion, the preflight's capability input; (3) the spec rows and the web-chat record's note. The live receipt is a two-unit plan from a web conversation with one bot deploy during round 0, refreshed after the deploy, with the unit's report visible in the unit conversation.

## Open questions

| Question | Owner | Resolves it | Needed before |
|---|---|---|---|
| Should unit-start's thread choice key on unit count rather than "generated plan", so a person-provided one-unit plan runs in the asking thread? | the maintainer | one line in the plan's ask | the plan |
| Does a pipeline need a stop of its own (a runner cancel the hosting generation forwards), or is stopping the child in flight enough, as on Slack today? | the maintainer | a week of `runs stop` attempts on hosted rows answered `409 hosted` | after PR 1 |

Validation criteria bind in the plan; every row would be `[gap]` here.

## Spec rows that change with the code

- agent-ship: item 1 and its validation row (the channel rule by capability, the refusal's reason); item 16 (the hand-off keeps the run live and hosted, one pipeline per thread); item 17 (the unit listing reads the parent's events); the HTTP/MCP gap bullet under the roadmap.
- thread-admission: item 1 (a hosted run occupies no thread); item 6 (the web is the fourth channel that opens a thread).
- run-history: item 29 (one live run per thread: the host key and its helper); item 39 ("never a ship pipeline" goes); items 36 and 38 (`rehost`; records file by metadata); item 33 (`finish` seals the hosted row); the record shape's `ship_unit` event; item 41 (`hosted` and `label` on a foreign row).
- http-ingress: item 9 (the driver's passing conditions gain `not_host`).
- live-view: item 17 (hosted rows on the index, no stop control, `stopUrl` optional); item 28 (the unit page reads the parent's events, not a record assembled at finish).
- web-chat: item 2 (the seed's parent read; the composer ignores a hosted turn); item 11 (the adapter gains a key-built handle and `openThread`).
- Record 0043 takes a dated note of the same; its model stands.

## Appendix: the survey

| Fact | Proof at `78a2ef9e` |
|---|---|
| The ship channel check is a `slack:`/`cli:` prefix test with a "single-shot" reason; the preflight is called with the request handle in scope | `src/core/ship/preflight.ts` lines 154 to 166; `src/core/dispatch/ship.ts` lines 165 to 181 |
| The spawn refuses the request's handle by capability when it lacks `openThread` | `src/core/dispatch/spawn.ts` lines 275 to 280 |
| The hand-off run finishes `completed`, takes `finishing` and seals; its claim carries no seed; the ship fork runs before `reserveRun` and calls `open` itself; `open` answers `undefined` for fenced, route-missing, exhausted and `thread-live` alike, and both callers treat it as untracked | `src/core/dispatch/ship.ts` lines 287 to 296, 431 to 503; `src/core/dispatcher.ts` lines 707, 924; `src/core/runLedger/writeThrough.ts` lines 565 to 578, 966 to 976, 1004 to 1019; `src/core/dispatch/run.ts` lines 286 to 296 |
| The runner's `finish` writes a record under `instance.runId` from the instance and unit rows, synthesizing `run_meta { instanceId }` | `src/channels/adminCoordinator.ts` lines 1553 to 1611 |
| `live_runs.thread_key` is `UNIQUE`; the claim refuses `thread-live`; a refused reserve leaves the run untracked; `parseClaim` caps the key at 256 characters and stores meta verbatim | `deploy/cloudflare-memory/worker.ts` lines 1487, 1671 to 1696, 1737, 3605 to 3650; `src/core/runLedger/decisions.ts` lines 11 to 28; `src/core/dispatch/provision.ts` line 669; `src/core/dispatch/run.ts` line 294 |
| Views take a run's thread from the metadata; the reclaim's record assembly, the reclaim's `closed` outcome (read by the interrupted notice), the resume message and the resume launcher's handle take it from the column; the ledger's session registration files by the claim key | `src/core/runsService.ts` lines 414 to 443, 446 to 472; `src/core/dispatch/record.ts` line 201; `src/core/boot.ts` line 235; `src/index.ts` lines 1244, 1266; `src/core/resumeLaunch.ts` line 65; `deploy/cloudflare-memory/worker.ts` lines 1680 to 1690 |
| The coordinator's spawn route answers `busy` for any active run on the unit's thread, matching the view's thread; a task's unit thread is the requesting thread; children carry the instance tag and no `parentRunId` | `src/channels/adminCoordinator.ts` lines 379 to 387, 451 to 465, 492 to 502, 622 to 632, 1081 to 1087 |
| `threadsElsewhere` is rebuilt each sweep from ledger rows keyed by the row's thread column; lineage is mechanical on a thread's newest run's `parentRunId` | `src/index.ts` line 1226; `src/core/boot.ts` lines 255 to 266; `src/core/dispatch/lineage.ts` lines 51 to 63, 116 |
| Only `resumable` tracked runs are handed off; the drain count and the abandonment pass read the same property; the tracked run's constructor takes no meta | `src/core/runLedger/writeThrough.ts` lines 645 to 674, 1065 to 1069; `src/index.ts` line 1386; `src/core/dispatch/record.ts` lines 247 to 265 |
| `append` is fenced to the owner; the driver reads any status with `at` as an answer, retries four named refusals 12 times 2 min apart inside `step.do`, and throws on any other; the driver is bundled into the bot's Worker script | `src/core/runLedger/decisions.ts` lines 54 to 57; `src/core/coordinator/driver.ts` lines 67, 121 to 153, 228, 380 to 391; `deploy/cloudflare/worker.ts` lines 60, 167; `src/deploy/plan.ts` lines 212 to 214 |
| `registry.create` takes an id and a replay and mints a fresh token; `publish` assigns `seq`; `RunMeta` is set at create only; `LiveRunMeta` has no `label` and `ledgerView` omits it | `src/core/runRegistry.ts` lines 63 to 73, 207 to 247, 298 to 310; `src/core/runLedger/types.ts` lines 46 to 108 |
| `adopt` takes over a reclaimed row without a seed and starts the heartbeat; the reclaim is one transaction per sweep; `finish` writes the record and deletes the live row in one transaction; `land` falls back to the plain store when the ledger refuses, leaving the live row; `abandon` deletes a row without a record | `src/core/runLedger/writeThrough.ts` lines 726 to 733, 1019 to 1032; `deploy/cloudflare-memory/worker.ts` lines 1888 to 1930, 1941 to 1984; `src/core/runLedger/ledger.ts` line 104 |
| Three stop paths: the token route calls the registry directly; the tokenless route and `runs stop` hold a view and call `stopRun`, which reads none; the run page's `stopUrl` is a required seed field | `src/channels/liveView.ts` lines 706, 759, 803 to 812; `src/core/runsService.ts` lines 877 to 900; `src/core/commands/runs.ts` lines 300 to 301; `src/channels/webSeed.ts` line 102 |
| The web composer derives its mode from the live turn client-side; the turn seed is the run view plus fields; the runs service holds the instance store and a child's view carries `parentInstanceId` | `web/src/pages/HomePage.vue` lines 64 to 93; `src/channels/webSeed.ts` line 200; `src/core/runsService.ts` lines 406, 435, 473 |
| A coding child's ask is 90 minutes; a pipeline lives 27 minutes to two hours | `src/core/budgets.ts` line 104; the month's worklog (outside the repository) |

## Sources

Records [0043](0043-the-home-page-is-a-chat-the-browser-is-a-channel-and-a-turn-is-a-run.md), [0055](0055-a-unit-has-one-thread-and-a-round-reads-the-checks-at-its-head.md), [0057](0057-the-operator-is-the-one-door-a-model-binds-every-chat-input-and-deterministic-code-authorizes-fences-and-executes.md), [0019](0019-durable-run-ledger-resume-after-kill.md), [0031](0031-the-coordinator-runs-a-plan-not-a-pull-request.md), [0034](0034-one-agent-per-unit-a-run-continues-a-transcript.md); specs [agent-ship](../reference/specs/agent-ship.md), [thread-admission](../reference/specs/thread-admission.md), [run-history](../reference/specs/run-history.md), [live-view](../reference/specs/live-view.md), [web-chat](../reference/specs/web-chat.md), [http-ingress](../reference/specs/http-ingress.md).
