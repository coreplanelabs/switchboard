---
title: A run outlives the container through a leased, fenced ledger with a write-ahead step record
status: implemented
date: 2026-09-08
pattern: Lease with a fencing token
---

# A run outlives the container through a leased, fenced ledger with a write-ahead step record

## Context

Under the two-lives design ([0006](0006-runs-have-two-lives.md)) a run in flight during a restart was gone: its card froze, its transcript vanished and the caller waited forever. The release pipeline compensated with a gate that refused to roll the bot over while any run was live. The gate cost users nothing and cost releases a wait that stretched to hours of self-redispatch on a busy bot, and it was the only thing standing between a rollout and a killed run.

## Decision

A run outlives the bot container. A rollout or a hard kill neither loses a run nor freezes its card: the next container resumes the run from a durable ledger, or closes it as `interrupted` with its full transcript. The run index, run pages, stop requests and thread admission all read that one ledger across container generations.

Mechanism:

- **A lease with a fencing token.** The container's generation (`startedAt` plus a random suffix) is sent with every owner write; the ledger refuses a write from a generation that no longer holds the lease, so a zombie old container can never overwrite a run the new one resumed. Lease thirty seconds, heartbeat ten.
- **A write-ahead step record.** Every tool call is named durably before it runs, so a resume knows what may have had effects.
- **An append-only transcript** in a per-run Durable Object, flushed every half second or thirty-two events, so transcript bytes never queue behind an admission decision in the index object.
- **Compare-and-swap phases** `live → finishing → finished` and `live → handoff`. Live runs never enter the finished table, whose columns are non-null for finished facts and whose `finished_at` drives retention. A run's finish writes the finished record and deletes the lease in one transaction, which is why there is one index object and not two.
- **Admission** becomes `thread_key UNIQUE` on the live-runs table ([0011](0011-thread-admission-one-live-run.md)).

Guardrails the design refuses to cross: no secret moves out of the process that holds it; no resume re-issues a command whose effects are unknown (a `git push` in flight at the kill must never run twice); at most one awaited round trip per step on the hot path; no edit to a transcript the model has already read.

A resume is a valid continuation, not a byte-identical request across a code deploy. A transcript that cannot be stored closes the run `interrupted` at reclaim rather than being trimmed.

With this in place the release pipeline's bot gate became a warning ([0015](0015-deploy-order-deployed-is-not-live.md)).

## Consequences

- Releases no longer wait for a quiet bot, and a kill mid-run produces a resumed run or an honest `interrupted` record, never a frozen card.
- Every owner write carries the generation, and every step pays one durable write before it runs. The budget is one awaited round trip per step.
- The two-lives shape is unchanged: the ledger is the live store, and the finished record is still written once at the end.
- Idempotent replay of a tool result after a kill is not built. A step whose effects are unknown at resume is reported, not re-run.

## Alternatives rejected

- **A Durable Object per run.** Deferred with the full argument in [0016](0016-long-lived-process-not-serverless.md).
- **Quiescing the bot before a rollout.** Makes users wait for the deploy.
- **Reconstructing the transcript from the event stream.** Events omit tool inputs and cap outputs.
- **Replacing the whole transcript array per step.** Re-uploads the transcript every step.

## Pattern

Lease with a fencing token (Kleppmann); write-ahead step record; Memento for the resumable state; compare-and-swap phases; Null Object for the off-state.
