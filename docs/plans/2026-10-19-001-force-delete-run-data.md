---
title: Delete one run's stored data without a shutdown receipt
status: proposed
date: 2026-10-19
---

# Delete one run's stored data without a shutdown receipt

Adopt a separate destructive `runs delete <id> --force` command before implementation review. This record is for an engineer who knows distributed storage but has not read the run controls. The requested outcome is to remove one selected run from stored run views even when its original runtime cannot be verified.

## Decision

Use the existing deletion fence and store boundary to remove one run's data. Force deletion is a data operation. It does not call a runtime, produce a terminal result, release a Resident hold or certify that work stopped. This costs the selected run's recovery data. It buys a repeatable operator control without converting missing shutdown proof into a false success.

## Today at `4be70afcb`

| Fact | Source |
| --- | --- |
| Kill requires shutdown proof before destructive history deletion. | `src/core/runsService.ts`, `stopRun` |
| History deletion refuses any current live row, even with `destructive: true`. | `deploy/cloudflare-memory/worker.ts`, `RunHistoryDO.delete` |
| The deletion fence rejects subsequent history puts and same-ID claims. | `RunHistoryDO.put` and `claim` in that file |
| The legacy private transcript has its own object; current transcripts live in shared session logs. | `RunTranscriptDO`, `SessionLogDO` in that file |
| Session rows have indices, but no durable per-row run owner. A run can inherit and rewrite earlier turns. | `SessionLogDO.write`, `turns` schema |

## Shape

This is a tombstone-based delete, like deleting a document while rejecting delayed writes for its old identity. Reuse the ordinary run permission check, destructive confirmation, history store and cross-process deletion feed. Require the operator's `runs:write` grant; the ordinary ability to stop one's own run does not grant force deletion.

The store takes `force: true` only together with destructive deletion. The history object's first transaction saves a small identity and session-key receipt, writes the existing run-ID deletion fence and removes the live row and its queued work. This is the write barrier: ordinary claims, puts, event appends and same-ID queue admission cannot recreate the run. The receipt permits a later command to authorize the same selected run even after ordinary readers return not found.

The controller then revokes that run in each named shared session and permanently clears its legacy private transcript. Session revocation retains all existing conversation text, removes an owner only when it is the deleted run, refuses a delayed owner assignment for that run and requires exact run identity on later writes. This requirement also prevents an old generation-only write from borrowing a newer run in the same process generation. The final history transaction deletes the remaining directly owned data and sets the force-completion receipt. A failed cross-object call leaves deletion incomplete; a later authorized command resumes the same idempotent cleanup. An ordinary Kill marker cannot prove this completion.

The bot reuses the existing deletion feed. That feed requests local producer cancellation when it observes a removed run, but this command never calls the runtime shutdown service or certifies a physical ending. The bot drops its display row only after an acknowledgement or a force-specific completion read. The response lists retained shared conversations, runtime custody, deduplication, external output, metrics and backups.

## One late-write trace

1. The operator confirms deletion of run A. Run B shares its conversation.
2. The history transaction saves A's non-content identity and session keys, writes A's deletion fence and removes its live owner and queue entries.
3. A delayed event append and same-ID admission see the deletion barrier and refuse. Shared-session revocation refuses A's delayed owner assignment without removing B's owner or text.
4. A's legacy transcript receives a permanent deletion marker and removes its messages, attachments and owner.
5. The final transaction removes A's saved record, events, positive checkpoints, inbox, delivery rows, jobs, pending effects, logical ending and event revision. It removes A's history-reference links and marks force deletion complete.
6. A lost reply is reconciled against that force-completion receipt. If a cross-object reply failed earlier, the next authorized command uses A's saved identity and resumes cleanup instead of reporting completion.

Negative checkpoints and separate native/workspace custody records remain held. Deletion does not establish that A's original work ended.

The receipt contains only run ID, requester ID, channel ID, channel visibility and optional repository, plus at most four distinct session keys from the live and saved metadata. The command runs the current `runs:write` policy against that identity on every attempt, so a revoked grant refuses a retry. The identity and ordinary deletion fence commit together before the first asynchronous call. Claims, including attaching-row promotion, check that fence; finish rechecks the live row. Thus a later canonical session assignment cannot expand the captured set. Unknown legacy session data stays in the retained shared-data scope rather than being described as erased.

## Where mistakes matter

1. **Concurrent writers and deletion.** The history object's owner check and each event append commit without an intervening asynchronous call. The delete transaction removes the live owner and writes the history tombstone together. An append that commits first is erased by deletion; an append that runs later sees no owner. Any path that awaits between checking ownership and writing must recheck inside its committing transaction. The verification must include append and same-ID claim after deletion, not only history put. Per-run event count is not the batch bound: SQL deletes use the indexed run ID and do not load events into memory. Actual service latency remains a deployment validation gap.
2. **Deleting another run's bytes.** A shared session is not a per-run database. Do not clear it, infer row ownership from an open range, or recursively delete children. The command result names retained shared session data. Adding exact historical row provenance is separate work.
3. **Recreating removed data.** Preserve the existing history tombstone and add a permanent legacy-transcript marker. Do not implement transcript clearing as a reset that accepts a new owner later. The HTTP acknowledgement must echo `force: true`. A client rejects an older server's ordinary deletion response even if it says `ok`.
4. **Losing a partial result.** Save the identity and deletion barrier before cross-object cleanup. A failed transcript acknowledgement leaves an incomplete receipt available for a later authorized deletion. A lost history acknowledgement is reconciled through the force-specific completion read; no runtime action is replayed.
5. **Freeing an unknown runtime.** Native claims, original process receipts, workspace custody and deployment holds retain their current owner. Removing a run row cannot establish that those obligations ended.

## Scope of deletion

The command deletes directly owned run records in the live ledger, saved history and legacy private transcript. Its response explicitly reports retained shared session logs, original runtime custody, source deduplication and ingress records, external output, metrics and backups. It is not a privacy-erasure guarantee for every copy of a run's text. A command described as removing all data must not silently delete other runs' shared logs or report those retained copies as erased.

## Alternatives

**Why not force Kill?** Kill's success means shutdown plus deletion. A data-only exception would weaken that contract. **Why not abandon then delete?** Abandon is for an unstarted reservation and carries different custody semantics. **Why not keep the whole original row as a hidden tombstone?** That retains prompts, checkpoints and other recovery content the operator asked to remove. The receipt keeps only the attributes needed to recheck current authority and finish the same cleanup. **Why not reset the installation?** That removes unrelated runs and services. **Why not delete the whole conversation?** Shared rows can belong to other runs; there is no per-row provenance with which to make that target selection.

## Validation and release

Tests must exercise the registry command, Worker HTTP route and real SQLite objects. Prove exact-target deletion, unrelated-row retention, authorization refusal, unchanged ordinary Kill behavior, stale writer refusal and response-loss reconciliation. Local proof precedes native PR review and CI. Memory must serve the new capability before Bot exposes the new command; an older Memory response must not be accepted as a force-deletion receipt. Deployment and execution against selected production IDs remain separate receipts.
