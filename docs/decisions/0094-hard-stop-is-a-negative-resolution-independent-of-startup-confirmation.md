---
title: Hard stop is a negative resolution independent of startup confirmation
status: accepted
date: 2026-10-08
pattern: Fenced cancellation and retained evidence
---

# Hard stop is a negative resolution independent of startup confirmation

## Context

Startup may commit a run and its input before confirmation completes. Retaining uncertain input prevents unsafe execution, but requiring startup success before cancellation leaves failed runs active indefinitely.

## Decision

Hard stop may create a separate cancellation reservation on the exact existing run. The reservation fences further execution writes and ownership transfer. Runtime shutdown uses that reservation and the original binding: destroy a dedicated sandbox or kill only the registered resident user's processes. Unknown shutdown keeps the reservation pending.

After acknowledged shutdown, store a `stopped_hard` record with the cancellation requester and runtime disposition. This negative outcome supplies no startup confirmation, source release, review verdict or preservation claim. Original bodies, receipts, steps, inbox and jobs remain available as evidence. Mark an unconfirmed source cancelled in its existing carrier so it cannot be confirmed or reused as an acknowledged source; a distinct subsequent request may claim the session independently.

Both store implementations use the same cancellation identity rules. Worker shutdown routes verify the exact pending reservation and binding with the state store. Missing, stale or foreign evidence refuses shutdown. Lost terminal replies reconcile by reading the exact cancellation record; no model or startup mutation is replayed.

## Consequences

The existing hard-stop control can close failed startup runs as well as active runs. Runtime failure remains visible as an unconfirmed cancellation rather than a false successful kill. Dedicated sandbox workspaces are discarded; resident process termination retains the thread's files and UID spend history. Local and unsupported runtime backends retain their existing stop path.
