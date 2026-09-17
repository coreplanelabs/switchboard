# Known limits

What is deliberately off, narrow on purpose, not yet proven, or a known wart, so an absence or a stray error is not mistaken for a bug.

## Off until you turn it on

- **Run history, the run ledger and memory** ([decision 0017](../decisions/0017-memory-off-by-default.md)). Without their config blocks: runs are live-only and vanish a minute after finishing; a restart loses a run in flight; model input is identical to a build without memory.
- **Execution is `local` by default**: right for one developer, wrong once untrusted users arrive ([Execution and trust](execution-and-trust.md)).

## Narrow on purpose

- **Self-improvement proposes, never fixes.** Its only side effect is a labelled issue.
- **A run's cost is list price, not the invoice.** Every finished run carries its tokens per model and is priced at `costs.prices` over the Anthropic list — on its page, in `runs get`, and summed by user, thread, channel, agent and model on the costs page. A model neither table knows reads `unpriced`, never $0; the per-run figure is never tied to the provider's bill (the costs page's reconciliation line does that per day, for the group).
- **`review` is read-only by convention.** The hard boundary is the execution plane.
- **DM scopes** are the manifest's choice.
- **The friction ledger is run history.** `friction report` and `friction propose` see only what `runHistory` retains.
- **The GitHub intake reads one event.** A `check_run` wakes the ship runner's merge step; a person's review, a comment or a merge reaches no agent until someone relays it in chat. The general door, an outside fact filed into the thread that owns the work, is [record 0047](../decisions/0047-an-outside-fact-finds-the-thread-that-owns-the-work.md), built after the smaller streams it names; no second event-specific intake is added before it.
- **A cold run holds an installation token.** A run on the cold sandbox or E2B plane carries a one-hour GitHub token in its environment for the whole run, scoped by permission and not by repository; the resident plane does not. The git door that replaces it with the run bearer is [record 0048](../decisions/0048-the-git-door-a-cold-runs-only-github-credential-is-its-run-bearer.md).
- **Schedules are a code catalog.** A schedule exists only when a deploy carries it, and a firing runs as `http:cron` rather than as the actor the catalog declares. Schedules stored at runtime and fired by the minute tick are [record 0049](../decisions/0049-a-stored-schedule-is-a-turn-the-minute-tick-fires.md).

## Not yet proven

- **The E2B path**: unit-tested, no live procedure.
- **Per-PR docs previews**: CI builds the site on every PR and publishes nothing.
- **Resident `[gap]` rows**: cross-repository token scope; a push from a resident thread.
- **Run history `[gap]` rows**: a summary-only friction read; a full-scan listing.

## Known warts

- **A plan runner that outlives a bot deploy ends with one runtime error.** The Workflows engine pins the instance to the Worker version it started on and wakes it on the current one; when that wake completes the plan, the runtime cancels the `ShipCoordinator.run` call as "hung" one millisecond after recording the instance's end. The unit report, the card, the parent run record and the instance's status are all complete — read that error on a finished instance as this, not as a stuck runner. An instance that starts and ends on one version never logs it.

Complete list: the specs' [`[gap]` rows](../reference/specs/README.md); switches: [Turn features on and off](../how-to/turn-features-on-and-off.md).
