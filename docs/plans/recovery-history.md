---
title: Preserve outcomes across recovery attempts
status: implemented
date: 2026-10-01
---

# Preserve outcomes across recovery attempts

Recovery keeps the original work, requester, repository, branch and limits.
Its previous ending must remain readable after the next ending replaces it.
A repeated transport request reconciles its saved action; a later request
can propose another action but cannot reuse a consumed review transition.

## Storage and identity

The existing coordinator store owns a journal beside its unit rows. A claim
transaction compares the complete unit, stores the observed predecessor and
request action, and installs the recovery claim. Settlement appends a causal
receipt, closes that action and replaces the unit in one transaction. Refusal
restores the predecessor and permanently records that action's refusal.
Terminal receipts are immutable; pending action state is separate.

The adapter's original message ID, requester, thread and unit derive the action
ID. The action retains canonical admission fields and their digest. Claim
timestamps do not change request identity. Workflow and delivery IDs retain
their separate meanings. The original main and worker threads are recorded
separately; an indexed private act must still match its unit at claim time.

Original admission must be reconciled before a new recovery can claim the
unit. The exact-record admission confirmation changes only the instance;
replaying it preserves all recovery actions and terminal receipts. Legacy
instances without an admission marker retain their existing recovery path.

Only a small history pointer lives on the unit. Ordinary writes, wakes,
instance replacement and bare CAS cannot bypass journal transitions. Checked
publication progress may advance the reviewed head and discard rollback-only
binding data while retaining the action and every prior receipt.

The ownership fence carries the durable recovery action ID, including after
restart. Cleanup compares that ID as well as the unit, so delayed settlement
or refusal responses cannot release a later recovery of the same work. A
healthy refusal replay completes cleanup after lost storage responses.

## Bounds and rollout

Each unit permits at most 32 actions and 33 terminal receipts, within 6 MiB.
Admission reserves the next receipt slot, 164 KiB for its receipt and 160 KiB
for terminal fields in the current row. Progress preserves that row reserve.
Units are bounded to 224 KiB and complete transition envelopes to 480 KiB,
below the Worker's 512 KiB request limit. Action records are bounded to 8 KiB.
Capacity exhaustion refuses before external admission; it never trims history.

Pages contain at most eight receipts and 384 KiB. The existing private progress
capability rechecks its requester and act link, then returns bounded reports
with a separate history cursor. Earlier history is explicitly not recorded;
an observed predecessor does not invent earlier attempt or delivery facts.

Deploy state-Worker support before enabling the bot writer. An older or
unavailable store fails the action lookup before any recovery reservation or
Workflow creation. Existing claims without history retain their legacy path.
This change does not add a private resume tool, make pre-PR work recoverable,
or clear a persisted stop. Live stop/continue and transport-redelivery proof
remain separate from the deterministic tests in the owning spec.
