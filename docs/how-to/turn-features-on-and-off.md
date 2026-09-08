# Turn features on and off

Goal: run exactly the Switchboard you need — a Slack bot with one provider on a laptop, or the full four-Worker deployment — and know, before you change a block of `config.yaml`, what will appear, what will disappear, and what it will cost you to run.

Everything optional is a **capability**: computed once when the process starts, from `config.yaml` and the environment, and read by every surface. A capability that is off is not a feature that answers "unavailable" — it is a feature that is not there. Its commands are absent from `help`, from the CLI and MCP catalogues and from `/api`; its dashboard section is not in the nav; the agent's own account of itself does not mention it; `deploy plan` does not list its Worker. Turn it on and all of that appears at once, from one change. The exact rules are the contract in [`features/capabilities.md`](https://github.com/coreplanelabs/switchboard/blob/main/features/capabilities.md).

## The matrix

| Capability | Turn it on | What appears | What disappears when off | What it costs |
|---|---|---|---|---|
| `execution` | `execution.type: local` (default) · `e2b` + `E2B_API_KEY` · `cloudflare` + `execution.url` + `SANDBOX_TOKEN` | Where every `bash` call actually runs. `cloudflare` puts each thread's tools in its own sandbox container; `local` runs them on the bot host | Nothing is hidden — `local` is a real mode. What changes is trust: with `local`, anyone who can reach the coding agent can run commands on the host ([execution and trust](../explanation/execution-and-trust.md)) | `cloudflare`: the sandbox Worker (`deploy/cloudflare-sandbox/`) and its container image, billed per running instance; `e2b`: an E2B account |
| `residents` | `execution.resident.baseUrl` + `RESIDENT_OPERATOR_TOKEN` (runs) and `RESIDENT_ADMIN_TOKEN` (`repo …`) | The `repo` commands; the **Residents** dashboard section and `/residents`; the resident paragraph in the agent's self-description; a warm environment per onboarded repo ([Onboard a repo](onboard-a-repo.md)) | Every request clones cold into a per-thread workspace; the status card no longer notes "not onboarded as a resident" | The resident Worker (`deploy/cloudflare-resident/`): one Durable Object and one container per onboarded repo, an R2 bucket for snapshots — the most expensive thing Switchboard runs |
| `memory` | `memory.enabled: true`; durable with `memory.worker.baseUrl` + `MEMORY_TOKEN` | The `memory` commands; the background-memory block on every model turn; the reflection pass after a run | Model input is byte-identical to a build without memory | Nothing extra on a laptop (in-process store, lost on restart — the log says so); durable memory needs the state Worker (`deploy/cloudflare-memory/`) |
| `runHistory` | `runHistory.store: file`, or `runHistory.worker.baseUrl` + `MEMORY_TOKEN` | Finished runs stay readable on `/runs?all=1` and through `runs get`/`runs events` for `retentionDays`; `friction report` has runs to read; the retention sentence on `/runs` names the window | Finished runs are evicted about a minute after they end; the `/runs` toggle says so | `file`: host disk under `data/runs/` (ephemeral on Cloudflare Containers); `worker`: the state Worker's `RunHistoryDO` |
| `runLedger` | Run history on the state Worker (a `worker`, not `file`) | A live run survives a bot restart: the next container reclaims it, a follow-up steers into it, `/runs` lists runs from every bot generation ([Runs: live, then remembered](../explanation/runs-live-and-history.md)) | A restart mid-run loses the run; its card is closed as interrupted | Included in the state Worker |
| `mcp` | An `mcp` block (`credentialKeyEnv`, default `MCP_CREDENTIAL_KEY`, 32 bytes base64) | The `mcp` commands; `mcp__<server>__<tool>` tools on runs; the one-time connect page; the MCP line in the runtime-config block ([Connect an MCP server](connect-an-mcp-server.md)) | No external tools; servers listed under `mcpServers` in any tier are never connected | Nothing extra locally (sealed credentials in `data/mcp-secrets.json`); with `runtimeOverrides.worker` they live on the state Worker |
| `costs` | A `costs` block + `CF_ANALYTICS_TOKEN` (Account Analytics: Read); optional `ANTHROPIC_ADMIN_KEY` | The **Costs** dashboard section, `/costs` and `/costs/<group>.json` ([Watch a run and check spend](watch-a-run-and-check-spend.md)) | The section is not in the nav; `/costs` answers 503 | Read-only API tokens; priced live, nothing stored |
| `schedules` | `schedules.worker.baseUrl` + `MEMORY_TOKEN`; the shim's cron identity in `SWITCHBOARD_INGRESS_TOKENS` with a `grants.http:cron` entry | Firing history on the **Scheduled** tab and in `schedule list` — when each job last ran, its outcome, a link to the run | The tab lists the schedules with no firing history | The state Worker's `ScheduleDO`; the bot Worker's cron triggers |
| `github` | The App triple `GITHUB_APP_ID` + `GITHUB_APP_PRIVATE_KEY` + `GITHUB_APP_INSTALLATION_ID`, or a personal `GH_TOKEN` | The `github_*` tools (repo reads, issue writes) for the agents that carry them; the coding agent's push and PR; `friction propose` filing issues | Agents answer from the conversation and the web only; the coding agent cannot open a PR | A GitHub App (recommended: scoped, rotates) or one personal token |
| `ingress` | `SWITCHBOARD_INGRESS_TOKENS` — a JSON map of bearer → `{ subject, channel? }`, each subject granted in `grants.http:<subject>` / `mcp:<subject>` | `POST /ingress` and the MCP server at `/mcp` — CI, cron and other agents drive Switchboard without Slack ([HTTP](../reference/dashboard-routes.md), [MCP](connect-an-mcp-server.md)) | Both routes refuse every bearer; Slack and the CLI are the only ways in | Nothing — a token is a string you mint |
| `dashboardAuth` | `access`: `ACCESS_TEAM_DOMAIN` + `ACCESS_AUD` (a Cloudflare Access application in front of the bot's hostname); `none`: `ACCESS_DEV_BYPASS=1` on a laptop | `access`: the dashboards for anyone your Access policy admits, service tokens for machines. `none`: the dashboards for loopback callers only | With neither, `token`: no browser session can be proven, so every page route refuses and the process answers bearer tokens only (`/ingress`, `/mcp`, `/healthz`) | Cloudflare Access (Zero Trust, free tier covers small teams) |
| `docs` | `DOCS_BASE_URL` — rendered from the profile's `workers.docs` on Cloudflare, or the `npm run docs:dev` URL locally | `/docs` redirects to this installation's own docs site; the dashboard header's docs icon points there | `/docs` sends people to the project's published docs | The assets-only docs Worker (`deploy/cloudflare-docs/`) — deploys in seconds, cannot disturb a run |

The `MEMORY_TOKEN` rows share one Worker: `memory.worker`, `runHistory.worker`, `schedules.worker` and `runtimeOverrides.worker` all name the state Worker (`deploy/cloudflare-memory/`) with the same bearer. Deploy it once and four capabilities are a config block away ([Worker topology](../explanation/worker-topology.md)).

## Which commands each capability turns on

This table is generated from the command registry — every command declares the capability it needs on its own definition, and `npm run docs:check` fails when this table and the code disagree.

<!-- generated:capability-commands · npm run docs:gen — generated from the code, do not edit by hand -->

| Capability | Commands it turns on |
|---|---|
| `execution` | — |
| `residents` | — |
| `memory` | — |
| `runHistory` | — |
| `runLedger` | — |
| `mcp` | — |
| `costs` | — |
| `schedules` | — |
| `github` | — |
| `ingress` | — |
| `dashboardAuth` | — |
| `docs` | — |

The other 35 commands are on in every installation.

<!-- /generated:capability-commands -->

## Three shapes to start from

Each of these is a complete `config.yaml` plus an environment, kept as a test fixture the suite round-trips through the capability computation — so they cannot drift from the rules above. Copy the one nearest to you from [`src/core/testing/capabilityFixtures.ts`](https://github.com/coreplanelabs/switchboard/blob/main/src/core/testing/capabilityFixtures.ts) and turn things on one block at a time.

| Shape | What is on | Start here |
|---|---|---|
| **minimal** | Slack and one provider. Tools run on the bot host. `ACCESS_DEV_BYPASS=1` for the dashboards on loopback. Nothing optional. | [Run it locally](../tutorials/run-it-locally.md) — this is that tutorial's configuration |
| **local-full** | Everything a laptop can turn on: memory (in-process), run history on disk, GitHub via `GH_TOKEN`, an `mcp` block, one ingress bearer, a local docs URL. No Workers — so no residents, costs, schedules or ledger, and execution stays `local`. | Add blocks to the minimal config; the [configuration reference](../reference/configuration.md) has each one's off-state |
| **cloud-full** | Everything on: the four Workers, tools in a Cloudflare sandbox, resident repos, memory, run history and the ledger on the state Worker, MCP, costs, schedules, the GitHub App, ingress, Access, a docs site. | [Deploy and rotate a secret](deploy-and-rotate-a-secret.md), then [Operate production](operate-production.md) |

## Check what is on

The bot logs the value it computed at startup: `[capabilities] {"execution":"local","residents":false,…}`. Every dashboard page carries the same value in its seed, which is how the nav knows which sections exist. If a command you expect is missing from `help`, that line says why before you read any config.

## See also

- [Reference: configuration](../reference/configuration.md) — every block, what it does, what happens when it is absent.
- [Explanation: Worker topology](../explanation/worker-topology.md) — which Worker owns which capability.
- [Explanation: execution and trust](../explanation/execution-and-trust.md) — why `execution` is the one capability that is about safety, not features.
