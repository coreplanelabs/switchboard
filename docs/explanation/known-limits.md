# Known limits

What is deliberately off, narrow on purpose, not yet proven, or a known wart, so an absence or a stray error is not mistaken for a bug.

## Off until you turn it on

- **Run history, the run ledger and memory** ([decision 0017](../decisions/0017-memory-off-by-default.md)). Without their config blocks: runs are live-only and vanish a minute after finishing; a restart loses a run in flight; model input is identical to a build without memory.
- **Execution is `local` by default**: right for one developer, wrong once untrusted users arrive ([Execution and trust](execution-and-trust.md)).

## Narrow on purpose

- **Scheduled state Worker history cleanup is paused for the MVP.** Its alarm still handles live-run deadlines, re-asks and effects. History reads enforce the retention policy, and `put`/`finish` trim stored runs; explicit deletion and per-conversation byte trimming still run. Without the scheduled pass, old conversation histories, orphaned rows and reply decisions can accumulate; `runHistory.maxBytes` caps run records, not the whole database. Reply decisions remain readable and their keys can deduplicate longer than their original prune bound. Re-enable cleanup only after it can advance in bounded steps without holding the run-history input gate across conversation objects.
- **Foreground history retention still scales with stored history.** Unit-context roots are validated in one pass, and individual unit holders use indexed lookups. A retention pass still reads stored runs and context roots; the deletion limit does not cap rows examined. Bounded maintenance and live responsiveness under recovery load remain separate acceptance work.
- **Self-improvement proposes, never fixes.** Its only side effect is a labelled issue.
- **A run's cost is list price, not the invoice.** Every finished run carries its tokens per model and is priced at `costs.prices` over the Anthropic list — on its page, in `runs get`, and summed by user, thread, channel, agent and model on the costs page. A model neither table knows reads `unpriced`, never $0; the per-run figure is never tied to the provider's bill (the costs page's reconciliation line does that per day, for the group).
- **`review` is read-only by convention.** The hard boundary is the execution plane.
- **DM scopes** are the manifest's choice.
- **The friction ledger is run history.** `friction report` and `friction propose` see only what `runHistory` retains.
- **GitHub events reach specific owners.** A `check_run` can wake a waiting merge step. A trusted requester's comment on a live unit's pull request can steer that unit; a base-branch push can wake the merge watch. Other events do not automatically become agent turns ([HTTP ingress](../reference/specs/http-ingress.md)).
- **Cold model workspaces use a run bearer.** Git and GitHub calls go through the trusted Git door. The workspace does not receive a long-lived installation token ([Execution and trust](execution-and-trust.md)).
- **Schedules are a code catalog.** A schedule exists only when a deploy carries it, and a firing runs as `http:cron` rather than as the actor the catalog declares. Schedules stored at runtime and fired by the minute tick are [record 0049](../decisions/0049-a-stored-schedule-is-a-turn-the-minute-tick-fires.md).
- **Resident preservation covers the private Git tree.** Automatic removal waits for the exact finished owner and a fresh match to a saved checkpoint or a clean terminal tree. The checkpoint covers tracked and non-ignored untracked work captured in Git. Ignored files, files outside the tree, explicit admin destruction and platform loss remain outside that proof; an unavailable proof blocks automatic cleanup.

## Not yet proven

- **The E2B path**: unit-tested, no live procedure.
- **Per-PR docs previews**: CI builds the site on every PR and publishes nothing.
- **Resident `[gap]` rows**: cross-repository token scope; a push from a resident thread.
- **Run history `[gap]` rows**: a summary-only friction read; a full-scan listing.

## Known warts

- **A pipeline that outlives a bot deploy ends with one runtime error.** The Workflows engine pins the pipeline's Workflow to the Worker version it started on and wakes it on the current one; when that wake completes the plan, the runtime cancels the `ShipCoordinator.run` call as "hung" one millisecond after recording the pipeline's end. The unit report, the card, the parent run record and the pipeline's status are all complete — read that error on a finished pipeline as this, not as a stuck one. A pipeline that starts and ends on one Worker version never logs it.

Complete list: the specs' [`[gap]` rows](../reference/specs/README.md); switches: [Turn features on and off](../how-to/turn-features-on-and-off.md).
