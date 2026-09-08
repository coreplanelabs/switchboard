# Onboard a repo

Make coding and review requests against one repository start warm — the checkout already there, the dependencies already installed — instead of cloning cold for every thread.

By default every repository runs cold: a new workspace per thread, cloned on first use. Onboarding gives a repository a **resident**, an always-warm environment of its own, and every later request that names the repository runs in it.

## Before you start

- A resident Worker deployed ([Deploy](deploy.md)) and the bot's config pointed at it:

  ```yaml
  execution:
    resident:
      baseUrl: https://switchboard-resident.example.com
  ```

  with `RESIDENT_OPERATOR_TOKEN` (runtime tool calls) and `RESIDENT_ADMIN_TOKEN` (the `repo …` commands) in the bot's environment. Without them the `repo` commands do not exist ([Turn features on and off](turn-features-on-and-off.md)).
- The `repo:write` grant. Onboarding provisions billable, always-on compute and binds a GitHub credential, so nobody holds it by default: admins only, until granted ([Restrict who can do what](restrict-who-can-do-what.md)).
- The repository is in the GitHub App installation the resident Worker authenticates with. A repository outside it is refused by name and nothing is created.

## 1. Onboard

```
@switchboard repo onboard acme/api --ref main --install "npm ci" --test "npm test" --build "npm run build"
```

Omit `--install`, `--test` or `--build` and Switchboard inspects the repository root — the lockfile for the package manager, `package.json` for the scripts — picks the commands, and tells you what it chose and why. The command returns at once; provisioning continues in the background.

## 2. Watch it come up

```
@switchboard repo list
```

The lifecycle runs `onboarding → warm`. You get a second reply the moment the resident reaches `warm`, or a reason if it did not. The dashboard shows the same list with more detail per repository ([Dashboard routes](../reference/dashboard-routes.md)).

<img src="../images/residents-index.jpg" alt="Residents index in the dashboard, showing repo, lifecycle state, and last activity" width="720">

## 3. Use it

Nothing changes in how you ask. Any coding or review request that names the repository — by `owner/name`, by GitHub URL, or by a pull request link — runs in the resident. The status card says which repository the run bound (`resident · acme/api · main@…`), so check it if an answer looks like it came from the wrong place.

## 4. Change or remove it later

```
@switchboard repo reconfigure acme/api --test "npm run test:unit"
@switchboard repo offboard acme/api --dry-run     # the itemized plan, nothing executed
@switchboard repo offboard acme/api               # tear it down
@switchboard repo rebuild acme/api                # discard the snapshot and reprovision from scratch
```

Run `--dry-run` before anything destructive; it prints exactly what would happen.

## If the resident runs out of disk

A resident's disk is a budget it measures on every refresh and attach, and the gauge is on every surface: `repo list` appends `· disk 4.06 GiB/14.4 GiB (28%)` to the line, the residents index shows it per row, and the detail page has a **Disk** section — used, free, the reserve the resident keeps back, headroom in "more trees", and every component. Two states you may see:

- **`disk-pressure` on a status card.** A new thread would not fit, the resident evicted the idle trees it safely could, and the request ran in a cold sandbox instead. The card shows the arithmetic. Nothing is broken and the resident stays `warm`; the detail page shows which trees hold the space. The remedy is fewer concurrent branches with divergent lockfiles, or a larger instance.
- **`degraded` with `disk-full: …` on the dashboard.** The container disk filled anyway. Requests run cold until it recovers, which it does on its own by restarting the container and restoring the snapshot, once nothing is in flight and no thread has uncommitted work. If it fills again within the hour, the detail page's last refresh error says why: the working set no longer fits the instance. Resize it, or offboard a repository.

The rules of the budget — the reserve, what is evicted first, what is never evicted — are in the [resident contract](../reference/specs/resident-repos.md); why disk decides the instance size is in [Capacity and sizing](../explanation/capacity-and-sizing.md).

## What you did

You gave one repository an always-warm environment, watched it reach `warm`, and learned where its disk gauge lives. Using a resident is separate from onboarding it: restrict who may use the repository with `restrict.repos` and a `repos` grant ([Restrict who can do what](restrict-who-can-do-what.md)).

## See also

- [Authorization](../reference/authorization.md) — `repo:write` versus `restrict.repos`, and why one is never a baseline while the other is open unless listed.
- [Worker topology](../explanation/worker-topology.md) — what a resident is underneath.
