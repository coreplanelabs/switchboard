# Reference: config.yaml

Every top-level block, what it's for, and what happens when it's absent. Copy `config/config.example.yaml` to `config/config.yaml` to start — every block below except `organization`, `providers` and `defaults` is optional and off by default.

| Block | Purpose | When absent |
|---|---|---|
| `organization` | The GitHub organization (or user) this installation serves — the account its GitHub App is installed on. Names the shared memory scope (`org:<organization>`) and the About block every model run carries | required — nothing in the code assumes an organization |
| `providers` | Model providers (`anthropic`, `openai-compatible` + a `baseUrl`) and which env var holds each one's key | required — nothing to route to |
| `defaults` | `agent` used with no other signal; `models`/`efforts` per agent | required — the built-in agent floor is the last resort, not a real default |
| `channels` / `users` | Static per-scope defaults, keyed by platform-namespaced id (`slack:C…`, `slack:U…`) | that scope has no static defaults; runtime `config set` still applies |
| `permissions` | Who may run which agents, touch which repos, change channel config, manage repos, write over HTTP/MCP | **everything open** — see [reference: permissions](permissions.md) |
| `execution` | Where tool calls actually run: `local` (bot host), `e2b` / `cloudflare` (per-thread sandbox), plus an optional `resident` block for always-warm per-repo environments | `local` — fine for dev, not for untrusted users reaching `coding` |
| `workspaceDir` | Where local-execution workspaces live on disk | `./workspaces` |
| `memory` | Cross-session memory: read/write to a durable store, per-scope budget | off — model input is byte-identical to memory disabled |
| `selfImprovement` | The friction-ledger → GitHub-issue pipeline: target repo, label, thresholds | `friction propose` refuses (no target repo); `friction report` still works from the in-memory ledger |
| `schedules` | Where the `/runs` Scheduled panel reads cron firing history from | the panel lists schedules with no firing history |
| `ship` | `agent:ship` pipeline caps: `maxRounds`, `maxMinutes` | sane built-in defaults (3 rounds, 120 min) |
| `costs` | `/costs` dashboard: Cloudflare account + token, optional Anthropic admin key, named groups of Workers/containers/DOs to price | `/costs` refuses to start — nothing to report on |
| `slack.catchUp` | Reconnect catch-up window after a deploy/drain | on, 30-minute window |
| `runtimeOverrides` | Where chat-set overrides (`config set`, `config instructions`) persist | `data/overrides.json` on host disk — **ephemeral on Cloudflare Containers** |
| `runHistory` | Durable run records: retention window, byte/count caps, which store backs it | **off** — runs are live-only, evicted ~60s after finish |

## Two blocks that matter most for "does a restart lose anything"

`runtimeOverrides.worker` and `runHistory.worker` (and `memory.worker`, `selfImprovement.worker`, `schedules.worker`) all point at the same state Worker (`deploy/cloudflare-memory/`) with the same bearer. Set them, and a bot restart loses nothing durable: overrides, memory, run history, and the friction ledger all live on Durable Objects, not the container's disk. Skip them (the default on a fresh clone), and all four fall back to a host-disk file or in-memory store — fine for local dev, silently ephemeral on a platform with no persistent disk. See [explanation: Worker topology](../explanation/worker-topology.md).

## Full annotated example

`config/config.example.yaml` in the repo root is the living reference — every key, every default, every caveat, as a comment next to the setting it documents. This page is the map; that file is the terrain.
