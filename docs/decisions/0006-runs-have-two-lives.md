---
title: A run has two lives, a live registry and then a history record, behind one read service
status: implemented
date: 2026-09-08
pattern: Two stores, one facade
---

# A run has two lives, a live registry and then a history record, behind one read service

## Context

A run in flight needs a live page, a server-sent event stream and a stop control, all updated many times a second. A finished run needs a durable record that outlives the container, is listed on an index and is subject to retention. Those are different access patterns with different costs, and putting every live event through a durable write would tax the hot path for the benefit of a record nobody reads until the run is over.

## Decision

A run has two lives backed by two stores, and one `RunsService` fronts both: it reads the live registry first and falls through to the history store.

**Live** is an in-memory, bounded, TTL-evicted registry gated by a per-run capability token ([0013](0013-capability-tokens-for-live-run-pages.md)). Its events never touch a durable store.

**Finished** is one record written after the reply has been attempted, so a slow or failed history write never delays or breaks the user-visible answer. The write is fire-and-forget with bounded retries, and the shutdown drain waits for exactly that queue. Retention applies whichever of `retentionDays`, `maxRuns` or `maxBytes` bites first, through one retention function shared by the bot and the Worker with no Node imports and an injected clock.

The record is tombstone-first: a provisional record with `status: interrupted` and `finishedAt = startedAt` is written at start and replaced whole at finish. After a crash nobody knows the real death time, so the tombstone keeps the start time, and because it is already terminal no next-container reconciliation is needed. A final write for the same id stands down any provisional write still queued.

A run ends in two moments. `finish` records that the agent stopped: the `finished` frame goes out and content events stop, though span records keep publishing. `seal` records that the stream closed: the first reply attempt completed or the branch was abandoned, the `end` frame goes out, subscribers detach, and the eviction TTL runs from `sealedAt`. A finished run that is never sealed is swept after a fixed hold.

## Consequences

- The live page and its stream pay no durable-write cost per event.
- A run in flight during a restart was genuinely gone under this design. That was acceptable for a chat assistant and unacceptable once runs took minutes and rollovers were routine, which is what [0019](0019-durable-run-ledger-resume-after-kill.md) addresses without changing the two-lives shape.
- When run history is turned off the index says so rather than pretending history exists. It is a real choice, not a degraded fallback.

## Alternatives rejected

- **Writing the record at finish and patching it after the reply.** Two writes with a window in which the record claims the reply happened before it did.
- **Every event durably.** The hot path pays for a record read once, later, by a human.

## Pattern

Null Object for the off-state; Collecting Parameter for the pending seals and records; Unit of Work for the shutdown drain that flushes them in order.
