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

## Amended 2026-10-22

The one-record rule protects exact selection, unknown outcomes and the original archive evidence. It does not handle two closed opaque restores on one resident: neither single-record selector can pass the other hold. Keep the same full-reset boundary and allow a complete set of two to 64 exact key and hash pairs. The Worker rejects any omitted, duplicate, changed or ineligible record before destruction. It writes all prepared audits in one storage transaction, confirms one runtime destruction, and writes all destruction audits in one transaction. The hardest race is a late original restore reply during backup cleanup. The final transaction compares every selected record and removes the set only when all hashes still match; one changed record leaves the whole set in place. An uncertain destroy or mixed audit state still refuses a repeat. This extension retains the original reason for the decision: no result is credited to an opaque restore, and no runtime evidence is deleted without confirmed destruction.

## Amended 2026-10-23

The complete-set guard can meet a closed refresh fetch beside a closed dependency restore. The fetch can retain an opaque native effect with no process handle or restore identity. A process Kill has no identity to target, and the journal does not identify the action or destination. Admit that fetch only inside a complete set through a new explicit unknown-effect selection that quotes its original build and exact key and hash. The Worker checks the selected build, system `refresh-step`/`fetch` origin, resource, one pending opaque non-restore effect, and the embedded scope against the original closing scope row. Every other opaque non-restore record stays ineligible. This is deliberate disposal of unknown evidence after a full resident reset, not proof that the fetch effect was local or ended. The reset still requires the complete exact set, confirms container destruction, and retains each original and its unknown-effect selection in the audit. After backup cleanup, one transaction checks all selected hashes and the whole unresolved count, so a late reply or new record leaves the set in place. The original reason for the decision still applies: no unknown result is credited, and no resident state is removed without confirmed destruction. A remote effect may survive, and a separate deployment permit remains a separate obligation.

## Consequences

The explicit mode deletes every workspace, thread binding and backup on that resident. It does not prove the original restore ended or repair remote effects. An older Worker cannot run the mode. The deployment fence still refuses until the hold is removed, so a separate qualified installation path is required before this mode can resolve a hold on an older serving Worker.

## Proofs

The [Resident spec](../reference/specs/resident-repos.md) binds the exact selector, full-reset preview, refusal, audit and retry behavior to focused Worker and command tests. Current production deployment and live runtime outcomes need separate receipts.
