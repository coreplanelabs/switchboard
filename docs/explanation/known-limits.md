# Known limits

What is deliberately off, narrow on purpose, or not yet proven, so an absence is not mistaken for a bug.

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
- **A pi run across a bot restart**: proven live — the bearer adopted, a whole log across a second restart, a run re-attached in the middle of a command with its calls in flight answered by restart notes, the resident's tree kept. Proven by tests only, so far: the re-read of pi's log from the last turn the ledger holds when pi wrote a tool result just before the death ([A thread's conversation outlives its runs](a-thread-continues.md)).

Complete list: the specs' [`[gap]` rows](../reference/specs/README.md); switches: [Turn features on and off](../how-to/turn-features-on-and-off.md).
