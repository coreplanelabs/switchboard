# Context outcome evaluation

The existing load command scores independently labelled task outcomes from local fixtures or explicitly selected isolated provider trials. Fixture mode makes no provider calls. Context reloads in provider trials are synthetic simulations; they do not establish production harness acceptance or authorize live changes.

- **Code**: `src/load/contextEvaluation.ts`, `src/load/contextEvaluationCommand.ts`, `src/load/contextTrials.ts`, `src/load/contextTasks.ts`, `scripts/load.ts`
- **Tests**: `src/load/contextEvaluation.test.ts`, `src/load/contextEvaluationCommand.test.ts`, `src/load/contextTrials.test.ts`, `src/core/dispatch/handoffBrief.test.ts`
- **Docs**: [Load harness](load-harness.md), [Durable context](../../explanation/durable-context.md)

## Behavior

1. A fixture specifies the task, expected facts and original evidence references, and the exact failed commands the agent must avoid repeating. Its recorded final answer uses structured facts with evidence references. Missing or wrong facts, unsupported claims, repeated failed commands, absent boundaries and incomplete records fail the task separately. A compaction, restart or child handoff is accepted only from its recorded boundary, never from the answer's prose. Forbidden command retries count from the first required compaction or restart boundary through the whole subsequent trace, including calls before later boundaries. Commands in the source history before that first boundary are excluded; child handoff counts its whole child trace. A completed answer must still follow the latest required boundary, and missing boundaries or partial traces cannot pass.
2. Receipts retain the fixture digest, source revision, run and model identities, actual wall time and reported usage. Missing usage or prices remain unknown. Synthetic recordings are labelled synthetic; scoring them establishes the evaluator's behavior, not live model quality.
3. A comparison requires identical labelled fixtures, boundary, model and qualification. A different source revision is expected. Incomparable arms report reasons and no improvement deltas. Every JSON/Markdown receipt is written to a fresh path outside the source tree and contains metrics rather than private answer text. Receipts bind the evaluator revision and loaded source module hashes, including the actual load entry. Baselines require source provenance and their PASS/FAIL labels must agree with their own outcome fields.

Managed compaction and restart trials append an isolated requesting turn after the fixture evidence, then supply its exact request index through a synthetic source-owner descriptor. Earlier evidence keeps its original recall indices and authors. The full simulated checkpoint carries its scope, and the provider receives recovered request context, notes and summary. These records remain synthetic and do not certify a production run.

## Validation criteria

| Criterion | Evidence |
|---|---|
| 1: later compaction or restart cannot erase earlier forbidden retries; source commands before the first required boundary are excluded, child calls count across its entire trace, and missing, partial or unanswered latest boundaries remain refused | `[unit]` `src/load/contextEvaluation.test.ts::context outcome evaluation::counts forbidden retries after the first %s even when another boundary follows`, `::counts every forbidden command on both sides of later compaction`, `::excludes the original source command before the first required boundary`, `::counts the whole child trace without treating child compaction as its handoff boundary`, `::keeps a between-boundary retry when an answer precedes the latest boundary`, `::cannot pass missing or partial boundaries after forbidden retries` |
| Input reads use one opened regular-file descriptor and enforce the 32 MiB limit during reading; pathname replacement cannot switch inputs and growth cannot exceed the budget | `[unit]` `src/load/contextEvaluationCommand.test.ts::context evaluation bounded input::*` |
| 3: the actual load entry returns zero for passing local fixtures, nonzero for failures or incomparable baselines, records source hashes and refuses baseline labels that contradict outcome fields | `[unit]` `src/load/contextEvaluationCommand.test.ts::actual context load CLI::*`, `::context evaluation baseline integrity::*` |
| 1, 2: simulated context trials read original recall results, keep labels out of model requests, preserve source boundaries and cap turns without inventing usage | `[unit]` `src/load/contextTrials.test.ts::local context task trials::*` |
| 1: wrong corrections, unsupported claims and repeated failed commands fail independently; absent boundaries and partial records cannot pass | `[unit]` `src/load/contextEvaluation.test.ts::context outcome evaluation::*` |
| 2: token counts, cost and wall time come from the record, missing metrics stay unknown, and receipts bind source and fixture digests | `[unit]` `src/load/contextEvaluation.test.ts::context outcome evaluation::*` |
| 3: comparable arms report outcome and cost deltas; changed fixtures, models or qualifications refuse deltas | `[unit]` `src/load/contextEvaluation.test.ts::context outcome comparison::*` |
