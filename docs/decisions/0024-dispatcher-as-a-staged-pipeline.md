---
title: The dispatcher is a pipeline of stages, split one file move at a time
status: superseded
date: 2026-09-09
pattern: Pipeline (Pipes and Filters) with Interface Segregation, by Tidy First
superseded_by: 0025-dispatch-pipeline-as-built.md
---

# The dispatcher is a pipeline of stages, split one file move at a time

## Context

`dispatch()` is the one place an agent run starts ([0002](0002-dispatcher-is-the-only-orchestrator.md)), and everything a run needs to be consistent across surfaces was written into it: the chat fast path, thread admission, directive and configuration resolution, the permission gates, the ack card, the workspace attach, the prompt, the run loop, the reply, the record. That made `src/core/dispatcher.ts` the largest module in the core by a factor of four — one function of two thousand lines, forty-odd top-level helpers around it, and a `CoreDeps` bag of thirty fields that every helper takes whole.

The file already reads as a sequence of stages; its own comments name them. What it lacks is a boundary between them: a reader who wants the record's shape reads past the run loop to find it, a test of one stage imports the whole module, and a stage cannot say which three dependencies it uses because it is handed all thirty.

Splitting a function this central is the riskiest edit in the tree. A rewrite would trade a known shape for an unknown one; the tests would pass and the behavior would still have moved somewhere no test looks.

## Decision

`dispatch()` is treated as the pipeline it already is, and split into that pipeline one tidying at a time.

**The stages**, in the order a request meets them, each becoming one file under `src/core/dispatch/` that exports the stage's functions and types:

| Stage | What it owns | Reads off `CoreDeps` |
|---|---|---|
| `admission` | The chat-command fast path and its inline runs; thread admission — claim, steer, refuse; the boot-gap steer to a run on another generation; adopting a resumed or restarted run and its durable inbox | `commands`, `admission`, `runLedger`, `threadsElsewhere`, `config`, `runRegistry`, `runHistoryWriter`, `clock` |
| `resolve` | Directives, thread stickiness, the layered configuration → the agent, model and effort of this run; the target repository, ref and pull request | `config`, `providers`, `resolveRepoContext` |
| `authorize` | The agent gate against the resolved agent, the live-agent gate on a steer, the repository gates (not onboarded, unverified, access), the pull-request head preflight and the attached-head guard | `config`, `capabilities`, `fetchPrHead` |
| `provision` | The ack card and its heartbeat, the reservation and the registry row, the workspace attach, the memory read, MCP discovery, the prompt blocks and the system prompt, the conversation | `config`, `dataDir`, `memory`, `mcp`, `skills`, `capabilities`, `residentFleet`, `runRegistry`, `runLedger`, `statusUpdateMinMs` |
| `run` | The tombstone and the ledger claim, the card frame the loop paints, the agent loop, the reviewed-head settle, the coding post-step and the description turn | `providers`, `runRegistry`, `runLedger`, `runHistoryWriter`, `skills`, `githubApi`, the GitHub seams |
| `reply` | How a run is shown: the run label, the humanized request text, the card's activity and close lines, the live-run link, the one error shape, a command reply that outgrows a message; the finish-to-reply sequence and the follow-ups a run leaves behind | none for the pure part; `postReviewComment`, `memory`, `providers` for the rest |
| `record` | What a run leaves behind: the channel-visibility stamp and the one `RunRecord` assembly — at finish, for an inline command, for a run the drain abandons, for a run a booting generation reclaims | `channelDirectory`, `channelDirectoryTimeoutMs` (`RecordDeps`) |

The `agent:ship` fork is a branch of this pipeline, not a stage; it moves as `dispatch/ship.ts` in its own step.

**The method** is Tidy First: every step is a structural change with no behavioral change, so it is reviewable by its shape alone. Each move is named by its entry in the refactoring catalog in the commit that makes it — *Move Function* for a helper that already stands on its own, *Extract Function* for a stage still inline in `dispatch()`, *Extract Interface* for the dependency slice a stage declares. A behavioral change that turns out to be needed is its own commit, before or after, never inside a move.

**The dependencies** are segregated: a stage file declares the slice of `CoreDeps` it reads (`RecordDeps`, and so on), and `CoreDeps` extends every slice. A caller's shape never changes; a stage's signature says what it actually uses.

**The order of the moves** is by cleanliness, not by position in the pipeline. The helpers that already stand outside `dispatch()` — the reply and record stages — move first as pure file moves. The stages still inline — admission, resolve, authorize, provision, run — each need an *Extract Function* over the closure state they share, and each gets its own step with its own test run.

**Acceptance** for every step is the four rules of simple design and one measurement: the suite passes with the same count, the conformance snapshot is unchanged except for moved files, no export is renamed without every importer moving with it, and no file under `src/core/` ends the series over about eight hundred lines.

## Consequences

- `dispatch()` keeps its one entry point and its one authorization gate; the split changes where the code is read from, not what runs.
- A stage is testable and readable on its own, and its dependency slice is its documentation.
- Spec proof bindings move with the tests they name, in the same commit — `specs:check` refuses a stale one.
- Line count is not the goal; a stage is done when it has one exported function and its types, and the whole is still the pipeline's order.
- Until the series ends, the tree holds both shapes: stage files beside a `dispatch()` that still runs the inline stages. Each step leaves it consistent; the code map names what has moved.

## Alternatives rejected

- **One rewrite into a `Pipeline<Stage>` runner.** The most elegant end state and the least reviewable path to it: a two-thousand-line diff whose correctness rests on the suite alone, for a function whose closure state (the card, the reservation, the admission slot, the run handle) is exactly what the suite exercises indirectly.
- **A class per stage with a shared context object.** A `DispatchContext` with thirty mutable fields is `CoreDeps` again, plus the run's state, plus lifecycle; it trades one long function for one wide object.
- **Leaving it.** The file works. It is also the place a newcomer stops reading and the place every feature adds fifty lines; the cost is paid on every change.

## Pattern

Pipeline (Pipes and Filters) behind the single entry point that [0002](0002-dispatcher-is-the-only-orchestrator.md) fixed, with Interface Segregation for what each stage depends on, reached by Tidy First: structure first, behavior never, one named refactoring per commit.
