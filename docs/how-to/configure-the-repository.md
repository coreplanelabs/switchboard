# Configure the repository

Make a fork, or a fresh copy of this repository, behave the way the original does on GitHub: every merge is a squash whose subject is the PR title, the checks CI runs are the checks a merge requires, and nothing lands on `main` any other way.

Everything below is a GitHub setting, not a file in the tree, so it is recorded here and reproduced with the commands shown. What lives in the tree needs no setup: the workflows under `.github/workflows/`, the Dependabot policy in `.github/dependabot.yml` and the release configuration in `release-please-config.json` are read from the default branch as soon as they land.

## Before you start

- The `gh` CLI, signed in as an administrator of the repository.
- Replace `OWNER/REPO` in every command.

## 1. Merge settings

One merge method, and the PR title is the whole commit message. release-please reads the type from that subject; the PR body stays on the PR, where its links and images render.

```sh
gh api -X PATCH repos/OWNER/REPO \
  -F allow_squash_merge=true -F allow_merge_commit=false -F allow_rebase_merge=false \
  -f squash_merge_commit_title=PR_TITLE -f squash_merge_commit_message=BLANK \
  -F delete_branch_on_merge=true
```

Because the body is not part of the commit, a breaking change is declared in the title with `!` (`feat(config)!: …`), never with a `BREAKING CHANGE:` footer.

## 2. The `title` check

Every PR title must fit `type(scope)!: description` — scope and `!` optional — with a type that `release-please-config.json` maps to a changelog section and a scope the Scope column of the [code map's Areas](../reference/code-map.md#areas) names; a `!` title also needs its section in [Migration notes](../reference/migrations.md) (the squash commit has no body, so `!` is the only breaking-change marker release-please sees). The check is `.github/workflows/pr-title.yml`, one job named `title`, which runs `npm run check:pr-title` with the title in `PR_TITLE`. It re-runs when the title is edited, and it passes in the merge queue, where there is no title because it was checked on the PR.

Run the same verdict locally:

```sh
npm run check:pr-title -- "feat(slack): thread admission"
```

To add a commit type, add its section to `release-please-config.json`; to add a scope, add it to the code map's Scope column; the check reads both lists from there. Dependabot's titles are made to fit by the `commit-message.prefix` in `.github/dependabot.yml`.

## 3. The ruleset for `main`

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
          { "context": "package", "integration_id": 15368 },
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

`required_approving_review_count` is 0 because the review that gates a merge here is the agent review — turned into an approval by the opt-in workflow in [section 5](#approve-on-the-agents-lgtm) — with a human pressing merge ([How we work](../explanation/how-we-work.md)); raise it if your fork wants a human approval on record.

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

## 4. Actions permissions

Two workflows create or approve pull requests with the workflow's own token: `release-please.yml` opens the release PR and `auto-approve-review-lgtm.yml` approves on a passing agent verdict once the repository has opted in ([below](#approve-on-the-agents-lgtm)). GitHub refuses both unless the repository allows it:

```sh
gh api -X PUT repos/OWNER/REPO/actions/permissions/workflow \
  -f default_workflow_permissions=read -F can_approve_pull_request_reviews=true
```

The default token permission stays `read`; each workflow raises its own `permissions:` block to exactly what it needs.

## 5. Repository secrets and variables

The deploy workflows need `CLOUDFLARE_DEPLOY_TOKEN` (Workers Scripts, Containers, R2 and Account Settings at the account; Workers Routes and DNS at the zone), `MEMORY_TOKEN` (the config push before the bot step) and `RESIDENT_READ_TOKEN`, and optionally `SANDBOX_TOKEN` for the sandbox's live gate and the release PR's deploy plan; the docs deploy uses `CLOUDFLARE_API_TOKEN`, which is also the fallback while no deploy token is set. What each one is and how to rotate it: [Rotate a secret](rotate-a-secret.md). The release can also publish the CLI to npm, and does so only when you say so: the `publish the npm package` job runs when the repository variable `SWITCHBOARD_PUBLISH_NPM` is `true` and is skipped otherwise (the release run carries one `npm publish is off` notice). Turning it on takes the variable and `NPM_TOKEN` — a granular access token on npmjs.com with read-and-write access to the package's scope (`npmPackage` in `project.json`):

```sh
gh secret set NPM_TOKEN            # paste the token on stdin
gh variable set SWITCHBOARD_PUBLISH_NPM --body true
```

Without the token the job fails on its own; the image and the deploy publish regardless of either. The manifest's `"private": true` is the second lever: npm refuses to publish while it is there, and removing it is a reviewed pull request ([Ship a release](ship-a-release.md#3-merge-the-release-pr)).

Where the installation's deployment profile lives is a repository **variable**, not a line in a workflow, so the tree names no installation:

```sh
gh variable set SWITCHBOARD_DEPLOY_PROFILE --body "github://OWNER/CONFIG-REPO/switchboard/profile.json@main"
gh variable set CONFIG_REPO_OWNER --body "OWNER"
gh variable set CONFIG_REPO_NAME --body "CONFIG-REPO"
```

`SWITCHBOARD_DEPLOY_PROFILE` is any form the CLI takes — the `github://` reference to a private configuration repository is the usual one, so the profile and the bot's config stay out of this repository; `CONFIG_REPO_OWNER` and `CONFIG_REPO_NAME` name that repository for the read-only App token the workflows mint to read it. The step that loads that App's client id and private key is the one installation-specific step left in the workflows; it reads this project's secrets manager, and a fork replaces it with its own source. A fork that never deploys from CI sets none of this: the release deploy refuses without a profile, the release PR's deploy-plan job and the docs deploy skip.

### Approve on the agent's LGTM

The review agent never approves a pull request; it posts a COMMENT-state review whose first line is `LGTM: …` only for an explicit approve verdict ([Agent review](../reference/specs/agent-review.md)). `.github/workflows/auto-approve-review-lgtm.yml` turns that line into an approval from the Actions token — but only for the App two repository variables name, matched by login and immutable id:

```sh
gh api users/YOUR-APP[bot] --jq '{login, id}'       # the App's bot user: its slug plus "[bot]"
gh variable set REVIEW_BOT_LOGIN --body 'YOUR-APP[bot]'
gh variable set REVIEW_BOT_ID --body 'THE-ID'
```

The repository must also let Actions approve pull requests — the `can_approve_pull_request_reviews=true` setting from [section 4](#4-actions-permissions); without it the approval fails with 422. With the variables unset the workflow never runs: it is an inert template, so a checkout that has no review App, or wants a human approval on record, changes nothing.

## 6. Dependabot

The update policy is `.github/dependabot.yml` in the tree. Two switches are repository settings: vulnerability alerts, and Dependabot's own security-update PRs.

```sh
gh api -X PUT repos/OWNER/REPO/vulnerability-alerts
gh api -X PUT repos/OWNER/REPO/automated-security-fixes
```

## 7. Description, homepage and topics

What the repository says about itself on GitHub — the one-line description, the homepage link and the topics — is stated once, in `project.json` (`description`, `docs`, `topics`), and `check:project-facts` holds it there: a description over GitHub's 350 characters, or a topic GitHub would refuse, fails the check before the command does. Read the values from the file rather than retyping them:

```sh
gh repo edit OWNER/REPO \
  --description "$(jq -r .description project.json)" \
  --homepage "$(jq -r .docs project.json)" \
  $(jq -r '.topics[] | "--add-topic " + .' project.json)
```

`--add-topic` only adds; a topic dropped from `project.json` is taken off with `--remove-topic NAME`. What GitHub holds afterwards: `gh repo view OWNER/REPO --json description,homepageUrl,repositoryTopics`.

## What you did

You reproduced the settings that make `main` a changelog: squash-only merges titled by the PR, a ruleset that requires CI's job names, permission for the two workflows that act on PRs, the secrets the deploy needs, the variables that name your installation and, if you want it, your review App, and the description, homepage and topics from `project.json`. The conventions these settings enforce are in [Contributing](../../CONTRIBUTING.md); the path they protect is [Ship a release](ship-a-release.md).
