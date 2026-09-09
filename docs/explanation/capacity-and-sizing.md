# Capacity and sizing

Why the containers are the size they are, why "using the cores" means something unusual when the bot is one Node event loop, and why a resident's instance is chosen by how many threads share it and the disk they need.

## One event loop in the bot; sixteen threads in a resident

The bot is a single Node process on a fraction of one vCPU. Node is single-threaded, so for the bot "using the cores" cannot mean parallelism; it means never serializing independent I/O: the runner executes a turn's side-effect-free tools concurrently; the dispatcher overlaps memory retrieval with repository resolution and workspace attach, coalesces status-card edits, and sends the answer before releasing the resident; the Slack adapter fetches a follow-up's thread once and downloads attachments concurrently; the HTTP server listens before the Slack handshake finishes; server-sent frames are serialized once per event and resumable. The bot runs on the smallest instance and grows only on evidence: the CPU it burns is redaction over tool output and JSON serialization, both paid once per event, and nothing has measured it CPU-bound.

A resident is the opposite shape: up to sixteen thread processes share its vCPUs, so its cores are for concurrent threads, not for one thread's parallelism, and the discipline is not to oversubscribe them with worker pools. The resident image sets `CI=1`, `VITEST_MAX_WORKERS=1` (and the thread and fork variants), one libuv thread per vCPU and a Node heap ceiling as environment defaults, so a repository's test runner runs one worker per thread instead of sizing its pool from the host's core count. A repository's own configuration still wins.

## Why the resident's instance is the platform's ceiling

Two platform ratios decide a resident's instance: memory is a fixed multiple of vCPUs, and disk a fixed multiple of memory. The CPU is the decision — one vCPU meant every thread's test run and the refresh cycle's install shared one core — and the vCPUs a resident needs then dictate the memory it pays for and unlock the disk it gets. vCPU is billed on use; memory and disk are billed on provisioned size while the container is awake, and a resident is effectively always on, so memory is the whole recurring cost and the vCPUs cost only while busy.

One instance type serves every resident, sized for the largest onboarded repository and for sixteen threads sharing it: the image, the bare mirror, the warm checkout with its dependencies, the reserve the attach admission holds back (room to stage a snapshot plus a floor), then one more tree per concurrent thread. A thread whose branch shares the warm checkout's lockfile costs a hardlinked tree, a few hundred megabytes; a thread whose lockfile differs installs its own dependencies and costs the whole `node_modules` on top. So the instance size decides how many concurrent trees run warm, not whether the disk fills, and because the current instance is the largest the platform offers, the next step up is a second container, not a bigger one.

That arithmetic is not prose. It lives in a unit test beside the resident Worker's config, measured against the parts it names, and fails the build — not the deploy — when the instance size in the template and the measured parts disagree. Anyone resizing a resident changes the test's inputs and reads what fits.

## Why disk is a budget, not a surprise

A resident measures its disk on every refresh cycle and after every attach, and publishes the gauge on every surface (`repo list`, the residents index, the detail page). A new thread tree is admitted only under `free − reserve`: the coldest clean idle trees are evicted first; if that is not enough, the attach is refused with `disk-pressure`, the arithmetic goes on the status card, and the run goes cold. Running out of disk is a named decision with a number attached, never an error discovered by a failed write ([Onboard a repo](../how-to/onboard-a-repo.md)).

The same budget decides the sizing question the other way round: when the dashboard shows `disk-pressure` refusals, the next instance step buys a known number of additional concurrent trees, and the load harness measures whether it was needed ([Run a load test](../how-to/run-a-load-test.md)).

## Why the cold sandbox is the largest predefined type

A cold per-thread sandbox is the third shape: one container, one thread, nothing warm. It clones, installs and checks a whole repository from scratch, so it is sized by the largest single command a cold thread must be able to run, not by the typical one — a large monorepo's typecheck alone needs more than 8 GiB, and the 2 vCPU / 8 GiB instance could not run it at all. The sandbox is therefore the platform's largest predefined type (`standard-4`, 4 vCPU / 12 GiB / 20 GB — a custom type can be no larger). Unlike a resident it is not always on: it sleeps after five idle minutes, so its memory is paid per active run and its vCPUs only while they are busy, and the larger instance costs nothing between runs. The template beside the sandbox Worker carries the number and the reasoning; a unit test pins it ([Execution and sandboxes](../reference/specs/execution.md), item 16).

## Why residents do not accumulate

Each resident has a pool of OS users, one per concurrent thread; a run releases its user when it detaches. An hourly sweep releases clean idle trees, every refresh cycle reclaims worktrees whose branch is gone from the mirror or whose pull request is merged or closed, and an unused resident parks its refresh so the container sleeps and stops paying for memory. The fleet has a cap on warm residents; an admin onboarding over the cap can ask for the coldest eligible resident to be offboarded instead of being refused, per request and never by default.

## See also

- [Worker topology](worker-topology.md) — which container is which.
- [Resident repositories](../reference/specs/resident-repos.md) — the contract: the pool, the budget, the sweep, the cap.
- [One long-lived bot process plus Durable Objects](../decisions/0016-long-lived-process-not-serverless.md) — why there is a bot container to size at all.
