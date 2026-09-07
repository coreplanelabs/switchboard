# Onboard a repo (make it warm)

Goal: a coding or review request against `acme/api` should start instantly — checkout already there, dependencies already installed — instead of cloning cold every time.

By default, every repo runs cold: a fresh workspace directory per thread, cloned on first use. **Onboarding** a repo gives it its own always-warm environment (a "resident") so requests skip that setup entirely.

## Onboard one

Onboarding provisions billable, always-on compute and binds GitHub credentials, so it's gated by `repoManagement` — **the one permission that's locked by default**: unless an admin has explicitly opened it, only admins can run these commands.

```
@switchboard repo onboard acme/api --ref main --test "npm test" --build "npm run build" --install "npm ci"
```

Omit any of `--test`/`--build`/`--install` and Switchboard inspects the repo root to guess them (lockfile → package manager, `package.json` scripts → commands) and tells you what it picked and why.

## Watch it come up

```
@switchboard repo list
```

<img src="../images/residents-index.jpg" alt="Residents index in the dashboard, showing repo, lifecycle state, and last activity" width="720">

Lifecycle runs `onboarding → warm`. You'll get a second Slack reply the moment it reaches `warm` (or a reason if it didn't). The same list, with more detail per repo, is on the dashboard — [reference: dashboard routes](../reference/dashboard-routes.md).

<img src="../images/resident-detail.jpg" alt="A single resident's detail page, showing its mirror, warm checkout, and thread worktrees" width="720">

## Once it's warm

Any coding/review request that names the repo — by slug, GitHub URL, or PR link — runs in its resident automatically. Nothing to type differently; you'll just notice it starts faster and doesn't re-clone.

## Managing it later

```
@switchboard repo reconfigure acme/api test="npm run test:unit"
@switchboard repo offboard acme/api --dry-run     # itemized plan, nothing executed yet
@switchboard repo offboard acme/api               # actually tear it down
@switchboard repo rebuild acme/api                # discard and reprovision from scratch
```

`--dry-run` is worth using before any destructive change — it prints exactly what would happen without doing it.

## Disk

Each resident has a fixed disk (16 GB today), and it is a budget, not a surprise: the resident measures it on every refresh and after every attach, and the numbers are wherever you look — `repo list` appends `· disk 4.06 GiB/14.4 GiB (28%)` to each line, the residents index shows the same gauge per row, and the detail page has a **Disk** section: used/total, free, the **reserve** the resident always keeps back (room to stage its snapshot plus a 1 GiB floor), the **headroom** expressed as "room for N more hardlinked trees, M more deps-installing" (a thread whose branch shares the warm checkout's lockfile costs ~0.5 GB; one whose lockfile differs installs its own dependencies and costs the whole `node_modules` on top), and every component — mirror, dependencies, checkout, each live thread tree, leftover caches per pool user, everything else. `diskBudgetMb` on the record (`repo onboard … `, `repo reconfigure …`) caps what the resident may use below the physical disk.

When a new thread would not fit under `free − reserve`, the resident first evicts its coldest idle worktrees (never one with a command running, never one attached in the last 10 minutes, never the default branch, never one with uncommitted work), and if that is still not enough it refuses the attach with `disk-pressure`. Nothing breaks: the request runs in a cold sandbox instead, and the status card shows the whole arithmetic — `resident attach failed (… disk-pressure: need 2.47 GiB for a new tree (install), but 3.10 GiB free minus the 2.76 GiB reserve (snapshot staging 1.76 GiB + floor 1.00 GiB) leaves 0.34 GiB — short by 2.13 GiB; evicted 1 idle tree(s) (0.52 GiB back): …; kept 1: … (2 operation(s) in flight)) — using fresh sandbox`. Existing threads keep working; the resident stays `warm`. If you see this often, the detail page tells you which trees are holding the space; the remedy is fewer concurrent branches with divergent lockfiles, or a larger instance.

A resident whose container disk fills up anyway shows `degraded` with a `disk-full: …` reason on the dashboard, and requests for that repo run cold (the status card says so) until it recovers. It recovers on its own: the disk is only a cache, so the resident restarts its container and restores from its snapshot — usually within a couple of minutes — as long as no run is in flight and no thread has uncommitted work on it. If it fills again within the hour, the resident keeps the container and the detail page's last refresh error says why: the repo's working set no longer fits the instance disk, so resize it or offboard a repo.

## Who can use a warm repo

Onboarding is separate from *using* an onboarded repo. Restrict the latter per repo with `permissions.repos` — see [restrict who can do what](restrict-who-can-do-what.md).

## See also

- [Reference: dashboard routes](../reference/dashboard-routes.md) — the residents pages in full.
- [Reference: permissions](../reference/permissions.md) — `repoManagement` vs `repos`, and why one fails closed and the other doesn't.
- [Explanation: Worker topology](../explanation/worker-topology.md) — what a resident actually is, underneath.
