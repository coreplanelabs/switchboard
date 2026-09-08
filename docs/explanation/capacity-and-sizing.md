# Capacity and sizing

The bot is one Node event loop on the smallest instance; a resident is sized for sixteen threads sharing its vCPUs and disk; a cold sandbox is the largest predefined type.

## One event loop in the bot

Node is single-threaded, so "using the cores" means never serializing independent I/O:

- side-effect-free tools run concurrently;
- memory retrieval overlaps repository resolution and workspace attach;
- status-card edits are coalesced;
- the answer is sent before the resident is released.

The bot's CPU goes to redaction and JSON serialization, once per event. Nothing has measured it CPU-bound, so it runs on the smallest instance and grows only on evidence.

## Sixteen threads in a resident

A resident's cores are for concurrent threads, so worker pools must not oversubscribe them. The image's environment defaults set `CI=1`, `VITEST_MAX_WORKERS=1` (and the thread and fork variants), one libuv thread per vCPU and a Node heap ceiling; a repository's own configuration wins.

## The instance is the platform's ceiling

Memory is a fixed multiple of vCPUs and disk of memory, so the vCPUs a resident needs dictate the memory it pays for and the disk it gets. vCPU bills on use, memory and disk on provisioned size while awake; a resident is always on, so memory is the recurring cost.

One instance type serves every resident: image, bare mirror, warm checkout with dependencies, the attach admission's reserve, then one tree per concurrent thread. A tree sharing the warm checkout's lockfile is hardlinked (a few hundred megabytes); a different lockfile installs its own `node_modules`. The instance size decides how many trees run warm; the current one is the platform's largest, so the next step is a second container.

That arithmetic is a unit test beside the resident Worker's config; it fails the build when the template and the measured parts disagree.

## Disk is a budget, not a surprise

A resident measures its disk on every refresh cycle and attach, and shows the gauge on `repo list` and the dashboard. A new tree is admitted only under `free − reserve`: the coldest clean idle trees are evicted first; failing that, the attach is refused with `disk-pressure`, the arithmetic goes on the status card, and the run goes cold ([Onboard a repo](../how-to/onboard-a-repo.md)). Refusals on the dashboard mean the next instance step buys a known number of trees; the load harness measures whether it was needed ([Run a load test](../how-to/run-a-load-test.md)).

## The cold sandbox

A cold sandbox clones, installs and checks a repository from scratch; a large monorepo's typecheck alone needs more than 8 GiB, so the sandbox is `standard-4` (4 vCPU / 12 GiB / 20 GB, the largest type). It sleeps after five idle minutes, so memory is paid per active run ([Execution and sandboxes](../reference/specs/execution.md), item 16).

## Residents do not accumulate

OS users are pooled, one per concurrent thread, released on detach. An hourly sweep releases clean idle trees; each refresh cycle reclaims worktrees whose branch is gone or whose pull request is closed; an unused resident parks its refresh and sleeps. The fleet caps warm residents; onboarding over the cap can, per request, offboard the coldest eligible resident instead.

## Read next

- [Resident repositories](../reference/specs/resident-repos.md) — the pool, the budget, the sweep, the cap.
- [Decision 0016](../decisions/0016-long-lived-process-not-serverless.md) — why there is a bot container to size.
