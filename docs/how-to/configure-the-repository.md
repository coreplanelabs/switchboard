# Configure the repository

Goal: a fork, or a fresh copy of this repository, behaves the way the original does on GitHub — every merge is a squash whose subject is the PR title, the checks CI runs are the checks a merge requires, and nothing lands on `main` any other way. Everything below is a GitHub setting, not a file in the tree, so it is recorded here and reproduced with the commands shown. Replace `OWNER/REPO`.

What lives in the tree needs no setup: the workflows under `.github/workflows/`, the Dependabot policy in `.github/dependabot.yml`, and the release configuration in `release-please-config.json` are read from the default branch as soon as they land.

## Merge settings

One merge method, and the PR title is the whole commit message. release-please reads the type from that subject; the PR body stays on the PR, where its links and images render.

```sh
gh api -X PATCH repos/OWNER/REPO \
  -F allow_squash_merge=true -F allow_merge_commit=false -F allow_rebase_merge=false \
  -f squash_merge_commit_title=PR_TITLE -f squash_merge_commit_message=BLANK \
  -F delete_branch_on_merge=true
```

Because the body is not part of the commit, a breaking change is declared in the title with `!` (`feat(config)!: …`), never with a `BREAKING CHANGE:` footer.

## The `title` check

Every PR title must fit `type(scope)!: description` — scope and `!` optional — with a type that `release-please-config.json` maps to a changelog section. The check is `.github/workflows/pr-title.yml`, one job named `title`, which runs `npm run check:pr-title` with the title in `PR_TITLE`. It re-runs when the title is edited, and it passes in the merge queue (there is no title there; it was checked on the PR).

Run the same verdict locally:

```sh
npm run check:pr-title -- "feat(slack): thread admission"
```

To add a commit type, add its section to `release-please-config.json`; the check reads the list from there. Dependabot's titles are made to fit by the `commit-message.prefix` in `.github/dependabot.yml`.

## The ruleset for `main`

A branch ruleset, not classic branch protection: it is JSON, so it can be diffed and re-applied. Required checks are named by **job name** (`name:` in the workflow), which is why the CI jobs are short stable nouns and what they run is their script. Every required check must also report for `merge_group` events, or the merge queue waits forever on a check that never arrives; `ci.yml` and `pr-title.yml` both do.

Save as `main-ruleset.json`:

```json
{
  "name": "main",
  "target": "branch",
  "enforcement": "active",
  "conditions": { "ref_name": { "include": ["~DEFAULT_BRANCH"], "exclude": [] } },
  "rules": [
    { "type": "deletion" },
    { "type": "non_fast_forward" },
    {
      "type": "pull_request",
      "parameters": {
        "allowed_merge_methods": ["squash"],
        "dismiss_stale_reviews_on_push": false,
        "require_code_owner_review": false,
        "require_last_push_approval": false,
        "required_approving_review_count": 0,
        "required_review_thread_resolution": false
      }
    },
    {
      "type": "required_status_checks",
      "parameters": {
        "strict_required_status_checks_policy": false,
        "do_not_enforce_on_create": false,
        "required_status_checks": [
          { "context": "bot", "integration_id": 15368 },
          { "context": "web", "integration_id": 15368 },
          { "context": "docs", "integration_id": 15368 },
          { "context": "workers", "integration_id": 15368 },
          { "context": "image", "integration_id": 15368 },
          { "context": "title", "integration_id": 15368 }
        ]
      }
    }
  ]
}
```

`15368` is the GitHub Actions app: a required check that names no integration can be satisfied by any app that posts a status of that name.

```sh
gh api -X POST repos/OWNER/REPO/rulesets --input main-ruleset.json
# later: list, then update in place
gh api repos/OWNER/REPO/rulesets --jq '.[] | {id, name}'
gh api -X PUT repos/OWNER/REPO/rulesets/RULESET_ID --input main-ruleset.json
```

`required_approving_review_count` is 0 because the review that gates a merge here is the agent review (see the auto-approve workflow), with a human pressing merge; raise it if your fork wants a human approval on record.

### Merge queue (optional)

`ci.yml` and `pr-title.yml` already trigger on `merge_group`, so the queue can be turned on by adding one rule to the ruleset above:

```json
{
  "type": "merge_queue",
  "parameters": {
    "merge_method": "SQUASH",
    "grouping_strategy": "ALLGREEN",
    "check_response_timeout_minutes": 60,
    "max_entries_to_build": 5,
    "max_entries_to_merge": 5,
    "min_entries_to_merge": 1,
    "min_entries_to_merge_wait_minutes": 5
  }
}
```

With the queue on, "Merge" becomes "Add to merge queue" and CI runs once more against the merged result before it lands. Without it, the ruleset above still blocks anything that is not a green, squash-merged PR.

## Actions permissions

Two workflows create or approve pull requests with the workflow's own token: `release-please.yml` opens the release PR and `auto-approve-claude-lgtm.yml` approves on a passing agent verdict. GitHub refuses both unless the repository allows it:

```sh
gh api -X PUT repos/OWNER/REPO/actions/permissions/workflow \
  -f default_workflow_permissions=read -F can_approve_pull_request_reviews=true
```

The default token permission stays `read`; each workflow raises its own `permissions:` block to exactly what it needs.

## Repository secrets

The deploy workflows need `CLOUDFLARE_API_TOKEN` and `RESIDENT_READ_TOKEN`, and optionally `SANDBOX_TOKEN` for the release PR's deploy plan. What each one is and how to rotate it: [Deploy and rotate a secret](deploy-and-rotate-a-secret.md). A fork that never deploys from CI needs none of them; the docs deploy step skips loudly when its token is absent.

## Dependabot

The update policy is `.github/dependabot.yml` in the tree. Two switches are repository settings: vulnerability alerts, and Dependabot's own security-update PRs.

```sh
gh api -X PUT repos/OWNER/REPO/vulnerability-alerts
gh api -X PUT repos/OWNER/REPO/automated-security-fixes
```

## See also

- [CONTRIBUTING](https://github.com/coreplanelabs/switchboard/blob/main/CONTRIBUTING.md) — the PR conventions these settings enforce.
- [Deploy and rotate a secret](deploy-and-rotate-a-secret.md) — the release-to-production path the ruleset protects.
