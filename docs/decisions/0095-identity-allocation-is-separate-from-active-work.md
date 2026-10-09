---
title: Identity allocation is separate from active work
status: accepted
date: 2026-10-08
pattern: Separate identity and resource budgets
---

# Identity allocation is separate from active work

## Context

A resident UID stays with its first owner until confirmed VM destruction. The spent count includes ended owners and therefore cannot measure concurrent work. Expanding the UID pool alone also expands admission to the same fixed-size VM.

## Decision

Keep a separate limit of sixteen active owners per resident. Preserve the thirty-two-identity pool as historical headroom; it does not promise thirty-two concurrent workloads. Retain the six-repository fleet cap and the existing VM size.

Admission reserves one owner under a shared short lock before clone or command execution. The long operation runs outside that lock. A successful attach records its durable registration before releasing the provisional reservation. An exact existing owner reattaches without acquiring another slot.

Use the existing fenced ownership classification. Verified terminal owners whose files remain retained consume disk, not an active-work slot. Live or unknown owners remain occupied. Native operation records and processes still running under spent UIDs also remain occupied, including after an isolate reset. Duplicate records for the same owner count once. Disposable operator commands keep a durable capacity marker until their native outcomes are acknowledged; this marker supplies no run ownership or preservation authority.

Keep disk, memory, publication and cleanup checks independent. A workload refusal permits the existing fallback path but never authorizes UID transfer, file removal, ledger reset or VM replacement.

## Consequences

Historical identities do not silently increase the VM workload budget. Owner uncertainty and unacknowledged commands can still refuse new work; they require evidence rather than an expiry guess. This first change retains a finite image-provisioned UID pool. Dynamic user provisioning and ownership storage need separate qualification before identity allocation can grow without this fixed pool boundary. No clustering or larger VM is introduced.
