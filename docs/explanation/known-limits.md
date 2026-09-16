# Known limits

What is deliberately off, narrow on purpose, not yet proven, or a known wart, so an absence or a stray error is not mistaken for a bug.

## Off until you turn it on

- **Run history, the run ledger and memory** ([decision 0017](../decisions/0017-memory-off-by-default.md)). Without their config blocks: runs are live-only and vanish a minute after finishing; a restart loses a run in flight; model input is identical to a build without memory.
- **Execution is `local` by default**: right for one developer, wrong once untrusted users arrive ([Execution and trust](execution-and-trust.md)).

## Narrow on purpose

- **Self-improvement proposes, never fixes.** Its only side effect is a labelled issue.
- **No per-run cost accounting.** The cost-spike proxy is a run at twice the median time.
- **`review` is read-only by convention.** The hard boundary is the execution plane.
- **DM scopes** are the manifest's choice.
- **The friction ledger is run history.** `friction report` and `friction propose` see only what `runHistory` retains.

## Not yet proven

- **The E2B path**: unit-tested, no live procedure.
- **Per-PR docs previews**: CI builds the site on every PR and publishes nothing.
- **Resident `[gap]` rows**: cross-repository token scope; a push from a resident thread.
- **Run history `[gap]` rows**: a summary-only friction read; a full-scan listing.

## Known warts

- **A plan runner that outlives a bot deploy ends with one runtime error.** The Workflows engine pins the instance to the Worker version it started on and wakes it on the current one; when that wake completes the plan, the runtime cancels the `ShipCoordinator.run` call as "hung" one millisecond after recording the instance's end. The unit report, the card, the parent run record and the instance's status are all complete — read that error on a finished instance as this, not as a stuck runner. An instance that starts and ends on one version never logs it.

Complete list: the specs' [`[gap]` rows](../reference/specs/README.md); switches: [Turn features on and off](../how-to/turn-features-on-and-off.md).
