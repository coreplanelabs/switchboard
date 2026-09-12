# Turn features on and off

Add one `config.yaml` block and its env vars, restart, and that capability's commands, dashboard section and Worker appear together.

**You need:** `config.yaml`, its environment, and a way to make a change live (restart; on Cloudflare `deploy config` then `deploy restart`, see [Operate production](operate-production.md)).

## Pick a shape

Copy the nearest fixture from [`src/core/testing/capabilityFixtures.ts`](../../src/core/testing/capabilityFixtures.ts).

| Shape | What is on | Start here |
|---|---|---|
| **minimal** | Slack and one provider; tools on the bot host; `dashboardAuth: none` (loopback only) | [Run it locally](../tutorials/run-it-locally.md) |
| **local-full** | minimal + in-process memory, run history on disk, `GH_TOKEN`, an `mcp` block, one ingress bearer, a local docs URL. No Workers, so no residents, costs, schedules or ledger | Add blocks to minimal ([Configuration](../reference/configuration.md)) |
| **cloud-full** | Four Workers: sandbox execution, residents, durable memory, run history, ledger, MCP, costs, schedules, GitHub App, ingress, Access | [Deploy](deploy.md), then [Operate production](operate-production.md) |

## Add the block

| Capability | Turn it on | On | Off | Cost |
|---|---|---|---|---|
| `execution` | `execution.type: local` (default) · `e2b` + `E2B_API_KEY` · `cloudflare` + `execution.url` + `SANDBOX_TOKEN` | Where `bash` runs. `cloudflare`: one sandbox container per thread; `local`: the bot host | Nothing hidden. `local` lets anyone who reaches the coding agent run commands on the host ([Execution and trust](../explanation/execution-and-trust.md)) | `cloudflare`: the sandbox Worker (`deploy/cloudflare-sandbox/`), billed per running instance; `e2b`: an E2B account |
| `residents` | `execution.resident.baseUrl` + `RESIDENT_OPERATOR_TOKEN` (runs) + `RESIDENT_ADMIN_TOKEN` (`repo …`) | `repo` commands; **Residents** section and `/residents`; a warm environment per onboarded repository ([Onboard a repo](onboard-a-repo.md)) | Every request clones cold into a per-thread workspace | The resident Worker (`deploy/cloudflare-resident/`): one Durable Object and one container per repository, an R2 bucket. The most expensive capability |
| `memory` | `memory.enabled: true`; durable with `memory.worker.baseUrl` + `MEMORY_TOKEN` | `memory` commands; background-memory block on every turn; reflection pass after a run | Model input byte-identical to a build without memory | Laptop: nothing (in-process, lost on restart); durable: the state Worker (`deploy/cloudflare-memory/`) |
| `runHistory` | `runHistory.store: file`, or `runHistory.worker.baseUrl` + `MEMORY_TOKEN` | Finished runs stay on `/runs?all=1`, `runs get` and `runs events` for `retentionDays`; `friction report` has runs to read | Finished runs evicted about a minute after they end | `file`: host disk under `data/runs/` (ephemeral on Cloudflare Containers); `worker`: the state Worker's `RunHistoryDO` |
| `runLedger` | Run history on the state Worker (`worker`, not `file`) | A live run survives a bot restart; a follow-up steers into it; `/runs` lists every bot generation | A restart mid-run loses the run; its card closes as interrupted | Included in the state Worker |
| `mcp` | An `mcp` block (`credentialKeyEnv`, default `MCP_CREDENTIAL_KEY`, 32 bytes base64) | `mcp` commands; `mcp__<server>__<tool>` tools on runs; the one-time connect page ([Connect an MCP server](connect-an-mcp-server.md)) | No external tools; `mcpServers` entries never connect | Local: sealed credentials in `data/mcp-secrets.json`; with `runtimeOverrides.worker`: the state Worker |
| `costs` | A `costs` block + `CF_ANALYTICS_TOKEN` (Account Analytics: Read); optional `ANTHROPIC_ADMIN_KEY` | **Costs** section, `/costs`, `/costs/<group>.json` ([Check spend](check-spend.md)) | `/costs` answers 503 | Read-only API tokens; nothing stored |
| `schedules` | `schedules.worker.baseUrl` + `MEMORY_TOKEN`; the cron identity in `SWITCHBOARD_INGRESS_TOKENS` with a `grants.http:cron` entry | Firing history on the **Scheduled** tab and in `schedule list` | Schedules listed, no firing history | The state Worker's `ScheduleDO`; the bot Worker's cron triggers |
| `github` | `GITHUB_APP_ID` + `GITHUB_APP_PRIVATE_KEY` + `GITHUB_APP_INSTALLATION_ID`, or a personal `GH_TOKEN` | `github_*` tools; the coding agent's push and PR; `friction propose` files issues; the **Delivery** section, `/delivery` and `delivery report` (repositories under `delivery.repos`) | Agents answer from the conversation and the web; no PRs; `/delivery` answers 503 | A GitHub App (recommended: scoped, rotates) or one personal token |
| `ingress` | `SWITCHBOARD_INGRESS_TOKENS`: JSON map bearer → `{ subject, channel? }`, each subject granted in `grants.http:<subject>` / `mcp:<subject>` | `POST /ingress` and the MCP server at `/mcp` | Both routes refuse every bearer | Nothing |
| `readingDiffAbridge` | The `meat` binary on the bot host's PATH (the bot image ships it) + the Anthropic provider's key + `review.readingDiff.provider` not `off` (see below) | `review abridge`; with `provider: meat` an abridged diff on every review | Reviews record the full diff only; no `review abridge` anywhere | One Opus-class call per abridged review |
| `dashboardAuth` | `dashboard.auth`; default `access` when `ACCESS_TEAM_DOMAIN` + `ACCESS_AUD` are set, else `none`. `token` needs `dashboard.token.actor` and `DASHBOARD_TOKEN` (or the env var `dashboard.token.env` names) | `access`: anyone your Access policy admits, service tokens for machines. `token`: dashboards and `/api/*` for the bearer as one actor. `none`: loopback callers only | `none` refuses every remote caller; an explicit `none` on a public `PUBLIC_BASE_URL` refuses to start | Cloudflare Access (free tier covers small teams); `token` and `none`: nothing |

### Abridged reading diffs (meat)

Every PR review already records its full `git diff`. `review abridge <run id>` (chat, CLI, `POST /api/review.abridge`; needs `review:write`) adds [meat.dev](https://github.com/boldsoftware/meat)'s abridged version — run on the bot host over the complete diff GitHub serves for the PR, with the bot's own Anthropic key — and stores it on the run; ask again and the stored one is answered. To have it happen on every review, set:

```yaml
review:
  readingDiff:
    provider: meat # git (default): on demand only · off: no reading diff at all
    meatModel: claude-opus-5 # the default; an Opus-class model is the floor that actually abridges
    meatTimeoutS: 240
```

Cost: one Opus-class call per review (meat caches by model + diff, so a repeat is free). It never delays the review: the abridging runs after the record is written, and a restart mid-run simply leaves the run to be abridged on demand. Needs `runHistory` (the record it is appended to) and the GitHub App or `GH_TOKEN` (the compare diff; a whole recorded diff is the fallback). `SWITCHBOARD_READING_DIFF=git|meat|off` overrides `provider` on a deployed bot.

`memory.worker`, `runHistory.worker`, `schedules.worker` and `runtimeOverrides.worker` all name the state Worker, same `MEMORY_TOKEN`; deploy it once. The delivery page's snapshot rides whichever of them is set (no block of its own) and stays in memory without one.

## Check which commands you turned on

A command under two capabilities is on when either gives it a backend.

<!-- generated:capability-commands · npm run docs:gen — generated from the code, do not edit by hand -->

| Capability | Commands that depend on it |
|---|---|
| `execution` | `repo test`, `repo build` |
| `residents` | `repo list`, `repo onboard`, `repo offboard`, `repo reconfigure`, `repo rebuild`, `repo test`, `repo build` |
| `memory` | `memory list`, `memory forget` |
| `runHistory` | `review abridge`, `friction report`, `friction propose` |
| `runLedger` | — |
| `mcp` | `mcp list`, `mcp add`, `mcp connect`, `mcp show`, `mcp remove` |
| `costs` | — |
| `schedules` | `schedule list` |
| `github` | `delivery report` |
| `ingress` | — |
| `readingDiffAbridge` | `review abridge` |
| `dashboardAuth` | — |

The other 22 commands are on in every installation.

<!-- /generated:capability-commands -->

## Restart and confirm

You should see, in the startup log:

```
[capabilities] {"execution":"local","residents":false,…}
```

A missing env var fails fast, by name; if a command is missing from `help`, this says why.

## Next

- [Capabilities](../reference/specs/capabilities.md): the contract per block and off-state.
- [Configuration](../reference/configuration.md): every block.
- [Worker topology](../explanation/worker-topology.md): which Worker owns which capability.
