---
title: Retain exact review feedback with the publication owner
status: accepted
date: 2026-10-14
pattern: Transactional receipt and replaceable snapshot
---

# Retain exact review feedback with the publication owner

## Context

Native review reactions can change or disappear. Sampled run telemetry cannot reconstruct their exact current counts. Run records can be pruned before the feedback reporting window ends. Publication already has an original owner, a pending receipt and a durable acceptance boundary; a second publisher would weaken that boundary.

## Decision

Retain a compact copy of the accepted receipt in the same transaction as the original owner's matching pending-to-accepted transition. That row is both the retained repair source and the feedback index. It does not need an asynchronous projection or another outbox. Native identity is unique per repository and review; acceptance without optional native identity remains an explicit tracking gap. Ordinary run deletion does not delete the compact receipt.

The existing state Worker owns the receipt, current reaction snapshot, collection lease and shared rate-limit cooldown. The bot reads GitHub through its trusted credential boundary. It fetches all reaction pages and verifies repository, PR, review, head and body before replacing votes. Incomplete reads preserve the previous complete snapshot. Lease generations refuse late overlapping writes. Reporting enforces 90-day retention; physical cleanup follows the existing maintenance gate.

Weekly cohorts use publication time and format. Their current ratings can change when a person adds or removes a reaction. They are not historical scores observed in those weeks. Unknown actors, ambiguous votes, stale snapshots and missing identity remain visible rather than entering a usefulness ratio.

## Consequences

No extra Worker, publication, schedule, webhook or model run is required. Snapshot collection and reporting failures cannot change a verdict or trigger another publication. The compact retention write belongs to the existing required acceptance transaction: if that transaction fails after GitHub accepted the review, the existing uncertain/no-repost behavior still applies. This is not a promise that required journal failures are harmless.

The additive state reader must deploy before the new receipt writer. Disable collection for rollback; an older binary with a strict receipt decoder is not a safe rollback target for new receipts. Legacy publications remain outside the tracked cohort. A configured App-token read and native reaction add/remove acceptance still require deployed proof.
