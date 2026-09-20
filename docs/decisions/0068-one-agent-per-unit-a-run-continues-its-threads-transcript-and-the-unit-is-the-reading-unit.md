---
title: One agent does a unit of work; a run continues its thread's transcript; a spawned child is a reader; the unit is the reading unit
status: accepted
date: 2026-09-19
pattern: Single-threaded agent per unit of work, the thread's transcript as the unit of context; a state machine between agents, never a model; fan-out only to readers
---

# One agent does a unit of work; a run continues its thread's transcript; a spawned child is a reader; the unit is the reading unit

## Context

[Record 0034](0034-one-agent-per-unit-a-run-continues-a-transcript.md) decided the shape this record restates: the agent that gathered the evidence acts on it, a run seeds from a transcript rather than from a summary another agent wrote, a child a run spawns can only read, and only a state machine sits between agents. Its core shipped and holds. But two of its load-bearing rationales were replaced by later records while it was still `proposed`, so accepting it as written would freeze reasoning the system no longer follows: its review thread per unit — opened so a re-review would not continue the coding session and no round would wipe the coding worktree — was undone by [record 0055](0055-a-unit-has-one-thread-and-a-round-reads-the-checks-at-its-head.md) (a unit has one thread; the session already isolates the transcript and the worktree is released at every run's end), and its resolution trade — the sticky agent re-derived from the thread's newest finished run, the seed-source ladder in the dispatcher's messages stage — was replaced by [record 0057](0057-the-operator-is-the-one-door-a-model-binds-every-chat-input-and-deterministic-code-authorizes-fences-and-executes.md) (one operator turn binds every chat input from the thread's session; deterministic code authorizes, fences and executes but never interprets). Records are immutable, so 0034 is superseded and this record carries forward what still holds, said in the twelve nouns of the [Vocabulary](../reference/vocabulary.md) that [record 0066](0066-a-user-meets-twelve-nouns-and-no-others-the-vocabulary-is-a-reference-page-bound-to-the-code-and-the-consistency-check-fails-a-user-surface-that-prints-an-internal-word.md) fixes.

## Decision

**One agent does a unit of work.** A unit belongs to a pipeline and is worked by one coding agent across its rounds: the run that wrote the code is the run whose thread the findings round continues, with the reasons it had when it wrote it. No round hands a fresh agent a summary of another agent's work, and no code path composes a brief from one coding run's outputs for a later coding run. The reviewer stays a role apart — a review round is its own run — because author-to-reviewer is the one wall human review keeps.

**A run continues its thread's transcript.** A follow-up in a thread starts from what the last run there knew — the thread's own transcript for that agent, plus what was said since — never from a paraphrase or a re-read of the channel's last N replies. The transcript outlives the runs that wrote it ([record 0035](0035-a-session-log-outlives-its-runs-compaction-is-a-pointer.md) decides its store and growth); how an input is bound to the thread's memory is [record 0057](0057-the-operator-is-the-one-door-a-model-binds-every-chat-input-and-deterministic-code-authorizes-fences-and-executes.md)'s.

**A spawned child is a reader.** A run that starts a run hands it a read or none identity: nothing a conductor spawns can push, open or merge. A pipeline's coding and review children are the coordinator's own dispatches under the requester's grants, not spawns, and stay what they are.

**Only a state machine sits between agents.** The pipeline that carries a unit from coding through review, findings and merge is deterministic code that dispatches runs and reads their records; no model turn arbitrates between two agents' outputs.

**The unit is the reading unit.** A unit has one thread ([record 0055](0055-a-unit-has-one-thread-and-a-round-reads-the-checks-at-its-head.md)) and one page: its rounds in order, each round's run expandable to its own timeline; a person reads a unit in one scroll.

## Consequences

What 0034 built stays built and its validation rows stay bound where they landed; what it argued from is split across the records that now own each piece: the one-thread shape and the round verdict in 0055, input binding and the thread-keyed session in 0057, the transcript's store in 0035, the pipeline's plan-shaped input in [0031](0031-the-coordinator-runs-a-plan-not-a-pull-request.md). A reader after the why of a mechanism starts here and follows the owning record; 0034 keeps the full reasoning of its day, superseded, for the history.
