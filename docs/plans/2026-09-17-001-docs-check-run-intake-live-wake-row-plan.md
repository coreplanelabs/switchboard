---
title: The check-run intake's operating note and its live wake row - Plan
type: docs
date: 2026-09-17
status: proposed
artifact_contract: ce-unified-plan/v1
artifact_readiness: implementation-ready
product_contract_source: ce-plan-bootstrap
execution: docs
extends: ../reference/specs/http-ingress.md
---

# The check-run intake's operating note and its live wake row - Plan

## Goal Capsule

- **Objective**: Close the two documentation gaps the check-run intake's first day in production exposed. The `checksIntake` row of the features how-to does not say that the bot's container reads its secrets at start, so a secret put after the bot booted leaves the route answering 503 until a restart, nor how an operator tells the route's state apart. And [http-ingress](../reference/specs/http-ingress.md) item 12 has no `live` proof row for the wake itself: the settled delivery that ends a plan runner's merge wait on the event rather than on the bounded fallback. One unit, one pull request, documentation only.
- **Authority**: [http-ingress](../reference/specs/http-ingress.md) item 12 and [agent-ship](../reference/specs/agent-ship.md) item 9 as written; the documentation rule that every criterion is bound to a proof and that receipts live in the tracker, never in a spec.
- **Execution profile**: one unit under the plan runner with the runner's merge grant. The unit is itself the procedure for the row it writes: its pull request's checks settle while the runner's merge step waits on the event, so the runner's own merge of this unit is the row's first receipt.
- **Stop conditions**: no code and no behavior change. A unit that would touch anything outside the two files named below hands back a deviation instead.

## Implementation Units

### U1. The operating note and the live wake row

- **Goal**: The `checksIntake` row in `docs/how-to/turn-features-on-and-off.md` says how the secret reaches the bot and how to read the route's state, and `docs/reference/specs/http-ingress.md` item 12 gains a `12, live` proof row for the wake.
- **Files**: `docs/how-to/turn-features-on-and-off.md` (the `checksIntake` row only); `docs/reference/specs/http-ingress.md` (one row in the proof table under item 12). Nothing else.
- **Approach**:
  1. In the `checksIntake` row's first column, after the secret and the webhook, add: the bot's container reads its secrets when it starts, so a secret put while the bot runs takes effect at the next restart (`deploy restart`), and until then the route answers 503. In the same row, add the ladder an operator reads the state by: an unsigned `POST /webhooks/github` answers 503 while the container has no secret and 401 once it has one; a real delivery answers 200 with `settled` true or false in its body.
  2. In the proof table of `http-ingress.md`, beside the existing item 12 rows, add one `12, live` row whose evidence is an agent-runnable procedure: a checked-in plan unit under the runner's merge grant whose review approves before its checks finish; the GitHub App's delivery for the last check run at the approved head answers 200 with `settled: true` and `sent: 1` of `1`; the unit's card reads merged within seconds of that delivery; the unit's run record shows the merge wait ended on the event, not on the fallback timeout. The row states the procedure only; the receipt for it is posted on the agent-ship receipts issue in the tracker.
  3. `npm run docs:check`, `npm run specs:check`, `npm run verify`.
- **Verification**: `docs:check`, `specs:check` and `verify` green. The runner's merge of this unit's pull request, waking on the settled delivery, is the live row's first receipt and is recorded in the tracker, not in this plan.

## Definition of Done

- The two files carry the note and the row; no other file changed.
- The unit's pull request was merged by the plan runner, and the wake receipt is on the tracker.
