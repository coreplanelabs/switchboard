# Onboard a repo

Give one repository a **resident**: an always-warm environment, checkout and dependencies ready, where every request naming it runs.

**You need:**

- A resident Worker ([Deploy](deploy.md)), the block below, and `RESIDENT_OPERATOR_TOKEN` + `RESIDENT_ADMIN_TOKEN` in the bot's environment; without them the `repo` commands do not exist.
- The `repo:write` grant; nobody holds it by default ([Restrict who can do what](restrict-who-can-do-what.md)).
- The repository inside the resident Worker's GitHub App installation; others are refused by name.

```yaml
execution:
  resident:
    baseUrl: https://switchboard-resident.example.com
```

## Onboard

```
@switchboard repo onboard acme/api --ref main --install "npm ci" --test "npm test" --build "npm run build"
```

Omit `--install`, `--test` or `--build` and OpenSwitchboard detects them from the lockfile and `package.json`, saying what it chose. The command returns at once; provisioning continues in the background.

## Watch it come up

```
@switchboard repo list
```

The lifecycle runs `onboarding → warm`; a second reply arrives at `warm`, or with a reason if it failed. The dashboard shows the same ([Dashboard routes](../reference/dashboard-routes.md)).

<img src="../images/residents-index.jpg" alt="Residents index in the dashboard, showing repo, lifecycle state, and last activity" width="720">

## Use it

Ask as before: any coding or review request naming the repository (`owner/name`, GitHub URL or PR link) runs in the resident. The status card shows the binding: `resident · acme/api · main@…`.

## Change or remove it

```
@switchboard repo reconfigure acme/api --test "npm run test:unit"
@switchboard repo offboard acme/api --dry-run     # itemized plan only
@switchboard repo offboard acme/api               # tear it down
@switchboard repo rebuild acme/api                # reprovision from scratch
```

Run `--dry-run` before anything destructive.

## Disk

The gauge is on every surface: `repo list` appends `· disk 4.06 GiB/14.4 GiB (28%)`, the residents index shows it per row, the detail page has a **Disk** section.

| State | Meaning | Remedy |
|---|---|---|
| `disk-pressure` on a status card | A new thread would not fit; the request ran in a cold sandbox, the resident stays `warm` | Fewer concurrent branches with divergent lockfiles, or a larger instance |
| `degraded` with `disk-full: …` on the dashboard | The disk filled; requests run cold until the container restarts and restores its snapshot | Refills within the hour: the working set no longer fits. Resize, or offboard a repository |

## Next

- [Resident contract](../reference/specs/resident-repos.md): the eviction rules.
- [Capacity and sizing](../explanation/capacity-and-sizing.md): why disk sizes the instance.
- [Authorization](../reference/authorization.md): `repo:write` versus `restrict.repos`.
