# Pull requests

The pipeline owns the pull requests its live runners are still driving. Operator sweeps recover the pipeline's open pull requests only when no runner currently owns the rebase boundary.

- **Code**: `src/core/pullSweep.ts` (`PullSweepService`, the ownership deferral and runner mode), `src/core/pullSweepWiring.ts` (the shared ownership fence and sweep effects)
- **Tests**: `src/core/pullSweep.test.ts`, `src/core/pullSweepWiring.test.ts`
- **Docs**: [agent-ship.md](agent-ship.md) items 9 and 20

## Behavior

1. **One rebase owner.** A `pulls rebase` sweep defers a pull request owned by a live pipeline runner without touching git or spending the sweep's model-round flag. The runner invokes the same git-first resolver in runner mode: an unchanged patch carries approval, a changed patch returns to the runner's review loop, and a conflict returns to that runner's lease-bounded coding round. “Rebase it by hand” remains only for an unowned pull request whose sweep model round was already spent.

## Validation criteria

| Criterion | Proof |
|---|---|
| 1: a sweep on a runner-owned pull request defers without touching git | `[unit]` `src/core/pullSweep.test.ts::the sweep — one line per pull request, in user words::a pull request owned by a live pipeline runner defers to that runner instead of spending the sweep's fix path` |
| 1: runner mode carries an unchanged approval, reports a changed patch for re-review, and returns a conflict to the runner | `[unit]` `src/channels/adminCoordinator.test.ts::POST /admin/coordinator/merge — the runner's squash of a unit's pull request (item 9)::the runner's rebase route maps the shared resolver's clean carry, changed patch and conflict outcomes` |
