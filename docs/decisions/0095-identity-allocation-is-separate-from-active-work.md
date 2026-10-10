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

## Amended 2026-10-09

*Re-evaluation.* The separate active-owner limit remains sixteen. A fixed thirty-two-identity roster can still refuse new work after completed owners consume it, even when the VM has spare workload capacity. Raising that roster only delays the failure.

Provision unprivileged accounts on demand instead. Reserve a monotonic numeric identity and its exact owner in a storage transaction before native account creation. Indexed ownership reads avoid scanning historical accounts at each shell authorization or admission. Upgrading skips every precreated legacy account for new owners, even if its spend row is absent; confirmed VM destruction resets usage while preserving allocation high-water and surviving binding identities. Preserve legacy ownership, launch fences, cancellation and publication evidence. Unknown creation outcomes keep their native-operation holds and cannot transfer an identity.

The new image declares its provisioning protocol; that capability alone cannot clear a pending image-deployment report. Linux UID bounds, actual disk and memory pressure and lifecycle preservation still apply. This removes the small historical-owner admission cap; it does not increase concurrent work or authorize resetting a busy VM.

Once indexed identities have been issued, an old Worker cannot read their ownership. Prefer a forward fix. A downgrade requires a coordinated, guarded VM reset after preserving or discarding each workspace under its existing owner; changing the image alone cannot make old allocation safe.
