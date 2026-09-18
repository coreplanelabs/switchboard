---
title: A pending bot deploy drains the bot - admission closes, a new ask is queued, the runner's spawn idles - Plan
type: feat
date: 2026-09-18
status: proposed
artifact_contract: ce-unified-plan/v1
artifact_readiness: implementation-ready
product_contract_source: ce-plan-bootstrap
execution: code
extends: ../decisions/0059-a-deploy-drains-the-resident-fleet.md
---

# A pending bot deploy drains the bot - admission closes, a new ask is queued, the runner's spawn idles - Plan

## Goal Capsule

- **Objective**: Build the 2026-09-18 amendment of [record 0059](../decisions/0059-a-deploy-drains-the-resident-fleet.md): when a release deploy is waiting on the bot preflight, the bot's admission closes — a new ask is answered "deploy pending, N minutes" and queued on the ledger's durable inbox, and the plan runner's next-unit spawn idles instead of starting — so the runs in flight finish, the bot preflight reads zero within a poll, the roll lands, admission reopens, and the queue and the idled spawn proceed. Tonight's failure mode (a plan runner spawning the next unit's child within seconds of a review's end, so the preflight never sees a quiet minute) becomes impossible by construction.
- **Authority**: record 0059 as amended 2026-09-18 (the three seams, the record's own end, the arithmetic on the `DRAIN` table) over record 0024 (admission is a stage of the dispatch pipeline), record 0046 (every number lives in `src/core/budgets.ts`), and record 0044 (nothing here runs a write; the queued ask dispatches as the person's own message). The living specs each unit names change in the same pull request: [release-and-deploy](../reference/specs/release-and-deploy.md) (the runner's wiring), [slack-channel](../reference/specs/slack-channel.md) item 8 and [http-ingress](../reference/specs/http-ingress.md) (the record's route and `/healthz`), [thread-admission](../reference/specs/thread-admission.md) (the answer and the queue), [agent-ship](../reference/specs/agent-ship.md) (the runner's idle).
- **Execution profile**: four units in dependency order, each one pull request through the review loop, tests first. U1 changes nothing a person sees; U2 is the first visible change; U3 and U4 can land in either order after U2. The units are seedable to the plan runner one at a time.
- **Stop conditions**: no new Worker, no new store, one optional bearer already shaped like the fleet drain's. A unit stops and asks if it would: refuse or delay a message addressed to a run in flight (a steer, a stop, a follow-up); hold a queued ask anywhere but the ledger's durable inbox; let the record live past `DRAIN.maxMinutes` or survive as a flag; introduce a duration constant outside `src/core/budgets.ts`; or dispatch a queued ask as anyone but its own sender.

## Implementation Units

### U1. The deploy-pending record on the bot and its route

- **Goal**: The bot holds one deploy-pending record — `{ since, until, by, reason }`, self-expiring, replaced by a later post, capped at `DRAIN.maxMinutes` — written and lifted through an authenticated route on the bot's HTTP ingress under a drain-scoped bearer, and `/healthz` carries it. An expired record is no drain everywhere it is read; a missing bearer means the route does not exist (optional, like the fleet's). The record is in-process state whose loss on a restart reopens admission — the safe direction — and the unit documents that this is deliberate.
- **Files**: the bot's HTTP ingress route module and `src/channels/health.ts`; `src/core/budgets.ts` only if a number is missing (none expected — the `DRAIN` table is reused); `deploy/secrets.manifest.json` for the bearer's row; specs: `http-ingress.md`, `slack-channel.md` item 8.
- **Verification**: unit tests over parse, expiry, replacement and the healthz shape; `npm run verify`.

### U2. Admission closes: the answer and the durable queue

- **Goal**: The admission stage of the dispatch pipeline (`src/core/dispatch/admission.ts`) reads the record before claiming the thread. While it is in force, a new ask is answered at once — "deploy pending, N minutes", N from the record's `until` — and stored on the ledger's durable inbox; a message for a run in flight passes untouched. When the record ends (lifted or expired), the queued asks dispatch in arrival order as their own senders, exactly as a durable-inbox message dispatches after a restart today.
- **Files**: `src/core/dispatch/admission.ts` and its tests; the refusal table (`src/core/refusal.ts`) for the new code with cause `system`; the inbox plumbing it reuses (`src/core/runLedger/inboxMessage.ts`); spec: `thread-admission.md`.
- **Verification**: table tests — new ask during the record (answered and queued), steer to a run in flight (passes), queued ask after reopen (dispatches, arrival order, original sender), record expired (no drain); `npm run verify`.

### U3. The runner's spawn refusal

- **Goal**: The plan runner's next-unit spawn reads the same record and idles instead of starting: no child is provisioned, the unit's card names the wait, and the spawn proceeds when admission reopens, bounded by the record's `until` plus `DRAIN.marginMinutes`. An idling runner spends no child lease.
- **Files**: the coordinator driver (`src/core/coordinator/driver.ts`) and the spawn path it calls; spec: `agent-ship.md`.
- **Verification**: driver tests — spawn during the record idles and resumes at reopen; spawn at `until` plus margin proceeds (the record is over by construction); the card line; `npm run verify`.

### U4. The deploy runner's wiring and the live receipt

- **Goal**: `deploy all`'s bot step posts the record before its first preflight attempt when the bearer is present, extends its wait past the plan's 30 minutes the way the drained resident step does, and lifts the record in the same `finally` that undrains the fleet — whenever a post was asked for, not only when it was acknowledged. Without the bearer the step behaves exactly as today and says so by name.
- **Files**: `src/deploy/run.ts`, `src/deploy/plan.ts`, `src/deploy/residentDrain.ts` or a sibling for the bot's post; specs: `release-and-deploy.md`.
- **Verification**: runner tests mirroring the resident drain's (post before first attempt, extended wait, lift in `finally`, no-bearer passthrough); `npm run verify`. The live receipt — the first release whose bot step drains, rolls with zero in flight and reopens — is posted on the tracker, never in this plan.

## Definition of Done

- All four units merged; the amendment's three seams exist with the record's own end and the `DRAIN` numbers unchanged.
- A release deployed under working-hours plan traffic rolls the bot without killing a run and without a split release; the receipt is on the tracker.
- The open questions (a queued ask outliving a failed deploy's record; `deploy restart`) are recorded on the record, decided by their first occurrence.
