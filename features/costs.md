# Costs dash: what a deployed group costs per day

`GET /costs` is an Access-gated, read-only page (plus a JSON twin) showing what a named group of deployed pieces costs per day, read live from the providers' own billing datasets and priced at list. The first group is `switchboard` — the bot Worker + its container, the resident/sandbox/memory Workers and their containers — but the config is a map of groups so the same page serves other apps on the account later. LLM spend is layered in from the Anthropic Admin API when an Admin key and a per-group workspace are configured.

- **Code**: [`src/core/costs.ts`](../src/core/costs.ts) (`parseCostsConfig`, `CLOUDFLARE_PRICES`, `containerCostUsd`, `doDurationCostUsd`, `doRequestsCostUsd`, `buildCostReport`, `resolveRange`, `CloudflareGraphqlUsageSource`, `AnthropicCostReportSource`, `NullLlmCostSource`, `createCostsService`); [`src/channels/costsView.ts`](../src/channels/costsView.ts) (`parseCostsRoute`, `renderCostsPage`, `createCostsViewHandler`); [`src/index.ts`](../src/index.ts) (builds the service from `costs:` config + env, gates `/costs*` behind Access next to `/runs*` and `/residents*`); [`deploy/cloudflare/worker.ts`](../deploy/cloudflare/worker.ts) (forwards `CF_ANALYTICS_TOKEN` / `ANTHROPIC_ADMIN_KEY` into the container env).
- **Tests**: [`src/core/costs.test.ts`](../src/core/costs.test.ts), [`src/channels/costsView.test.ts`](../src/channels/costsView.test.ts).
- **Receipts**: https://github.com/coreplanelabs/switchboard/issues/227
- **Docs**: [AGENTS.md](../AGENTS.md) (module table, container-sizing note), [access-gate.md](access-gate.md), [resident-repos.md](resident-repos.md) (sibling Access-gated dash).

## Configuration

```yaml
costs:
  cloudflareAccountId: <32-hex>
  cloudflareTokenEnv: CF_ANALYTICS_TOKEN      # default
  anthropicAdminKeyEnv: ANTHROPIC_ADMIN_KEY   # default; optional feature
  groups:
    switchboard:
      label: Switchboard
      workers: [switchboard, switchboard-resident, switchboard-sandbox, switchboard-memory]
      containerApps: { <application id>: bot, <application id>: resident, <application id>: sandbox }
      durableObjectNamespaces: { <namespace id>: bot DO, <namespace id>: resident DOs }
      anthropicWorkspaceId: wrkspc_…          # optional
```

| Secret | Scope | Effect when absent |
|---|---|---|
| `CF_ANALYTICS_TOKEN` | Cloudflare API token, **Account → Account Analytics: Read** only, scoped to the one account | `/costs` answers 503 (feature off) |
| `ANTHROPIC_ADMIN_KEY` | Anthropic Admin API key (`sk-ant-admin…`) | LLM column absent; page says "LLM spend not configured" (never $0) |

Container application ids: `GET /accounts/{id}/containers/applications`; DO namespace ids: `GET /accounts/{id}/workers/durable_objects/namespaces`. A group's LLM spend is the cost report filtered to `anthropicWorkspaceId`; the bot's API key must live in that workspace for the attribution to be right (the org default workspace reports as `null` and is never attributed to a group).

## Behavior

1. **Pricing model is Cloudflare's.** vCPU bills on **active** seconds (`cpuTimeSec`); memory and disk bill on the **provisioned** size for every awake second (`allocatedMemory` / `allocatedDisk` byte-seconds). Durable Objects bill **duration** ($12.50 per million GB-s, metered as 128 MB × active wall-clock seconds) plus requests ($0.15/M). Duration comes from `durableObjectsPeriodicGroups.sum.duration`, which is already the billable GB-s per namespace — **not** from summed request wall time (`durableObjectsInvocationsAdaptiveGroups.wallTime`), which double-counts overlapping long requests (SSE streams, `exec`) and ran ~2× above billed on 2026-08-29 (bot 179k s summed vs 86k s active). Constants in `CLOUDFLARE_PRICES` (list, 2026-08-29); the page states them. Gross — plan fees and included allowances are not subtracted. Not covered: R2 (resident snapshots), DO SQLite storage, Workers requests, Access — cents a month at current volume.
2. **Group scoping.** Only rows whose `applicationId` is in `containerApps`, whose `namespaceId` is in `durableObjectNamespaces`, or whose `scriptName` is in `workers` count; everything else in the account (e.g. `terrateam`) is dropped before any arithmetic. LLM rows count only when `workspaceId` equals the group's `anthropicWorkspaceId`.
3. **One row per UTC day, zero-filled.** `resolveRange(?days)` gives 1–90 days (default 30, garbage → default) ending today; today is flagged `partialLastDay`. The tiles use full days only: *Yesterday* = last full day, *7-day average*, *Projected month* = 7-day rate × 30.4.
4. **LLM unavailable ≠ $0.** With no Admin key (`NullLlmCostSource` → `null`) or no workspace on the group, `llmAvailable` is false and the page says "LLM spend not configured"; the totals then exclude LLM rather than reporting a fake zero share.
5. **Sources are seams.** `CloudflareUsageSource` and `LlmCostSource` are interfaces; the real ones take an injectable `fetch`. The Cloudflare source POSTs one GraphQL query (`containersUsageAdaptiveGroups` + `durableObjectsPeriodicGroups` + `durableObjectsInvocationsAdaptiveGroups`, `date`-bucketed, exclusive end = start of the day after `to`) with the token only in `Authorization`; a non-200 **or** a GraphQL-level `errors` array (the API 200s on those) throws. The Anthropic source walks `GET /v1/organizations/cost_report?group_by[]=workspace_id&bucket_width=1d&limit=31` page by page (`next_page`), converts cent-strings to dollars, and refuses a non-USD row — or a report still paginating past 20 pages — rather than mis-summing or returning a truncated total. Neither error message carries the credential.
6. **Live per request, nothing stored.** Every page/JSON load calls both sources; there is no cache and no persistence (AGENTS.md invariant 6 is moot — there is no state to lose).
7. **Routes.** `/costs` and `/costs.json` → the first configured group; `/costs/<group>` and `/costs/<group>.json`; group slugs are `[a-z0-9-]{1,40}`. GET-only (405 otherwise). Unknown group → 404. Not configured → 503 naming the config keys. Upstream failure → 502 with a capped reason, never a 500. JSON shape per day: `durableObjects` is DO **duration** cost keyed by namespace label; DO **request** cost is the sibling `doRequestsUsd` (not attributable to a namespace). A consumer wanting the full DO figure sums both — `totals.byResource.durableObjects` already does.
8. **Page.** Pure server render — inline SVG stacked bars (one `<rect class="seg">` per day × component with a `<title>` for hover, so no script is needed under the shared strict CSP), a legend, a per-resource split (memory / vCPU / DO / disk), and a full table view; every dynamic string is HTML-escaped; the same `HTML_PAGE_HEADERS` (CSP, `X-Frame-Options: DENY`, `no-store`) as `/runs`. Series colors are the validated categorical set with dark-mode steps, assigned by first appearance, never re-ranked.
9. **Access gate.** `/costs*` sits in the same fail-closed Access branch as `/runs*` and `/residents*` in `src/index.ts`. The startup log states `GET /costs (<groups>; LLM on|off)` or the 503 reason.

## Validation criteria

| # | Criterion | Proof |
|---|---|---|
| 1 | Container pricing reproduces Cloudflare's billing for a real row (2026-08-28 resident → $1.066); DO duration prices billable GB-s (real 2026-08-28 bot DO row → $0.1378, always-on ≈ $0.135/day) and requests at $0.15/M | `[unit]` costs.test.ts `containerCostUsd`, `durable object pricing` |
| 2 | Rows outside the group (other apps, other DO namespaces, other workers, other/default workspaces) never reach the report | `[unit]` `buildCostReport › keeps only…` (×2) |
| 3 | Days are zero-filled oldest-first; totals and the per-resource split sum exactly | `[unit]` `buildCostReport › emits one row…`, `› totals…`, `› splits cloud spend…` |
| 4 | No LLM source → `llmAvailable:false`, page says not configured (not $0) | `[unit]` costs.test.ts `reports llm as unavailable`, costsView.test.ts `says LLM spend is not configured` |
| 5 | `?days` clamps 1..90, garbage → 30, today flagged partial | `[unit]` `resolveRange` |
| 6 | Malformed `costs:` config throws at startup, absent → off | `[unit]` `parseCostsConfig` |
| 7 | Cloudflare source: bearer header, account-scoped variables, exclusive end date, row mapping for all three datasets (incl. `durableObjectsPeriodicGroups`); non-200 and GraphQL `errors` both throw; token never in URL/error | `[unit]` `CloudflareGraphqlUsageSource` (×3) |
| 8 | Anthropic source: `x-api-key` + `anthropic-version`, `group_by[]=workspace_id`, pagination via `next_page`, cents→dollars, non-USD refused, >20 pages refused (not truncated), key never in error | `[unit]` `AnthropicCostReportSource` (×4) |
| 9 | Routing: index / group / `.json` twin match; traversal-shaped, over-long, and foreign paths don't | `[unit]` `parseCostsRoute` |
| 10 | Page: escaped, script-free, no external assets; tiles from full days; one titled segment per day×component; legend + table; partial-day marker; method stated; sibling-group links | `[unit]` `renderCostsPage` (×7) |
| 11 | Handler: falls through for other paths; 503 unconfigured naming the keys; 405 non-GET; live read per request with the hardened headers; `?days` passthrough; 404 unknown group; JSON twin `no-store`; upstream failure → capped 502 | `[unit]` `createCostsViewHandler` (×7) |
| 12 | Deployed: `/costs` behind Access renders the switchboard group with live Cloudflare numbers matching the dashboard's billing view for the same day | `[agent]` after deploy: sign in, load `/costs/switchboard?days=7`, compare yesterday's container total to the Cloudflare dash |
| 13 | Deployed: LLM column appears once `ANTHROPIC_ADMIN_KEY` + `anthropicWorkspaceId` are set | `[gap]` until the bot key is moved into its own Anthropic workspace |
