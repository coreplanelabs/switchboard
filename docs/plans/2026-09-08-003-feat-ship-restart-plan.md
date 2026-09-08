---
title: Ship pipeline after a bot death - Plan
type: feat
date: 2026-09-08
status: proposed
extends: 2026-09-08-001-feat-durable-runs-plan.md
artifact_contract: ce-unified-plan/v1
artifact_readiness: review-ready
product_contract_source: the durable-runs close-out session; two adversarial review arms (architecture, skeptic/fact-check) on a first draft that proposed automatic restart — both NOT READY; this text is the reviewed-down plan, with their findings folded in as decisions
execution: code
---

# Ship pipeline after a bot death - Plan

## Goal Capsule

- **Goal**: when the bot dies or rolls under a ship pipeline, the people in the thread learn what happened and how to continue **from the next generation, at once**; nothing about the pipeline's GitHub work is lost or duplicated; and the durable-runs machinery the pipeline sits on has no path by which one run is driven twice.
- **What the first draft wanted and this plan does not do**: restart the pipeline unattended. The review found that unattended restart (a) needs per-attempt fencing the ledger does not have, (b) would re-run the most expensive child round on every generation of a crash loop with no bound but the wall clock, (c) leaves an in-flight resident command orphaned in the worktree the restart attaches — the repository's own item-56 incident class — and (d) can take a PR from unreviewed to approved with nobody present. It also found that ship runs are rare (none among the last 200 records), so the machinery had no measured demand. Automatic restart stays a follow-up gated on evidence (below).
- **Success criteria**: (1) a hard kill under a ship pipeline closes its run `interrupted`, closes its card with a note naming the PR and the re-issue, and posts that note in the thread, on the next generation's boot; (2) a heartbeat that cannot land for longer than a lease never makes a generation reclaim and relaunch its own live run; (3) a run whose row another generation took neither replies nor writes a record from the old process, whichever of its writes hit the fence first.

## What the review found in the shipped code (fixed here)

Three defects in the durable-runs series, independent of ship, surfaced while fact-checking the first draft:

1. **A generation could reclaim its own run.** `selectReclaim` took every row with a lapsed lease regardless of owner; the reclaim sweep runs every lease interval inside the live process; a heartbeat that throws only warns. Thirty seconds of state-Worker trouble during any run would let the same generation reclaim its own row, resume (or, since item 42, restart) the run beside the one still running, and the fence — which compares generations — would never stop the first.
2. **A fence did not gate the finish.** A write refused as `fenced` detached the run and fired `onFenced`, but `finishing()` answered `unavailable` for any detached run, so the old process replied and wrote its record to the fallback store — the double answer item 39 exists to prevent.
3. **An interrupted pipeline's card could spin forever.** `closeReclaimedCards` skipped `interrupted`; the orphan sweep that would close such a card looks back two hours, less than a pipeline's ceiling; and the sweep's advice ("re-send your request") is refused by ship's own entry checks over its still-open PR.

## Steady state

- **The reclaim never takes a row its own generation owns** (`selectReclaim(rows, now, gen)`, applied identically by the reference ledger and the Durable Object). A lapsed lease on our own row is a heartbeat that did not land; the run is ours and still running; nothing else touches it until it finishes or the process dies.
- **A run detached by a fence answers `fenced` at finishing** for the rest of its life; a run detached for any other reason (a permanent write failure while the row stays ours) still answers `unavailable` and replies as before.
- **An interrupted closure carries a note.** The reclaim reads the run's events anyway; from them it takes the PR a `pr_opened` event recorded, and composes `closureNote(agent, prUrl)`: for ship, the PR (if any) and the re-issue that continues the loop — `agent:ship` with only the PR URL, the entry the preflight already treats as resume-at-review, or with the task when no PR existed, which runs round 0 again on the pipeline's own deterministic branch; for every other agent, "re-send your request". `closeReclaimedCards` closes interrupted cards with that note; for a ship pipeline the note is also posted as a reply in its thread.
- **Nothing else changes.** A ship row is still claimed without a seed and still closes `interrupted` at a reclaim; attaching rows are still never handed off; the drain still waits for a ship run (see follow-ups).

## Decisions

| # | Decision | Why | Reversibility |
|---|---|---|---|
| D1 | **Tell, do not restart.** The next generation posts the re-issue; a person continues the loop. | The review's four hazards above, and no measured demand. The human re-issue path already exists and is fail-closed (agent-ship item 10). | R1: automatic restart can be layered on later once the follow-ups below are in |
| D2 | **Own-generation exclusion in the reclaim rule**, not a per-attempt epoch. | One predicate, one line in both ledgers; an epoch on the row would touch every fenced write. The exclusion is exactly right: a row we own with a lapsed lease can only mean our heartbeat failed. | R1 |
| D3 | **`fenced` sticks.** A fence-detached run's `finishing()` answers `fenced` forever; other detaches keep `unavailable`. | Item 39's contract; the two detach reasons mean different things (theirs vs still ours). | R1 |
| D4 | **The PR comes from the events, not from new state.** | The reclaim reads the events for the record already; `pr_opened` is a typed event; no new ledger field. | R1 |
| D5 | **The note is a reply for ship only.** Other agents' interruptions are card-only, as before. | A pipeline's work stands on GitHub with nobody driving it and can run for hours; a general run's interruption is a re-send. | R1 |

## Follow-ups (not in this plan)

- **Hand ship runs off on SIGTERM so deploys never wait on one** — only together with a force-detach of the thread's resident worktree before the next attach (the item-56 orphan class). Today the drain waits up to its deadline and the pipeline dies at exit anyway; the wait buys nothing, which is the real argument for it.
- **Automatic restart of a pipeline**, gated on: a count of interrupted ship records in the store above a handful, the handoff above in place, a restart cap per pipeline in the row's state, and the launcher composing the re-issue from the original request's directives (never the row's resolved model, which is ship's own).
- **The orphan sweep's window** (two hours) is shorter than a pipeline's ceiling; with the reclaim now closing interrupted cards it is a backstop, but a card the reclaim could not close still ages out of it.

## Validation criteria

| Criterion | Proof |
|---|---|
| The reclaim never takes a row its own generation owns (pure rule, reference ledger, Durable Object, boot) | `[unit]` `src/core/runLedger/decisions.test.ts::selectReclaim — expired leases and handed-off runs::*`, `src/core/runLedger/inMemory.test.ts::InMemoryRunLedger::reclaim takes the expired and handed-off runs, gives them to the new generation with the last step, the unconsumed inbox and the jobs, and re-fences the transcript`, `deploy/cloudflare-memory/runLedger.test.ts::run ledger — finishing, finish, handoff, reclaim (items 31, 33)::handoff marks this generation's live runs; reclaim takes expired and handed-off rows with the last step, the unconsumed inbox and jobs, and re-owns them; a live lease is left alone`, `src/core/boot.test.ts::reclaimRuns::a row this generation owns is never taken by its own sweep, however stale its lease — not closed, not relaunched, not listed elsewhere; the run it belongs to is still ours and running` |
| A fence-detached run answers `fenced` at finishing; another detach answers `unavailable` | `[unit]` `src/core/runLedger/writeThrough.test.ts::finishing and finish::*` |
| An interrupted closure carries the PR from the events and the agent's note; the card closer closes interrupted cards with it | `[unit]` `src/core/boot.test.ts::reclaimRuns::an interrupted closure carries what its card and thread say next: a ship pipeline's note names the PR its events recorded and the re-issue that continues the loop (the task when no PR exists); any other agent's says to re-send; a run that replied gets no note`, `src/channels/slack.test.ts::live cards::closeReclaimedCards closes the cards of runs that had replied with how they ended and an interrupted run's card with its closure note, skips runs without a card, and isolates a failed edit` |
| Live: kill the bot under a ship pipeline; the next generation closes the card `❌ ship · interrupted` with the note and posts the note in the thread, naming the PR | `[agent]` receipt on the agent-ship receipts issue |
