---
title: An advertised run keeps one identity through setup
status: accepted
date: 2026-10-03
pattern: One run from reservation to finish
---

# An advertised run keeps one identity through setup

## Context

The dispatcher exposed a run ID and Live run link before its ledger reservation. An ordinary setup failure then abandoned that reservation and discarded the run, while a separate door record described the refusal. Coordinator children had a same-ID setup finalizer; direct PR review needed the same guarantee.

## Decision

Reserve every fresh run before publishing its registry row and link. Give the row one setup finalizer before publication. If setup ends before the model loop, finish the original run ID through its tracked ledger reservation or the history store when untracked. An untracked reservation omits the Live run link until durable history is proven. Stops keep their stop status; typed capacity endings keep their cause and zero model turns.

Use the run's existing admission clock for a typed fleet refusal during setup. Retry only the identical Worker request that the Worker proved it did not start. A typed seed refusal cannot trigger a fresh checkout. After the model loop starts, the executor uses its ordinary command cap. PR review keeps its exact-head check and names the absence of a verdict or GitHub post in its reply.

## Consequences

- A setup failure appears as the original run with zero turns. It no longer creates a second door record or leaves a dead advertised ID.
- A full fleet can still consume the admitted setup budget. Capacity reclamation remains a separate, owner-checked operation; this decision does not authorize another reviewer or teardown.
- An untracked run may finish through the history store, but its setup link stays hidden because that write has not yet succeeded.

## Alternatives

- Add a direct-review-only finalizer and wait callback: this preserves the split lifecycle for every other run.
- Replay selection, claims, seed, or checkout after a capacity error: those operations may have unknown effects.
