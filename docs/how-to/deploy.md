# Deploy

Goal: Switchboard running in production on Cloudflare — the first time by hand from your machine, and from then on by the release workflow, with a config change or a rotated secret going live without a rebuild.

Cloudflare is the one supported production target: the bot runs as a container behind a Worker, and up to four more Workers give it durable state, sandboxes, resident repositories and a docs site. `docker-compose.yml` in the tree is the local loop — a laptop or a dev box running the same image against your `.env` — not a second production path. This page is the entry point; the two pages it leads to are the day-two operations: [Deploy and rotate a secret](deploy-and-rotate-a-secret.md) (shipping a change, what a PR would deploy, rotation) and [Operate production](operate-production.md) (the preflights, the deploy order, the span log).

## The pieces

| Worker | Directory | What it is | Needed? |
|---|---|---|---|
| bot | `deploy/cloudflare/` | The always-on container: Slack, the model, the dispatcher, the dashboards | yes |
| memory (the state Worker) | `deploy/cloudflare-memory/` | Durable Objects for the config document, run history, the run ledger, memory, schedules, chat-set overrides | yes, in practice: without it the bot's config has nowhere to be pushed and nothing survives a restart |
| resident | `deploy/cloudflare-resident/` | One container per onboarded repository, always warm | optional |
| sandbox | `deploy/cloudflare-sandbox/` | A proxy in front of per-thread execution containers | optional |
| docs | `deploy/cloudflare-docs/` | This site, assets only | optional |

Deploys run in one order — memory, bot, resident, sandbox — because the state Worker's Durable Object migrations must exist before the bot writes to them. `deploy all` is the only runner; nothing here is deployed by hand in parallel. Why the order: [Worker topology](../explanation/worker-topology.md).

## 1. The deployment profile

Every place-specific fact — your account, your zone, each Worker's script name and hostname, where the bot's config comes from — lives in one file, `deploy/profile.json`, which git ignores. `deploy/profile.example.json` is the shape:

```bash
cp deploy/profile.example.json deploy/profile.json
```

Fill in `account` (your Cloudflare account id) and `zone` (a domain in that account), give each Worker you want a hostname under that zone, and delete the Workers you do not want — a profile with only `bot` and `memory` yields a two-step plan. Two optional fields:

- `configSource` — where `deploy all` and `deploy config` read the bot's runtime config: a path (the default, `config/config.yaml`), `github://owner/repo/path@ref` read with `CONFIG_REPO_TOKEN`, or a 1Password reference `op://Vault/Item/field` read with `OP_SERVICE_ACCOUNT_TOKEN`. The image never carries config.
- `secretsSource` — where `deploy secrets` reads values: a directory of files named after the secrets (`~/.secrets/switchboard` when absent) or a 1Password item `op://Vault/Item` with one field per secret name.
- `access` — the Cloudflare Access application in front of the dashboards, as `{ "teamDomain": "<team>.cloudflareaccess.com", "aud": "<the application's AUD tag>" }`. Omit it and the dashboards refuse every remote caller until you add one.

The profile can live somewhere other than the tree: `SWITCHBOARD_DEPLOY_PROFILE` names a path, a `github://` location or an `op://` reference, and every deploy command reads it from there. That is how a CI runner deploys without a checkout of your infrastructure.

## 2. `deploy init` — render the Worker configs

Each Worker's `wrangler.jsonc` is generated from the `wrangler.template.jsonc` beside it and the profile, and git ignores the result, so no account or hostname is ever committed:

```bash
npx tsx src/cli.ts deploy init
```

`deploy init --check` writes nothing and fails when a rendered file differs from its render — a hand edit is drift. Change the template (a binding, a cron, an instance size) and re-render; change the profile where it lives. `deploy all` and `deploy secrets` render for themselves, so this step is for reading what will be deployed, and for `wrangler dev`.

## 3. `deploy secrets` — put each Worker's secrets

`deploy/secrets.manifest.json` is the contract: every secret's name, which Workers hold it, and whether it is optional. The values live at the profile's `secretsSource`. With the default directory, one file per name:

```bash
mkdir -p -m 700 ~/.secrets/switchboard
openssl rand -hex 32 > ~/.secrets/switchboard/MEMORY_TOKEN     # a bearer you mint
openssl rand -hex 32 > ~/.secrets/switchboard/SANDBOX_TOKEN    # …one per shared bearer the manifest lists
```

Then, per Worker, in the deploy order:

```bash
npx tsx src/cli.ts deploy secrets memory
npx tsx src/cli.ts deploy secrets bot
npx tsx src/cli.ts deploy secrets resident
npx tsx src/cli.ts deploy secrets sandbox
```

Each command asks the source once which of the Worker's names it holds and refuses before any upload when a required one is absent, naming the secret and the path it looked at. Values ride stdin into `wrangler secret put`; none is printed. A secret is optional where its feature is: the Brave key, the analytics token and the ingress map everywhere, the sandbox and resident bearers on the bot (required on the Worker that serves them), the GitHub App triple on both the bot and the resident. An absent optional secret is skipped by name and said, so a first deployment puts what it has; `--only NAME,NAME` puts a subset, for a rotation.

Two rules the manifest's notes state and the commands enforce. A **shared bearer** (`MEMORY_TOKEN`, `SANDBOX_TOKEN`, `RESIDENT_OPERATOR_TOKEN`, `RESIDENT_ADMIN_TOKEN`) must carry one value on every Worker listed for it — the bot and the state Worker with different `MEMORY_TOKEN`s fail with 401 on every call. And the GitHub App triple goes on both the bot and the resident Worker: the resident is a second credential domain with its own copy of the key.

## 4. `deploy config` — push the bot's config

The bot's container reads its config at startup from the state Worker, as the document named `base`; the image carries no config file. `deploy all` pushes it for you right before the bot step. To change config without a release, push it alone and restart the container, which otherwise keeps the config it started with:

```bash
MEMORY_TOKEN="$(cat ~/.secrets/switchboard/MEMORY_TOKEN)" npx tsx src/cli.ts deploy config
SWITCHBOARD_DEPLOY_TOKEN=… npx tsx src/cli.ts deploy restart
```

The config is read from the profile's `configSource` (or `--source <path|github://…|op://…>`) and validated before anything is pushed; an unreadable source, a config that does not validate, or a missing `MEMORY_TOKEN` refuses with the reason. `deploy restart` authenticates with an ingress bearer whose identity holds `deploy:write` — an entry in the `SWITCHBOARD_INGRESS_TOKENS` map ([Deploy and rotate a secret](deploy-and-rotate-a-secret.md#rotate-a-secret) has the shape).

## 5. `deploy all` — the whole plan, in order

```bash
npx tsx src/cli.ts deploy plan        # what it would do — nothing executed
MEMORY_TOKEN="$(cat ~/.secrets/switchboard/MEMORY_TOKEN)" npx tsx src/cli.ts deploy all
```

`deploy all` first checks: wrangler's login is the profile's account (or `CLOUDFLARE_API_TOKEN` verifies against it — a token for another account is refused with wrangler's own words, never silently swapped for your login), the tree is clean, `HEAD` is `origin/main` (`--allow-branch` relaxes only that), and the credential can do what the selected Workers need (`wrangler containers list`, `wrangler r2 bucket list`). It reads and validates the config, deploys the state Worker, pushes the config document, deploys the bot and **waits until the bot is live** — `/healthz` answered by a container that is not draining and reports the deployed commit — then the resident and sandbox Workers with their own preflights and live gates. Docker must be running: the bot's image (and the resident's and sandbox's) is built where the command runs.

Bearers the run needs in its own environment: `MEMORY_TOKEN` when the bot is a step (the config push); one of `RESIDENT_ADMIN_TOKEN` / `RESIDENT_OPERATOR_TOKEN` / `RESIDENT_READ_TOKEN` when the resident is (its preflight reads the fleet); `SANDBOX_TOKEN` when the sandbox is (its live gate probes `/exec`).

Selection flags: `--only bot,resident`, `--skip sandbox`, and `--affected`, which deploys only the Workers whose inputs changed since the commit each one is serving — what the release deploy runs. `--force` bypasses the bot and resident preflights and says what it will interrupt.

## What the release workflow does with all this

After the first deployment, nobody deploys routine releases by hand. Every merge to `main` accumulates into one release PR; merging it tags the version, publishes the GitHub release, and a workflow runs `deploy all --affected` on the release commit — the same command, the same checks, the same order. The release PR carries the derived plan as a comment before anyone merges it, and every PR's `deploy targets` check shows what its own diff would deploy.

The workflow needs, as repository secrets: `CLOUDFLARE_DEPLOY_TOKEN` (the scopes in [Set up accounts](set-up-accounts.md#cloudflare-optional-and-what-it-buys)), `MEMORY_TOKEN`, `RESIDENT_READ_TOKEN`, and `SANDBOX_TOKEN` when a sandbox Worker exists. It reads the profile from `SWITCHBOARD_DEPLOY_PROFILE`; the checked-in workflow names the project's own installation's profile in its private infrastructure repository and mints a read-only App token for it, so an installation that wants CI deploys edits that location — and the credential step that mints the token — to point at its own. A manual deploy goes through the same workflow (`gh workflow run deploy-production.yml --ref main -f targets=all`), never from a laptop; it refuses to run from any ref but `main`.

## The local loop: docker compose

For a dev box or a single host you administer yourself, the same image runs under compose with your `.env` and `config/config.yaml` mounted, runtime overrides and workspaces on named volumes, and the health probe on loopback:

```bash
docker compose up -d
docker compose logs -f
```

There is no state Worker in this shape: overrides and run history (with `runHistory.store: file`) live on the volume, tools run on the container with `execution.type: local`, and the dashboards serve loopback callers only. It is the shape for one trusted operator, not for a team.

## See also

- [Deploy and rotate a secret](deploy-and-rotate-a-secret.md) — day two: merge the release PR, read what a PR would deploy, rotate a credential.
- [Operate production](operate-production.md) — the preflights and why a second deploy over a draining container kills a run; reading the bot's span log.
- [Set up accounts](set-up-accounts.md) — every credential above, and how to create it.
- [`docs/reference/specs/release-and-deploy.md`](../reference/specs/release-and-deploy.md) — the contract behind every command on this page.
