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
| `routing.auto` | **On by default** — nothing to add. `routing: { auto: false }` turns it off; optional `routing.model: <provider>/<model>` (default `defaults.models.general`, the fast model); optional `routing.answer: text` for a provider or model that cannot take a forced tool call (default `tool`: the router's model answers through a forced tool call whose schema is the answer) | A plain message — no `agent:` directive, no sticky preset, no channel or user `agent` — asks the fast model which preset it means: the card reads `routed: <reason>`, the record carries a `route` event; every routed preset dispatches at once — a wrong route to `coding` costs a pull request, the owner's accepted risk — and `ship`, which holds the merge grant, is never routed; a message with two or more independent asks routes to the `conductor` with one child per part (the card lists the parts; only for a requester who may run `conductor`, and never more parts than `spawn.maxChildren`) ([routing-and-config item 21](../reference/specs/routing-and-config.md)) | With `auto: false`: every plain message runs `defaults.agent`, exactly as before the router | One small call to the fast model per plain message in a fresh thread; score the router on your own history with `npm run load -- route` ([load-harness item 17](../reference/specs/load-harness.md)) |
| `harness` | `harness: { <preset>: pi }` (`coding`, `review` and `general` today; a review on pi holds no `edit` or `write` and never pushes — the read identity's allowlist and gate, [harness-pi.md](../reference/specs/harness-pi.md) item 10; a general ask on pi runs it as a child of the bot with none of pi's own tools, its `assistant` toolset relayed, item 12), plus `PUBLIC_BASE_URL` for a preset with a workspace (the run's container reaches the model proxy and the harness routes through it; a preset without one reaches them over loopback on `PORT`, which the image sets) and pi in the images (every image carries it) | That preset's runs are driven by pi inside the run's container — `pi --mode rpc`, the run bearer as its only key, our tools relayed to the bot, every event on the run's own record; the run page and the card read as before, with pi's `read`/`edit`/`write` beside `bash` ([harness-pi.md](../reference/specs/harness-pi.md)) | Every preset runs the native loop, exactly as before | Nothing beyond the model calls the run makes anyway; pi's process in the container (one Node process per live run, under the image's heap cap) |
| `coordinator` | A `coordinator` entry in `SWITCHBOARD_INGRESS_TOKENS` with `grants.http:coordinator: { actions: [coordinator:step] }` — add `plan:merge` for the runner to merge a plan branch's pull request itself once the review approved at its head and CI is green; without it every merge is a person's — plus run history on the state Worker | Every `agent:ship` request (a task, `plan <path>.md [units U<n>, …]`, or a ship pull request's URL to resume at review) becomes a plan runner instance — one thread and one branch per unit, the card following the plan, its summary in the requesting thread — with `PUBLIC_BASE_URL` set so the bot addresses its own shim; `POST /admin/coordinator/*` answer that bearer — the steps the instance calls into the bot (`plan`, `unit-start`, `branch`, `spawn`, `read-record`, `pr-check`, `round`, `unit-end`, `merge`, `finish`) and the shim's `instances` route | Every coordinator route refuses, and `agent:ship` — which always runs on the plan runner — is refused naming what is missing (the `coordinator` entry, `PUBLIC_BASE_URL`, or run history on the state Worker); there is no other ship implementation | The bot Worker's `ShipCoordinator` Workflow; two tables on the state Worker's `RunHistoryDO` |
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

The other 25 commands are on in every installation.

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
