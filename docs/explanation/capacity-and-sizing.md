# Capacity and sizing

The bot uses one gateway event loop and bounded validation workers on a `standard-1` container; a resident has 32 UID slots sharing its vCPUs and disk; a cold sandbox is the largest predefined type.

## One event loop in the bot

Node is single-threaded, so "using the cores" means never serializing independent I/O:

- side-effect-free tools run concurrently;
- memory retrieval overlaps repository resolution and workspace attach;
- status-card edits are coalesced;
- the answer is sent before the resident is released.

Responses validation uses at most two workers sharing the bot's CPU and memory. The bot template uses `standard-1` (0.5 vCPU, 4 GiB), the smallest supported predefined type that passed the bounded validation workload with retained gateway memory. It remains one container. See [Cloudflare container sizes](https://developers.cloudflare.com/containers/platform/limits/).

Paired Linux x64 Node24.21 tests on the same stock SDK completed two full2MiB streams at the normal baseline. Inline validation delayed the health response by6.24s; isolated validation's largest response was179ms. Both implementations OOMed on `basic` (0.25 vCPU,1GiB) with touched, held800,900 and960MiB baselines. This does not establish a fixed additive worker cost or the cause of an earlier outage.

At a held960MiB baseline, the isolated pipeline passed on `standard-1`:1235.93MiB cgroup peak,100ms largest health response, two actual worker exits, zero OOM events and no remaining capacity credits. Source failure, native abort and maximal-frame refusal controls also passed. These are finite fake-upstream tests on emulated Linux AMD64 runtime components. They do not prove native-hardware performance, full image/whole-bot startup or live acceptance. A512MiB managed policy is not an RSS or native allocator limit.

The sizing guard covers both build and registry profile rendering against that finite qualification footprint. It is a regression guard, not a universal memory bound. Applying the source template does not resize the running service; release, deployment and serving-capacity readback remain separate.

## Shared resources in a resident

A resident's cores are for concurrent threads, so worker pools must not oversubscribe them. The image's environment defaults set `CI=1`, `VITEST_MAX_WORKERS=1` (and the thread and fork variants), one libuv thread per vCPU and a Node heap ceiling; a repository's own configuration wins.

## The container size is the platform's ceiling

Memory is a fixed multiple of vCPUs and disk of memory, so the vCPUs a resident needs dictate the memory it pays for and the disk it gets. vCPU bills on use, memory and disk on provisioned size while awake; a resident is always on, so memory is the recurring cost.

One container size serves every resident: image, bare mirror, warm checkout with dependencies, the attach gate's reserve, then one tree per concurrent thread. A tree sharing the warm checkout's lockfile is hardlinked (a few hundred megabytes); a different lockfile installs its own `node_modules`. The container size decides how many trees run warm; the current one is the platform's largest, so the next step is a second container.

That arithmetic is a unit test beside the resident Worker's config; it fails the build when the template and the measured parts disagree.

## Disk is a budget, not a surprise

A resident measures its disk on every refresh cycle and attach, and shows the gauge on `repo list` and the dashboard. A new tree is admitted only under `free − reserve`: the coldest clean idle trees are evicted first; failing that, the attach is refused with `disk-pressure`, the arithmetic goes on the status card, and the run goes cold ([Onboard a repo](../how-to/onboard-a-repo.md)). Refusals on the dashboard mean the next container-size step buys a known number of trees; the load harness measures whether it was needed ([Run a load test](../how-to/run-a-load-test.md)).

## The cold sandbox

A cold sandbox clones, installs and checks a repository from scratch; a large monorepo's typecheck alone needs more than 8 GiB, so the sandbox is `standard-4` (4 vCPU / 12 GiB / 20 GB, the largest type). It sleeps after five idle minutes, so memory is paid per active run ([Execution and sandboxes](../reference/specs/execution.md), item 16).

## Residents do not accumulate

Each UID (Linux user ID) stays with its first owner for the VM generation. Detach releases a live binding, but does not clear that UID's spend. The pool resets only after confirmed VM destruction. The residents index and detail page show spent UIDs against the pool size; a full pool is red. Hover or focus the count for its explanation. An older Worker that does not report the size shows `?`, and an unknown spend count shows `—`.

Each refresh cycle releases eligible idle trees and reclaims worktrees whose branch is gone or whose pull request is closed. A known owner's workspace stays protected until terminal ownership, publication metadata and private-tree preservation are verified. Retained workspaces can therefore block an exhausted pool's safe VM recycle even after their runs end. Increasing the pool delays exhaustion; it does not settle those obligations.

An unused resident parks its refresh and sleeps. The fleet caps warm residents; onboarding over the cap can, per request, offboard the coldest eligible resident instead.

## Identity slots and active work

A resident has 32 UID slots and a separate limit of 16 active owners. The fleet cap remains six repositories, with a platform ceiling of ten containers. Each repository still routes to one VM with four vCPUs, 12 GiB memory and 20 GB disk. Extra identities provide room for historical owners; they do not add compute or promise more concurrent work.

An attach or operator command reserves capacity before cloning or executing. The exact existing owner may reattach at capacity. Live or uncertain owners, unacknowledged native operations and processes still running under old UIDs remain occupied. Verified finished owners can retain private files without using an active-work slot. Their disk use and preservation obligations remain subject to the existing checks.

The UID display reports historical spends against the image's pool size. `workloadLimit` reports the separate active-owner limit. Disk and memory checks may refuse work below that limit: the measured mixed workload of sixteen hardlinked plus two dependency-installing trees already exceeds this VM's disk budget.

Cleanup processes at most sixteen bindings per pass with a durable cursor. Protected early entries do not starve later eligible entries. Its configured step budget stays below the Workflow ceiling.

The existing overflow path uses a separate seeded sandbox for each run. Several warm residents for one repository would need placement and durable ownership changes. Raising the repository cap or UID count does not supply that routing. Dynamic UID provisioning is a later change; this version retains a finite pool and never transfers a spent identity to another owner. See [decision 0095](../decisions/0095-identity-allocation-is-separate-from-active-work.md).

## Read next

- [Resident repositories](../reference/specs/resident-repos.md) — the pool, the budget, the sweep, the cap.
- [Decision 0016](../decisions/0016-long-lived-process-not-serverless.md) — why there is a bot container to size.

## Sandbox fleet ceiling

The Sandbox deployment template sets `max_instances` to 250 while worker cleanup remains incomplete. Build and registry deployments both retain this ceiling. Billing depends on awake sandboxes and resource use. Lower it deliberately in the source template after cleanup is verified.
