# Deploy for the first time

Goal: a fresh Switchboard installation running on Cloudflare — the bot container and whichever Workers you want beside it — with every secret in place and nothing typed twice. The day-to-day path once it is up is [Deploy and rotate a secret](deploy-and-rotate-a-secret.md); the rules for the moments a person is involved are [Operate production](operate-production.md).

Cloudflare is the supported target. The bot is one always-on container; the state Worker, the resident Worker and the sandbox Worker are optional pieces that each turn a capability on ([Turn features on and off](turn-features-on-and-off.md)). A profile with only the bot is a one-step deploy.

## Before you start

- A Cloudflare account and a zone in it (the Workers get hostnames under it), with `wrangler login` done for that account and Docker running (the bot and resident images build locally).
- The Slack app and one provider key from [Run it locally](../tutorials/run-it-locally.md), and the GitHub App if the coding agent should open pull requests.
- A working `config/config.yaml`: the same file the tutorial produced, with the blocks for the Workers you are about to deploy uncommented (`runtimeOverrides.worker`, `runHistory.worker`, `memory.worker`, `execution.resident`, `execution.type: cloudflare`) pointing at the hostnames you choose below.
- No `CLOUDFLARE_API_TOKEN` in your shell unless it is a token for this account: wrangler prefers a token over your login, and a token for another account is refused, never silently swapped.

## 1. Write the deployment profile

Every place-specific fact — the account, each Worker's script name and hostname, where the bot's config and secrets come from — lives in one file. Copy the example and fill it in:

```bash
cp deploy/profile.example.json deploy/profile.json   # gitignored
```

`account` is the 32-character account id; every `hostname` is under `zone`; `workers.bot` is the one required Worker — leave `memory`, `resident`, `sandbox` or `docs` out and the plan has no step for them. `configSource` is where `deploy all` reads the bot's runtime config from (a path, a `github://owner/repo/path@ref` reference, or a secrets-manager reference); `secretsSource` is where the secrets come from — a directory of `<NAME>` files, `~/.secrets/switchboard` when absent, or a 1Password item.

Render each Worker's `wrangler.jsonc` from its template and the profile, and read the plan back:

```bash
npx tsx src/cli.ts deploy init
npx tsx src/cli.ts deploy plan
```

The rendered files are gitignored and regenerated; change the template or the profile, never the rendered file (`npm run deploy:check` says when one was hand-edited).

## 2. Put the secrets

Every secret, and which Worker holds it, is declared in `deploy/secrets.manifest.json`. Place each value at the profile's `secretsSource` — one file per name in the directory, `openssl rand -hex 32` for every self-minted bearer — then put them per Worker:

```bash
npx tsx src/cli.ts deploy secrets memory     # MEMORY_TOKEN
npx tsx src/cli.ts deploy secrets bot        # Slack, provider keys, the bearers it calls the Workers with, the GitHub App
npx tsx src/cli.ts deploy secrets resident   # RESIDENT_*_TOKEN, MEMORY_TOKEN, its own copy of the GitHub App
npx tsx src/cli.ts deploy secrets sandbox    # SANDBOX_TOKEN
```

The command asks the source once which names it holds and refuses before any upload when a required one is absent; optional ones (the Anthropic admin key for the spend page, the R2 credentials, the MCP sealing key) are skipped with a note. Values ride stdin into `wrangler secret put` and are never printed. A **shared** bearer — `MEMORY_TOKEN`, `SANDBOX_TOKEN`, the `RESIDENT_*` tokens — must be the same value on every Worker the manifest lists for it; the manifest is the list. The resident Worker holds its own copy of the GitHub App credential on purpose: it is a second credential domain, and rotating the bot's key does nothing for the resident's ([Execution and trust](../explanation/execution-and-trust.md)).

## 3. Deploy

```bash
npx tsx src/cli.ts deploy all
```

One runner, one order: memory (the state Worker) first, because its Durable Object migrations must exist before the bot writes to them; then the bot; then the resident; then the sandbox. Before any Worker deploys it checks the account, a clean tree at `origin/main`, and the credential's capabilities; it reads and validates the config from `configSource` and pushes it to the state Worker as the `base` document right before the bot step, so the image carries no config and the container reads it at start. Any deploy directory without `node_modules` is installed first. The bot step is finished only when `GET /healthz` on the bot's hostname is answered by a container running the deployed commit and not draining; the command exits non-zero, saying what is still in flight, rather than report success while old code serves. Selection, order and the live gate are unit-tested pure functions; the contract is [release and deploy](../reference/specs/release-and-deploy.md).

Watch the bot connect:

```bash
npm run tail -w deploy/cloudflare        # "switchboard running (providers: anthropic…)"
curl -sS https://<bot hostname>/healthz  # { ok, inFlight, draining, catchUp, slack, build, startedAt, … }
```

`catchUp` reports the reconnect catch-up's last scan and names any Slack scopes the bot token lacks — the way to see a silently failing scope without container logs.

## 4. Onboard the first repository

Repositories are onboarded at runtime from chat, never at deploy time:

```
@switchboard repo onboard acme/api
```

That needs the `repo:write` grant, which only admins hold until granted. What happens next, and how to read the resident's disk and lifecycle: [Onboard a repo](onboard-a-repo.md).

## After the first time

From here, production deploys on the release: merging the release PR runs `deploy all --affected` from CI and redeploys only the Workers whose inputs changed. Putting a new secret value does not restart the running container — rotation is a put followed by `deploy restart`. Both are [Deploy and rotate a secret](deploy-and-rotate-a-secret.md).

## Running the container somewhere else

The image the bot Worker builds is an ordinary container, and Socket Mode is outbound-only, so it also runs anywhere that runs a container — without the Workers, every optional capability is simply off. The tree keeps two such shapes: `docker-compose.yml` is the local loop (`docker compose up -d` with your `config/` mounted read-only and volumes for `data/` and `workspaces/`), and `fly.toml` describes one always-on machine with a volume at `/app/data` (set `workspaceDir: ./data/workspaces` in the config so checkouts land on it). Neither is the supported production path.

Whatever the host, the bot needs:

- **Runtime**: one always-on container, a single instance, no autoscaling. It is mostly idle; a fraction of a vCPU and 1 GiB is the working size ([Capacity and sizing](../explanation/capacity-and-sizing.md)).
- **Network**: outbound HTTPS only — Slack's API and websocket, the model providers, GitHub, and whatever executes tools. Zero inbound is required; set `PORT` to expose `/healthz` and the dashboard, and `PUBLIC_BASE_URL` so status cards can link to run pages.
- **Secrets as environment variables**: `SLACK_BOT_TOKEN`, `SLACK_APP_TOKEN`, the provider keys the config names, the GitHub App triple or `GH_TOKEN`, and the bearers for whichever Workers the config points at. `.env.example` lists them with a note each.
- **No cloud credentials on the host**: the bot makes no cloud API calls of its own, and its agents execute model-generated commands, so least privilege matters here specifically.
- **Storage**: an optional small volume at `/app/data`. Without it the bot degrades gracefully: repositories re-clone, thread context rebuilds from the channel, and only the chat-set overrides and the sandbox map are lost on restart — unless the state Worker holds them.
- **Health and logs**: `GET /healthz` returns 200 with the JSON above; logs go to stdout, one JSON span line per request when `tracing.log` is on.

## See also

- [Explanation: Worker topology](../explanation/worker-topology.md) — what each Worker owns and why the order is what it is.
- [Explanation: execution and trust](../explanation/execution-and-trust.md) — why the resident holds its own GitHub credential.
- [Reference: configuration](../reference/configuration.md) — every block the profile's `configSource` may carry.
