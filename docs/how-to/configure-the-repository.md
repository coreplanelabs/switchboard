# Configure the repository

Make a fork's `main` behave like the original's: squash-only merges titled by the PR, CI required.

**You need:** `gh` signed in as a repository admin; replace `OWNER/REPO`.

## 1. Merge settings

```sh
gh api -X PATCH repos/OWNER/REPO \
  -F allow_squash_merge=true -F allow_merge_commit=false -F allow_rebase_merge=false \
  -f squash_merge_commit_title=PR_TITLE -f squash_merge_commit_message=BLANK \
  -F delete_branch_on_merge=true
```

The title is the whole commit, so breaking changes are `feat(config)!: …` — after the public launch; while `release-please-config.json` pins the next version (`release-as`), the check refuses a `!` and the change ships as a minor.

## 2. The `title` check

`.github/workflows/pr-title.yml` checks `type(scope)!: description` against `release-please-config.json` and the [code map's Areas](../reference/code-map.md#areas); `!` needs [Migration notes](../reference/migrations.md).

```sh
npm run check:pr-title -- "feat(slack): thread admission"
```

## 3. The ruleset for `main`

Checks are job names; each must report on `merge_group`. Save as `main-ruleset.json`:

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

```sh
gh api -X POST repos/OWNER/REPO/rulesets --input main-ruleset.json
# later: list, then update in place
gh api repos/OWNER/REPO/rulesets --jq '.[] | {id, name}'
gh api -X PUT repos/OWNER/REPO/rulesets/RULESET_ID --input main-ruleset.json
```

`15368` is the GitHub Actions app; the [agent's LGTM](#approve-on-the-agents-lgtm) reviews.

### Merge queue (optional)

One more rule in the ruleset:

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

## 4. Actions permissions

`release-please.yml` and `auto-approve-review-lgtm.yml` need this:

```sh
gh api -X PUT repos/OWNER/REPO/actions/permissions/workflow \
  -f default_workflow_permissions=read -F can_approve_pull_request_reviews=true
```

## 5. Repository secrets and variables

Secrets: `CLOUDFLARE_DEPLOY_TOKEN`, `MEMORY_TOKEN`, `RESIDENT_READ_TOKEN`, optionally `SANDBOX_TOKEN`; `CLOUDFLARE_API_TOKEN` for the docs deploy ([Rotate a secret](rotate-a-secret.md)).

```sh
gh variable set SWITCHBOARD_PUBLISH_NPM --body true
gh variable set SWITCHBOARD_DEPLOY_PROFILE --body "github://OWNER/CONFIG-REPO/switchboard/profile.json@main"
gh variable set CONFIG_REPO_OWNER --body "OWNER"
gh variable set CONFIG_REPO_NAME --body "CONFIG-REPO"
```

npm publishing uses no token. Once, before turning the variable on: an admin of the npm org publishes a placeholder `0.0.0` of the package from an empty directory (`npm init --scope=@OWNER -y`, `npm pkg set name=… version=0.0.0`, `npm publish --access public`), then on the package's npm settings adds a **Trusted Publisher**: GitHub Actions, this repository, workflow file `release-please.yml`. From then on every release cut from the default branch publishes with the workflow's own identity; provenance is attached once the repository is public. A release line on another branch never publishes to npm; to skip one release, set the variable to `false` before merging its release PR (the run says so in a notice).

### Approve on the agent's LGTM

`auto-approve-review-lgtm.yml` approves on this App's `LGTM: …` review comment ([Agent review](../reference/specs/agent-review.md)):

```sh
gh api users/YOUR-APP[bot] --jq '{login, id}'       # the App's bot user: its slug plus "[bot]"
gh variable set REVIEW_BOT_LOGIN --body 'YOUR-APP[bot]'
gh variable set REVIEW_BOT_ID --body 'THE-ID'
```

Without [section 4](#4-actions-permissions) it fails with 422.

## 6. Dependabot

Beside `.github/dependabot.yml`:

```sh
gh api -X PUT repos/OWNER/REPO/vulnerability-alerts
gh api -X PUT repos/OWNER/REPO/automated-security-fixes
```

## 7. Description, homepage and topics

`project.json` is the source; `check:project-facts` validates it.

```sh
gh repo edit OWNER/REPO \
  --description "$(jq -r .description project.json)" \
  --homepage "$(jq -r .docs project.json)" \
  $(jq -r '.topics[] | "--add-topic " + .' project.json)
```

`--remove-topic NAME` drops one.

## Next

- [Ship a release](ship-a-release.md)
- [Contributing](../../CONTRIBUTING.md)
