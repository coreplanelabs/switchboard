---
title: The dispatch pipeline as built, and the 800-line cap that keeps it that shape
status: accepted
date: 2026-09-09
pattern: Pipeline (Pipes and Filters) with Interface Segregation — the as-built record
---

# The dispatch pipeline as built, and the 800-line cap that keeps it that shape

## Context

[0024](0024-dispatcher-as-a-staged-pipeline.md) decided to split `dispatch()` into the pipeline it already was, one tidying at a time, and named a target table: one file per stage under `src/core/dispatch/`. The series that carried it out — six pull requests for the stages, then the ship-pipeline, run-registry and Slack/config seams, then the closing tidy that added the settle stage — landed the pipeline, but not exactly that table: two stages needed a second file to stay under the size the series worked to, the follow-up settlement turned out to be a stage of its own, and the ship fork moved as planned. Records are immutable, so 0024's table stays as written; this record is the as-built one, and the rule that keeps the shape from drifting back.

## Decision

**The stages, as built.** Each stage is one or two files under `src/core/dispatch/`, exporting its functions, its `<Stage>Context` types and the slice of `CoreDeps` it reads; `CoreDeps` extends every slice. Line counts are at the head this record was written at.

| Stage | Files | Lines | Slice |
|---|---|---|---|
| admission | `admission.ts` (the thread: `admit`, `adoptCarriedRun`, `foldCarriedInbox`), `fastPath.ts` (what answers before any model turn: `answerChatCommand`, `answerOperation`) | 522, 369 | `AdmissionDeps`, `FastPathDeps` |
| resolve | `resolve.ts` (`readRequest`, `resolveRun`, `resolveTarget`) | 157 | `ResolveDeps` |
| authorize | `authorize.ts` (`authorizeAgent`, `authorizeRepo`, `authorizePrHead`, `authorizeAttachedHead`) | 281 | `AuthorizeDeps` |
| provision | `provision.ts` (`startMemoryRead`, `openAckCard`, `registerRun`, `reserveRun`, `attachWorkspace`, `composePrompt`), `messages.ts` (`buildMessages`, `turnContent`, `contextMessageTexts`) | 737, 125 | `ProvisionDeps` |
| run | `run.ts` (`claimRun`, the tools' capabilities, the shutdown notice), `runLoop.ts` (`runLoop`: the model turn and everything that rides on it, through the finish) | 260, 713 | `RunDeps` |
| reply | `reply.ts` (how a run is shown; `deliverAnswer`, `afterReply`) | 589 | `ReplyDeps` |
| record | `record.ts` (`assembleRunRecord`, `writeTombstone`, `registerFinishRecord`, the drain's and the reclaim's records) | 413 | `RecordDeps` |
| ship (a branch, not a stage) | `ship.ts` (`runShipBranch` over `ShipContext`) | 541 | `ShipDeps` |
| settle | `settle.ts` (`settleThread`, `tellDropped`, `prepareFreshTurn`) | 126 | (`AdmissionDeps.admission`) |
| the shell | `src/core/dispatcher.ts` (`CoreDeps`, `DispatchOptions`, `dispatch()`: the root, the refusal wrap, the stage calls, the outer catch and finally) | 773 | — |

Where this differs from 0024's table: `run` is two files (the loop alone is over 600 lines), `provision` is two (the conversation helpers are a unit the ship branch shares), `admission` is two (the fast paths answer before the thread is claimed), and `settle` is a stage 0024 folded into "the shell". The recursion for a fresh turn stays a real call to `dispatch()`, made by `dispatch()`.

**The cap.** No source file under `src/core/` is over 800 lines. The measure is `wc -l`; the check is

```sh
find src/core -name '*.ts' ! -name '*.test.ts' ! -path 'src/core/testing/*' -exec wc -l {} +
```

and a file that crosses the cap is split by a named refactoring (Move Function, Extract Function, Extract Class) in the pull request that would cross it — never by a rewrite, and never by squeezing lines. At this head the largest are `src/core/costs.ts` (785), `src/core/dispatcher.ts` (773), `src/core/dispatch/provision.ts` (737), `src/core/runLedger/writeThrough.ts` (720), `src/core/dispatch/runLoop.ts` (713).

**The exemptions.** Test files (`*.test.ts`) are not capped: a test file is as long as the behaviors it proves, and splitting one by size scatters a suite. The two conformance fixtures under `src/core/testing/` — `conformanceFixture.ts` (1,063) and `commandConformance.ts` (974) — are data, not design: one is the fixture table every command × argument × surface is checked against, the other the harness that walks it. They are exempt by path.

## Consequences

- A reader finds a stage by its name, and a stage's tests beside it; a behavior proven through `dispatch()` stays in `dispatcher.test.ts` (0024's rule, unchanged).
- The cap is a rule a reviewer applies, not a CI gate: the number is a smell threshold, and the fix it asks for is a design step (what concern stands apart?), which a gate cannot make. If the cap is crossed twice without a split, it becomes a check under `verify`.
- 0024 is superseded by this record for the table only; its method (Tidy First, one named refactoring per commit, dependency slices, handles handed back before the next throwable await) is unchanged and still governs any further split.

## Alternatives rejected

- **Editing 0024's table in place** — records are immutable ([0021](0021-records-are-immutable-specs-are-checked.md)); a body that changes stops being a record of what was decided when.
- **A hard CI gate on 800 lines now** — a gate would have blocked the `run` stage's own extraction (933 lines before its split) at the wrong moment; the rule is applied at review, with the threshold named here so it is not a matter of taste.
- **Capping test files too** — `dispatcher.test.ts` is 10,000 lines because it proves the pipeline end to end; the direct stage tests sit beside the stages and the end-to-end suite stays whole.
