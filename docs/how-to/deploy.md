# Deploy

By the end, OpenSwitchboard runs in production on Cloudflare: the bot as a container with a state Worker beside it, deployed from your terminal in one command.

**You need:** a Cloudflare account with a domain (a *zone*) in it, an API token for it in `CLOUDFLARE_API_TOKEN` (scopes: [Set up accounts](set-up-accounts.md); Containers Edit is what the image copy needs), and the Slack tokens and provider key from [Get started](../tutorials/get-started.md). No Docker, no clone.

## The pieces

| Worker | What it is | Needed? |
|---|---|---|
| memory (the state Worker) | Durable Objects: config, run history, memory, schedules, overrides | yes: without it nothing survives a restart |
| bot | The always-on container: Slack, the model, the dispatcher, the dashboards | yes |
| resident | One always-warm container per onboarded repository | optional |
| sandbox | A container per thread for tools | optional |

`deploy all` deploys them in that order.

## Write the profile

```bash
mkdir switchboard && cd switchboard
npx @coreplane/switchboard init --organization <org> --anthropic-key <key> --slack-app-token <xapp-token> --slack-bot-token <xoxb-token> --cloudflare <account id> --zone <zone>
```

You should see:

```
wrote:
  .env                  (mode 600)
  config/config.yaml
  deploy/profile.json
Worker configs from deploy/profile.json:
  written   .switchboard/deploy/cloudflare-memory/wrangler.jsonc
  written   .switchboard/deploy/cloudflare/wrangler.jsonc
  …
```

Every `deploy` command runs from this directory; `.switchboard/` holds the rendered Worker configs. The profile's fields:

| Field | Meaning |
|---|---|
| `account`, `zone` | Your account id; the zone every hostname is under. |
| `workers.<name>` | `script` and `hostname` per Worker; delete one and the plan has no step for it. |
| `images` | `registry` (what `init` writes): the release's published images, copied into your account's registry by `deploy all` once per version, over HTTPS. `build`: each Dockerfile, built where `deploy all` runs (a checkout; needs Docker). |
| `configSource` | The bot's config: a path, `github://owner/repo/path@ref` (needs `CONFIG_REPO_TOKEN`) or `op://Vault/Item/field`. |
| `secretsSource` | A directory of `<NAME>` files (`~/.secrets/switchboard` when absent) or `op://Vault/Item`. |
| `access` | `{ "teamDomain": "<team>.cloudflareaccess.com", "aud": "<AUD tag>" }`: Cloudflare Access in front of the dashboards. |

## Point the config at the state Worker

In `config/config.yaml`:

```yaml
runHistory:
  worker:
    baseUrl: https://switchboard-memory.<zone>
runtimeOverrides:
  worker:
    baseUrl: https://switchboard-memory.<zone>
```

## Stage the secrets

`deploy/secrets.manifest.json` names every secret and its Workers. Values live at `secretsSource`, one file per name:

```bash
mkdir -p -m 700 ~/.secrets/switchboard
openssl rand -hex 32 > ~/.secrets/switchboard/MEMORY_TOKEN
```

Add `SLACK_BOT_TOKEN`, `SLACK_APP_TOKEN` and `ANTHROPIC_API_KEY` the same way. Then:

```bash
npx @coreplane/switchboard deploy secrets memory
npx @coreplane/switchboard deploy secrets bot
```

- An absent required value refuses before any upload; an absent optional one is skipped, by name. Nothing is printed.
- A shared bearer (`MEMORY_TOKEN`, `SANDBOX_TOKEN`, `RESIDENT_*_TOKEN`) carries one value on every Worker listed for it. `--only NAME` puts a subset.

## Deploy

```bash
npx @coreplane/switchboard deploy plan --only memory,bot
MEMORY_TOKEN="$(cat ~/.secrets/switchboard/MEMORY_TOKEN)" npx @coreplane/switchboard deploy all --only memory,bot
```

`deploy plan` executes nothing; its `Images:` line reads `0 of 1 present; deploy all copies the rest`, or `not probed (<why>)` without a token. `deploy all` checks the account, copies the missing images into your registry, deploys the state Worker, pushes your config to it, deploys the bot, and waits until `/healthz` answers from the new container.

You should see:

```
copied into the account registry: bot …
[deploy:all] bot: live (commit <sha>; 45s after the upload)
deployed and live
```

| Flag | Does |
|---|---|
| `--only bot,resident` · `--skip sandbox` | Select Workers. |
| `--dry-run` | Print the plan and what it would copy; copy and deploy nothing. |
| `--affected` | Only the Workers whose inputs changed since the commit each one serves. |
| `--force` | Bypass the bot and resident preflights. |

Read from the environment: `CLOUDFLARE_API_TOKEN` (the registry read and the copy); `MEMORY_TOKEN` for the bot step; `RESIDENT_READ_TOKEN` for the resident; `SANDBOX_TOKEN` for the sandbox.

## Add the optional Workers

| Worker | Config block | Secrets (shared with the bot) |
|---|---|---|
| resident | `execution.resident.baseUrl` | `RESIDENT_OPERATOR_TOKEN`, `RESIDENT_ADMIN_TOKEN`; the GitHub App triple |
| sandbox | `execution.type: cloudflare`, `execution.url` | `SANDBOX_TOKEN` |

From the package the profile already names them; from a checkout add the two `workers` entries. Mint the bearers, `deploy secrets <worker>` for each, then `deploy all` without `--only`. Repositories are onboarded from chat: `@switchboard repo onboard acme/api`.

## Deploy from your CI

Optional: the same deploy from GitHub Actions. Commit `deploy/profile.json` and `config/config.yaml` to a repository of yours and add:

```yaml
# .github/workflows/deploy-switchboard.yml
name: deploy switchboard
on:
  workflow_dispatch:
    inputs:
      targets:
        default: affected
permissions:
  contents: read
jobs:
  deploy:
    uses: <owner>/<repo>/.github/workflows/deploy-production.yml@v<version>
    permissions:
      contents: read
    with:
      cli: package
      version: <version>
      targets: ${{ inputs.targets || 'affected' }}
    secrets:
      CLOUDFLARE_DEPLOY_TOKEN: ${{ secrets.CLOUDFLARE_DEPLOY_TOKEN }}
      MEMORY_TOKEN: ${{ secrets.MEMORY_TOKEN }}
      RESIDENT_READ_TOKEN: ${{ secrets.RESIDENT_READ_TOKEN }}
      SANDBOX_TOKEN: ${{ secrets.SANDBOX_TOKEN }}
```

`<owner>/<repo>` is this repository; `<version>` is the workflow's tag and the CLI's version. Set the secrets with `gh secret set <NAME>`, then:

```bash
gh workflow run deploy-switchboard.yml -f targets=all   # the first time
gh workflow run deploy-switchboard.yml                  # afterwards: only what is stale
```

## Run the container yourself

Without the Workers every optional capability is off.

```bash
docker run -d --name switchboard --restart unless-stopped --env-file .env -v "$PWD/config:/app/config:ro" ghcr.io/coreplanelabs/switchboard:latest
```

## Next

- [Operate production](operate-production.md): a deploy outside a release, a config change, the span log.
- [Rotate a secret](rotate-a-secret.md): a put and a restart.
- [Release and deploy](../reference/specs/release-and-deploy.md): the contract behind every command here.
