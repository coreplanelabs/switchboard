# Known limits

What is deliberately off, deliberately narrow, or not yet proven, so a reader does not mistake a configured absence for a bug. The specs' `[gap]` rows under [`docs/reference/specs/`](../reference/specs/README.md) are the complete list of criteria not yet proven; this page is the shape of the gaps, not the list.

## Off until you turn it on

- **Run history, the run ledger and memory are off without their config blocks.** Runs are then live-only and leave the dashboard about a minute after they finish; a restart loses a run in flight; model input is byte-identical to a build without memory ([Runs: live, then remembered](runs-live-and-history.md), [decision 0017](../decisions/0017-memory-off-by-default.md)). The switches are the matrix in [Turn features on and off](../how-to/turn-features-on-and-off.md).
- **Execution is `local` by default**, which is right for one developer and wrong for a deployment untrusted users can reach ([Execution and trust](execution-and-trust.md)).

## Narrow on purpose

- **Self-improvement proposes, never fixes.** Its only side effect is a labelled issue ([How OpenSwitchboard improves itself](how-switchboard-improves-itself.md)).
- **No per-run token or cost accounting.** The self-improvement pass uses a long-run outlier (at least twice the median run time) as its cost-spike proxy until there is; `/costs` prices the infrastructure, not individual runs.
- **`review` is read-only by convention**, held by its toolset and prompt; the hard boundary is the execution plane it runs in ([Execution and trust](execution-and-trust.md)).
- **Direct messages** to the bot are supported but the Slack app manifest's DM scopes are an installation's choice; a rollout may keep them off.

## Not yet proven

- **The E2B execution path** is typechecked and unit-tested but has no live procedure against an E2B sandbox in the specs.
- **Per-PR docs previews** do not exist: CI builds the site on every PR but publishes nothing; a reviewer reads the markdown diff.
- **The resident contract's `[gap]` rows**: a cross-repository token-scope proof and a push from a resident thread are stated criteria without a recorded proof.
- **Run history's `[gap]` rows**: a summary-only friction read and a full-scan listing on the history store.

## Mid-transition

- **The friction ledger is run history.** `friction report` and `friction propose` cluster over the runs `runHistory` retains, so its retention bounds what they see; without `runHistory` there are no recent runs to analyze and the commands say so.

When something here stops being true, the fix is to the spec row that owns it; this page follows the specs, never the reverse.
