---
title: Terminal execution and replay fencing commit together
status: proposed
date: 2026-10-12
pattern: Durable journal and atomic completion barrier
---

# Terminal execution and replay fencing commit together

## Context

The model loop committed an `ended` event before the reply stage moved the live ledger row to `finishing`. A restart between those writes could select the completed execution for resume. Resume correctly refused terminal state, but the refusal replaced the completed result with a setup error.

## Research

- [Temporal event history](https://docs.temporal.io/encyclopedia/event-history) records commands and their results durably so recovery reconstructs execution from acknowledged history.
- [Restate durable execution](https://docs.restate.dev/foundations/key-concepts) journals completed steps and skips them during recovery. Its state updates are journaled with execution steps.
- [The transactional outbox pattern](https://docs.aws.amazon.com/prescriptive-guidance/latest/cloud-design-patterns/transactional-outbox.html) commits the business state and pending message together. External delivery still requires its own acknowledgment and duplicate handling.
- [Cloudflare SQLite transactions](https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/#transactions) provide the atomic storage boundary already used by the ledger.

The applicable principle is to commit execution completion and its recovery disposition together. A channel acknowledgment remains independent from an execution result.

## Decision

Use the existing fenced `assignLiveState` transaction. An `ended` assignment writes the event, terminal result patch and `finishing` phase together. The model loop supplies its exact terminal status, authored-output fact, observed final head and submitted typed outputs; a hosted pipeline supplies its outcome. Registry fan-out follows the durable acknowledgment. The in-memory ledger implements the same contract.

The reply stage still verifies ownership before delivery. For an ended row, a same-owner `finishing` call confirms the boundary its completion transaction already set. Ordinary `finishing` transitions remain one-time compare-and-swap operations. A different generation remains fenced.

Recovery settles an ended execution before considering transcript completeness or model resume. It validates the terminal event at the recorded sequence, keeps the saved status and original completion time, and archives through the existing finish path. For older rows without a saved status, the terminal event's typed cause supplies the supported outcome. Missing terminal evidence retains the row for reconciliation and starts no replacement.

Recovered records retain the original verdict, dispositions and handoff through their existing shape checks. A research brief requires canonical state matching the last complete submission, with its source bindings retained. Review-post success comes from a valid original-run publication receipt; pending, refused and uncertain publication remain separate from success. Malformed submitted outputs retain the row rather than silently becoming absent. A legacy stopped boundary uses the actual stopped event to recover its mode when the ledger has no stop flag.

Delivery remains unknown without a receipt. Recovery uses the existing card closure and does not replay a GitHub post or Slack reply merely to obtain an acknowledgment. Workspace retention and settlement continue through their existing owner checks; an execution ending grants no teardown authority.

## Alternatives and costs

Checking terminal state only in resume would suppress the symptom while leaving completion and recovery inconsistent. Moving the event after channel delivery would hide completed execution during a slow or unavailable channel. A separate workflow engine or delivery queue would add a second owner without closing this local transaction gap.

This change reuses the ledger schema, transaction, event stream and recovery path. Older bot and Worker versions remain readable: recovery can settle an ended row even when its phase came from the previous separate writes. The atomic guarantee requires the updated ledger implementation. It does not provide exactly-once delivery to external APIs or confirm an uncertain external effect.

## Proofs

The [run-history spec](../reference/specs/run-history.md#terminal-completion-and-recovery) binds the completion barrier, failed writes, owner fencing, legacy recovery and missing-evidence hold to tests of both ledger implementations and the model-loop producer. Production restart acceptance remains a separate check on the deployed build.
