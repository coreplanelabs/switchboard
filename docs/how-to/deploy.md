# Deploy

Goal: OpenSwitchboard running in production on Cloudflare — the first time by hand from your machine, and from then on by the release workflow, with a config change or a rotated secret going live without a rebuild.

Cloudflare is the one supported production target: the bot runs as a container behind a Worker, and up to three more Workers give it durable state, sandboxes and resident repositories. The docs site is the project's website, not a piece an installation deploys. `docker-compose.yml` in the tree is the local loop — a laptop or a dev box running the same image against your `.env` — not a second production path. This page is the first deployment, by hand; the day-two pages are [Ship a release](ship-a-release.md) (production deploys on the release, from CI), [Rotate a secret](rotate-a-secret.md) and [Operate production](operate-production.md) (a deploy or a config change outside a release, the preflights, the span log). Why one target: [the decision record](../decisions/0023-one-production-target.md).

## The pieces

| Worker | Directory | What it is | Needed? |
|---|---|---|---|
| bot | `deploy/cloudflare/` | The always-on container: Slack, the model, the dispatcher, the dashboards | yes |
| memory (the state Worker) | `deploy/cloudflare-memory/` | Durable Objects for the config document, run history, the run ledger, memory, schedules, chat-set overrides | yes, in practice: without it the bot's config has nowhere to be pushed and nothing survives a restart |
| resident | `deploy/cloudflare-resident/` | One container per onboarded repository, always warm | optional |
| sandbox | `deploy/cloudflare-sandbox/` | A proxy in front of per-thread execution containers | optional |

Deploys run in one order — memory, bot, resident, sandbox — because the state Worker's Durable Object migrations must exist before the bot writes to them. `deploy all` is the only runner; nothing here is deployed by hand in parallel. Why the order: [Worker topology](../explanation/worker-topology.md).

## Before you start

- A Cloudflare account and a domain (a *zone*) in it: every Worker gets a hostname under it. `npx wrangler login` done once for that account. Docker running, once: either where `deploy all` runs (the profile's `images: "build"` — the bot's, resident's and sandbox's images build there) or where `deploy images` runs (`images: "registry"` — the release's published images are copied into your account's registry once per version, and `deploy all` then builds nothing; [step 5](#5-deploy-images--copy-the-releases-images-registry-mode)).
- No `CLOUDFLARE_API_TOKEN` in your shell unless it is a token for this account: wrangler prefers a token over your login, and a token for another account is refused, never silently swapped.
- The Slack app and one provider key from [Get started](../tutorials/get-started.md), and the GitHub App if the coding agent should open pull requests ([Set up accounts](set-up-accounts.md)).
- A `config/config.yaml` whose blocks point at the Workers you are about to deploy — `runtimeOverrides.worker` and `runHistory.worker` at the state Worker's hostname, `memory.worker` if you want memory, `execution.resident.baseUrl` and `execution.type: cloudflare` with `execution.url` for the resident and sandbox Workers.
- A directory to deploy from. Two shapes, one set of commands: a **checkout** of the repository at `origin/main` with `npm ci` run — what contributors and the release workflow use — or an **operator directory**: any directory, when the CLI is the published npm package (`npx @coreplane/switchboard`, [Get started](../tutorials/get-started.md)). `init --cloudflare` writes the profile there and `deploy plan|init|secrets|config|all` run from it with no clone; what it holds and what still needs a checkout is [below](#deploying-from-the-package). Every `npx tsx src/cli.ts …` on this page is the checkout's CLI; from an operator directory the same command is `npx @coreplane/switchboard …`.

## 1. The deployment profile

Every place-specific fact — your account, your zone, each Worker's script name and hostname, where the bot's config comes from — lives in one file, `deploy/profile.json`, which git ignores. The installer writes the two-Worker shape for you — the bot and the state Worker, named from `--name` under your zone — and renders the Worker configs in the same step:

```bash
npx tsx src/cli.ts init --organization <org> --anthropic-key <key> --cloudflare <account id> --zone example.com
```

For any other shape, `deploy/profile.example.json` is the template:

```bash
cp deploy/profile.example.json deploy/profile.json
```

Fill in `account` (your Cloudflare account id) and `zone` (a domain in that account), give each Worker you want a hostname under that zone, and delete the Workers you do not want — a profile with only `bot` and `memory` yields a two-step plan. The other fields:

- `images` — where the bot's, resident's and sandbox's container images come from. `"registry"` (what the example says): the images every release publishes, copied once per version into your account's Cloudflare registry by [`deploy images`](#5-deploy-images--copy-the-releases-images-registry-mode) and referenced from there — no Docker where `deploy all` runs, and every container start pulls from Cloudflare's own cached registry. `"build"` (the default when the field is absent): each Worker's Dockerfile, built by wrangler where `deploy all` runs — a checkout's shape, and how this project's own production deploys. Why the copy rather than a direct pull from GitHub's registry: [the decision record](../decisions/0027-images-copied-into-the-account-registry.md).
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

The bot's container reads its config at startup from the state Worker, as the document named `base`; the image carries no config file. `deploy all` pushes it for you right before the bot step, so on a first deployment there is nothing to run here — the command exists on its own for later:

```bash
MEMORY_TOKEN="$(cat ~/.secrets/switchboard/MEMORY_TOKEN)" npx tsx src/cli.ts deploy config
```

The config is read from the profile's `configSource` (or `--source <path|github://…|op://…>`) and validated before anything is pushed; an unreadable source, a config that does not validate, or a missing `MEMORY_TOKEN` refuses with the reason. A running container keeps the config it started with, so a change pushed on its own goes live on a restart: [Operate production](operate-production.md#3-change-the-config-without-a-release).

## 5. `deploy images` — copy the release's images (registry mode)

With `"images": "registry"` in the profile, the Workers deploy the images the release published rather than building them. Cloudflare's Containers pull from Cloudflare's own registry (cached, pre-fetched), not from GitHub's, so the images are copied into your account once per version:

```bash
npx tsx src/cli.ts deploy images --dry-run   # which of the three the account registry already holds
npx tsx src/cli.ts deploy images             # pull, tag, `wrangler containers push` the missing ones
```

For each of the bot, resident and sandbox images at this CLI's version — the only version the rendered configs reference, so there is no flag to copy another release; run that release's CLI — the command asks the account registry whether it already holds `registry.cloudflare.com/<account>/<name>:<version>` and skips it if so; otherwise it pulls `ghcr.io/<owner>/<repo>[-resident|-sandbox]:<version>`, tags it under the bare name and pushes it with wrangler, then lists the registry again and refuses unless every copy appears. It needs Docker where it runs — a CI runner has one; a laptop without it is refused before anything is pulled, naming the reusable deploy workflow as the place to run it — and the account's credential with the Containers scope. Run it once per release, before `deploy all`; a second run finds everything `present` and copies nothing. In `registry` mode `deploy plan` and `deploy all` check the same listing and refuse a Worker whose image is missing, naming this command.

Our own production stays on `"images": "build"`: this repository's release builds the same Dockerfiles with wrangler at deploy time, so this step does not exist there.

## 6. `deploy all` — the whole plan, in order

```bash
npx tsx src/cli.ts deploy plan        # what it would do — nothing executed
MEMORY_TOKEN="$(cat ~/.secrets/switchboard/MEMORY_TOKEN)" npx tsx src/cli.ts deploy all
```

`deploy all` first checks: wrangler's login is the profile's account (or `CLOUDFLARE_API_TOKEN` verifies against it — a token for another account is refused with wrangler's own words, never silently swapped for your login), from a checkout that the tree is clean and `HEAD` is `origin/main` (`--allow-branch` relaxes only that; from an operator directory there is no tree — the Worker sources are the package's, at its version), and the credential can do what the selected Workers need (`wrangler containers list`, `wrangler r2 bucket list`). It reads and validates the config, deploys the state Worker, pushes the config document, deploys the bot and **waits until the bot is live** — `/healthz` answered by a container that is not draining and reports the deployed commit — then the resident and sandbox Workers with their own preflights and live gates. The plan's `Images:` line says where each Worker's container comes from: in `build` mode Docker must be running where the command runs (the bot's image, and the resident's and sandbox's, are built there); in `registry` mode nothing is built and the line says whether each image is present in the account registry.

Bearers the run needs in its own environment: `MEMORY_TOKEN` when the bot is a step (the config push); one of `RESIDENT_ADMIN_TOKEN` / `RESIDENT_OPERATOR_TOKEN` / `RESIDENT_READ_TOKEN` when the resident is (its preflight reads the fleet); `SANDBOX_TOKEN` when the sandbox is (its live gate probes `/exec`).

Selection flags: `--only bot,resident`, `--skip sandbox`, and `--affected`, which deploys only the Workers whose inputs changed since the commit each one is serving — what the release deploy runs. `--force` bypasses the bot and resident preflights and says what it will interrupt.

Watch the bot connect, then confirm it from the outside:

```bash
npm run tail -w deploy/cloudflare        # "switchboard running (providers: anthropic…)"
curl -sS https://<bot hostname>/healthz  # { ok, inFlight, draining, catchUp, build, startedAt, … }
```

`catchUp` reports the reconnect catch-up's last scan and names any Slack scopes the bot token lacks — the way to see a silently failing scope without container logs.

## Deploying from the package

With the CLI from npm, the directory you run `init` in is the installation: `deploy plan`, `deploy init`, `deploy secrets`, `deploy config` and `deploy all` all run from it, and no checkout is involved. `deploy plan` says so on its first line — `Root: <the directory> (the published package <version>)` — and every path in the plan is relative to it.

```bash
mkdir switchboard && cd switchboard
npx @coreplane/switchboard init --organization <org> --anthropic-key <key> --cloudflare <account id> --zone example.com
npx @coreplane/switchboard deploy plan
```

What is there afterwards:

- **Yours**: `.env` (mode 600), `config/config.yaml`, and `deploy/profile.json` — the same three files `init` writes in a checkout, in the same places. A relative `configSource` or `secretsSource` in the profile is relative to this directory.
- **`.switchboard/`**: the work area the deploy commands own. It holds a copy of the tree the package shipped — each Worker's directory (its `wrangler.template.jsonc`, `worker.ts`, `package.json`, Dockerfile), the sources under `src/` those Workers import, the deploy scripts, and the repository's `package.json` and `package-lock.json` — plus what the commands produce: each Worker's rendered `wrangler.jsonc` beside its template (`deploy init` prints `written .switchboard/deploy/<worker>/wrangler.jsonc`) and, once `deploy secrets` or `deploy all` has run wrangler for a Worker, its `node_modules`, installed with `npm ci --workspace deploy/<worker>` against the shipped lockfile — the versions the release was tested with, never what your machine resolved that day. A stamp, `.materialised.json`, records the CLI version the copy came from and the Workers installed; a CLI at another version starts the work area over. Nothing is ever written inside the installed package, and a `.switchboard/` the CLI did not stamp is refused, not deleted.
- **No git.** In a checkout `deploy all` refuses a dirty tree or a `HEAD` off `origin/main`; from the package there is no tree to check, and the commit every Worker is stamped with — what the live gates compare `/healthz` against — is the one the package was built from.

The images are where the profile's `images` mode matters most. With `"images": "registry"` (the example's shape) nothing is built from the package: [`deploy images`](#5-deploy-images--copy-the-releases-images-registry-mode) copies the release's three images into your account registry once per version — it runs wrangler in the materialised bot directory, so the work area is brought up first — and every Worker, the bot included, deploys the copy. With `"images": "build"` the resident's and sandbox's images are built where `deploy all` runs, from the Dockerfiles in their materialised directories, exactly as from a checkout — but the bot's image is the repository's root `Dockerfile`, built from `src/`, `web/` and the toolchain, which the package does not carry, so `deploy all` refuses the bot step up front, naming this and the `registry` mode as the way out, rather than rolling the state Worker and then failing.

## 7. Onboard the first repository

Repositories are onboarded at runtime from chat, never at deploy time:

```
@switchboard repo onboard acme/api
```

That needs the `repo:write` grant, which only admins hold until granted. What happens next, and how to read the resident's disk and lifecycle: [Onboard a repo](onboard-a-repo.md).

## After the first time

Nobody deploys routine releases by hand: merging the release PR runs the same `deploy all` from CI, with `--affected` so only the Workers whose inputs changed roll — [Ship a release](ship-a-release.md). For CI to do that it needs the deploy credentials as repository secrets and the profile's location as a repository variable, both set once: [Configure the repository](configure-the-repository.md#5-repository-secrets-and-variables). A deploy outside a release, or a config change without one, is [Operate production](operate-production.md).

## Running the container somewhere else

The image the bot Worker builds is an ordinary container, and Socket Mode is outbound-only, so it also runs anywhere that runs a container — without the Workers, every optional capability is simply off. The one shape the tree keeps is the local loop, `docker-compose.yml`: the same image on a dev box, or on one host a single trusted operator administers, with your `.env` and `config/config.yaml` mounted, runtime overrides and workspaces on named volumes, and the health probe on loopback:

```bash
docker compose pull     # the image the last release published — or `docker compose build` to build it here
docker compose up -d
docker compose logs -f
```

Every release publishes that image to GitHub Container Registry as `ghcr.io/<owner>/<repo>:<version>` and `:latest` — the owner and name are the repository's, lowercased — built from the root `Dockerfile` with a build-provenance attestation and an SBOM attached; the resident's and the sandbox's images publish beside it as `ghcr.io/<owner>/<repo>-resident` and `ghcr.io/<owner>/<repo>-sandbox`, the ones a `registry`-mode deployment copies ([step 5](#5-deploy-images--copy-the-releases-images-registry-mode)). `docker compose pull` fetches the bot's; `docker compose build` builds the same Dockerfile locally under the same name, and `up` runs whichever is present. Before you run an image you did not build, check that it came from this repository's release workflow and nothing else:

```bash
gh attestation verify oci://ghcr.io/<owner>/<repo>:<version> --owner <owner>
docker buildx imagetools inspect ghcr.io/<owner>/<repo>:<version> --format '{{ json .SBOM }}'
```

The first resolves the tag to its digest and checks the signed attestation against the workflow that built it; the second prints the SBOM. This project's own production does not pull these images — its profile is in `build` mode and wrangler builds the same Dockerfiles at deploy time — so a release that failed to publish still deploys there, and the image is yours to run without the Workers.

There is no state Worker in this shape: overrides and run history (with `runHistory.store: file`) live on the volume, tools run on the container with `execution.type: local`, and the dashboards serve loopback callers only. Nothing else is built or tested as a host — the deploy tooling, the secrets path and these pages are Cloudflare's.

Whatever the host, the bot needs:

- **Runtime**: one always-on container, a single instance, no autoscaling. It is mostly idle; a fraction of a vCPU and 1 GiB is the working size ([Capacity and sizing](../explanation/capacity-and-sizing.md)).
- **Network**: outbound HTTPS only — Slack's API and websocket, the model providers, GitHub, and whatever executes tools. Zero inbound is required; set `PORT` to expose `/healthz` and the dashboard, and `PUBLIC_BASE_URL` so status cards can link to run pages.
- **Secrets as environment variables**: `SLACK_BOT_TOKEN`, `SLACK_APP_TOKEN`, the provider keys the config names, the GitHub App triple or `GH_TOKEN`, and the bearers for whichever Workers the config points at. `.env.example` lists them with a note each.
- **No cloud credentials on the host**: the bot makes no cloud API calls of its own, and its agents execute model-generated commands, so least privilege matters here specifically.
- **Storage**: an optional small volume at `/app/data`. Without it the bot degrades gracefully: repositories re-clone, thread context rebuilds from the channel, and only the chat-set overrides and the sandbox map are lost on restart — unless the state Worker holds them.
- **Health and logs**: `GET /healthz` returns 200 with the JSON above; logs go to stdout, one JSON span line per request when `tracing.log` is on.

## See also

- [Ship a release](ship-a-release.md) and [Rotate a secret](rotate-a-secret.md) — day two: merge the release PR, read what a PR would deploy, rotate a credential.
- [Operate production](operate-production.md) — the preflights and why a second deploy over a draining container kills a run; reading the bot's span log.
- [Set up accounts](set-up-accounts.md) — every credential above, and how to create it.
- [Explanation: Worker topology](../explanation/worker-topology.md) — what each Worker owns and why the order is what it is.
- [`docs/reference/specs/release-and-deploy.md`](../reference/specs/release-and-deploy.md) — the contract behind every command on this page.
