# Reference: config.yaml

Every top-level block, what it's for, and what happens when it's absent. Copy `config/config.example.yaml` to `config/config.yaml` to start — every block below except `organization`, `providers` and `defaults` is optional and off by default. Which blocks (and which environment variables) turn a capability on, what appears when one does, and what it costs to run is the matrix in [Turn features on and off](../how-to/turn-features-on-and-off.md).

| Block | Purpose | When absent |
|---|---|---|
| `organization` | The GitHub organization (or user) this installation serves — the account its GitHub App is installed on. Names the shared memory scope (`org:<organization>`) and the About block every model run carries | required — nothing in the code assumes an organization |
| `providers` | Model providers (`anthropic`, `openai-compatible` + a `baseUrl`) and which env var holds each one's key | required — nothing to route to |
| `defaults` | `agent` used with no other signal; `models`/`efforts` per agent; an optional `boundary` capping every run's budget, identity and machine class | required — the built-in agent floor is the last resort, not a real default; no `boundary` caps nothing |
| `channels` / `users` | Static per-scope defaults, keyed by platform-namespaced id (`slack:C…`, `slack:U…`); a scope's `boundary` intersects with the others' (it can only tighten) — see [Restrict who can do what](../how-to/restrict-who-can-do-what.md#cap-what-a-channels-runs-may-have) | that scope has no static defaults; runtime `config set` still applies |
| `grants` | What each actor holds — actions (commands, `agent:run:<name>`, `dispatch`), channels whose runs it may read, repos it may use — keyed by platform-namespaced id, or `<ns>:*` for everyone authenticated on a surface (`access:*` is the org) | nobody is an admin; Slack users hold the open chat commands and every unrestricted agent, browser sessions every read, credentials nothing — see [reference: authorization](authorization.md) |
| `restrict` | Agents and repos closed to everyone not granted them | nothing restricted — every agent and repo open to whoever can reach the bot — see [reference: authorization](authorization.md) |
| `execution` | Where tool calls actually run: `local` (bot host), `e2b` / `cloudflare` (per-thread sandbox), plus an optional `resident` block for always-warm per-repo environments | `local` — fine for dev, not for untrusted users reaching `coding` |
| `workspaceDir` | Where local-execution workspaces live on disk | `./workspaces` |
| `memory` | Cross-session memory: read/write to a durable store, per-scope budget | off — model input is byte-identical to memory disabled |
| `selfImprovement` | The friction → GitHub-issue pipeline over run history: target repo, label, thresholds | `friction propose` refuses (no target repo); `friction report` still works over `runHistory` |
| `schedules` | Where the `/runs` Scheduled panel reads cron firing history from | the panel lists schedules with no firing history |
| `ship` | `agent:ship` pipeline caps: `maxRounds`, and `maxMinutes` — the ship preset's declared budget, which a scope's boundary or a `budget:` directive clips per run | sane built-in defaults (3 rounds, 120 min) |
| `costs` | `/costs` dashboard: Cloudflare account + token, optional Anthropic admin key, named groups of Workers/containers/DOs to price | `/costs` refuses to start — nothing to report on |
| `delivery` | `/delivery` page and `delivery report`: the repositories the page serves, the identities the indicators judge by (the review agent's login, agent logins, agent co-author names) and how often each repository's snapshot of GitHub's facts is refreshed (`snapshot.everyMinutes`, default 60); needs a GitHub credential; the snapshot lives on the state Worker any `*.worker` block names | `/delivery` answers 503 naming the block; `delivery report --repo owner/name` still works |
| `dashboard` | Dashboard authentication: `auth: access` (the Cloudflare Access JWT, `ACCESS_TEAM_DOMAIN` + `ACCESS_AUD`), `token` (`Authorization: Bearer` from the env var `token.env` names, default `DASHBOARD_TOKEN`, resolving to the one actor `token.actor` — `access:<name>`) or `none` (loopback callers on a localhost deployment only; a public `PUBLIC_BASE_URL` refuses to start) — see [dashboard routes](dashboard-routes.md) | `access` when both `ACCESS_*` are set, else `none` — a deployed installation is unchanged; a localhost one without Access now admits its loopback callers |
| `slack.catchUp` | Reconnect catch-up window after a deploy/drain | on, 30-minute window |
| `runtimeOverrides` | Where chat-set overrides (`config set`, `config instructions`) persist | `data/overrides.json` on host disk — **ephemeral on Cloudflare Containers** |
| `runHistory` | Durable run records: retention window, byte/count caps, which store backs it | **off** — runs are live-only, evicted ~60s after finish |
| `tracing` | Span log verbosity: `log: roots` (one JSON line per request) or `slow` (plus every span of 1 s or more) | `roots` |

## Two blocks that matter most for "does a restart lose anything"

`runtimeOverrides.worker` and `runHistory.worker` (and `memory.worker`, `schedules.worker`) all point at the same state Worker (`deploy/cloudflare-memory/`) with the same bearer. Set them, and a bot restart loses nothing durable: overrides, memory, and run history (the friction ledger reads it) all live on Durable Objects, not the container's disk. Skip them (the default on a fresh clone), and all three fall back to a host-disk file or in-memory store — fine for local dev, silently ephemeral on a platform with no persistent disk. See [explanation: Worker topology](../explanation/worker-topology.md).

## Full annotated example

`config/config.example.yaml` in the repo root is the living reference — every key, every default, every caveat, as a comment next to the setting it documents. This page is the map; that file is the terrain.
