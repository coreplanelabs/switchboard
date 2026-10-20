---
title: Explicit native disposal requires a confirmed full reset
status: proposed
date: 2026-10-19
pattern: Exact selection and retained unknown outcome
---

# Explicit native disposal requires a confirmed full reset

## Context

[Record 0105](0105-rebuild-modes-and-exact-operation-termination-share-existing-recovery.md) requires an original process receipt to end a held native operation. An opaque restore can leave a closed operator record without a process handle or an original archive cleanup receipt. Normal full rebuild then refuses to remove it. A single run's Kill can remove that run's record while this separate resident hold remains.

## Decision

Keep Kill scoped to one run. Do not use a full resident reset as its automatic fallback. The operator can first inspect a full-reset plan, then select one closed opaque operator restore by its current native key and record hash. The full reset refuses another unresolved native record, active original work, a changed hash, or an uncertain container destruction. It saves the selected original record and its unknown outcome before destruction. Only confirmed destruction permits removal of resident state and backups. After backup cleanup, one storage transaction compares the current record hash and removes that record. A late reply that changes the record before this transaction leaves the changed evidence in place. The audit survives reprovisioning. A prepared audit with an uncertain destroy result refuses a repeat; an interrupted backup cleanup can resume after a confirmed destruction without destroying the new container.

## Consequences

The explicit mode deletes every workspace, thread binding and backup on that resident. It does not prove the original restore ended or repair remote effects. An older Worker cannot run the mode. The deployment fence still refuses until the hold is removed, so a separate qualified installation path is required before this mode can resolve a hold on an older serving Worker.

## Proofs

The [Resident spec](../reference/specs/resident-repos.md) binds the exact selector, full-reset preview, refusal, audit and retry behavior to focused Worker and command tests. Current production deployment and live runtime outcomes need separate receipts.
