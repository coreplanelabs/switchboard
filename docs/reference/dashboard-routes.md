# Reference: dashboard routes

Every route below sits behind the dashboard's one identity gate unless noted. Which credential it checks is the `dashboard.auth` strategy in [config.yaml](configuration.md): `access` — a Cloudflare Access browser session or, for machine callers, a service token (the default when `ACCESS_TEAM_DOMAIN` and `ACCESS_AUD` are set); `token` — an `Authorization: Bearer` header holding the secret in `DASHBOARD_TOKEN` (or the env var `dashboard.token.env` names), which resolves to the one actor `dashboard.token.actor` names; or `none` — no credential, served only to loopback callers of a localhost deployment and refused everywhere else (the default without Access). None of them set caching headers that would let a proxy or browser cache a response beyond the request that made it (`no-store` throughout) — every load is live.

The header lists only the surfaces this installation has: **Residents** appears when resident environments are configured (`execution.resident`), **Costs** when `costs` is configured with its analytics token, **Delivery** when a GitHub credential is set, the **Scheduled** tab when `schedules.worker` records firings. The **settings cog** beside the docs link is always there (every installation has channel scopes); the page's MCPs tab only with an `mcp` block. The docs link is always there: it opens the project's published site. The routes themselves still answer without their subsystem — with a `503` naming the config that turns them on.

| Route | Shows | Notes |
|---|---|---|
| `GET /runs` | Active runs, newest first | Default view excludes finished runs; each row's link carries that run's capability token — the index itself is gated specifically because of this |
| `GET /runs?all=1` | Active **and** finished runs | Only meaningful with `runHistory` configured — otherwise there's nothing finished to show |
| `GET /runs?mine=1` | Only the runs you requested (combines with `all=1`) | "You" is the Slack user your sign-in email names; a session with no linked Slack user has no runs of its own, and the toolbar's **Show mine** is disabled for it |
| `GET /runs/<id>` | One run: request → steps (tool calls, results) → answer | Live via SSE while the run is active; served as a static page, no token needed, once it's in history |
| `GET /runs/<id>/events` | Raw SSE event stream for that run | What the run page itself consumes; resumable via `Last-Event-ID` |
| `GET /runs/<id>/friction` | Why a finished run was slow, if it was | Read-only diagnosis, no side effects |
| `GET /runs/unit/<instance>:<unit>` | One ship unit's story: its coding thread's runs and its review thread's in round order, each opening to its timeline, with a search over one thread's conversation | What `runs unit` answers, as a page; a unit you may not see is the same 404 an unknown run gives. The pipeline's own run page lists its units, and a conductor's run page lists the runs it spawned |
| `POST /runs/<id>/stop?mode=soft\|hard` | — | Stops a live run; `soft` lets it wrap up and answer, `hard` aborts in-flight |
| `GET /residents` | Every onboarded repo, its lifecycle state, its disk gauge (used/total) and how many runs are on it; each row folds open to those runs — stopwatch, run link, the worktree each holds (ref, commit, OS user, deps, size), the idle worktrees, and the room left on the disk | The dashboard twin of `repo list`; the fold lists the runs the viewer may read, live |
| `GET /residents?stream=1` | The residents index feed (SSE): run rows as the registry publishes them, and the listing again whenever a run's worktree is bound or released | What the index consumes to stay current; no timer re-reads the resident Worker |
| `GET /residents/<owner>/<name>` | One repo's resident: mirror status, warm checkout, active thread worktrees, and its disk — used/total, free, the reserve it keeps back, headroom in "more trees", and every component (mirror, deps, checkout, each thread tree, leftover caches) | The same numbers the resident's attach admission decides on — see [onboard a repo → Disk](../how-to/onboard-a-repo.md#disk) |
| `GET /costs` | Daily spend across every configured group | Priced from a snapshot of Cloudflare's and (optionally) Anthropic's billing data, taken daily (`costs.snapshot.everyHours`) or on request with `costs snapshot`; the page names the snapshot, its age and when the next is due |
| `GET /costs/<group>` | Spend for one group | `?view=users` opens the By user tab |
| `GET /costs/<group>.json` | Same data, machine-readable | For scripting/alerting, not for embedding a live dashboard elsewhere; carries `snapshot.takenAt`; 503 with `Retry-After` before the first snapshot |
| `GET /delivery` | Delivery indicators for the first configured repository — issue-to-merge time, first-pass CI, review rounds, the findings and the share resolved with no human edit, per week and per unit | From the repository's snapshot of GitHub's facts, refreshed on an interval and dated in the footer, plus the run history you may see; a read that stopped at its cap says over the tiles that they cover the newest pull requests only and marks the incomplete weeks; `?weeks=n` or `?since=YYYY-MM-DD`; `?fresh=1` reads GitHub now |
| `GET /delivery/<owner>/<name>` | The same for one configured repository | The command twin, `delivery report --repo`, takes any repository |
| `GET /delivery/<owner>/<name>.json` | Same data, machine-readable | |
| `GET /settings` | The settings page: MCPs where the capability is on, else Channels | An adapter over the command routes below ([settings-page.md](specs/settings-page.md)): what it lists is `mcp list` / `config overrides` / `config show --channel` invoked as you; every button is one `POST /api/…`; the org and channel tiers only — personal settings are set in chat |
| `GET /settings/mcps` | Every MCP server your runs can reach, by tier, with an add form; `?channel=<id>` lists that channel's tier beside org | Add and Connect hand back the one-time link below; a credential never passes through the page |
| `GET /settings/channels` | The channels that carry a scope, with the setting names each one has | The dashboard twin of `config overrides` |
| `GET /settings/channels/<channel id>` | One channel's scope as a form: agent, models, effort, the boundary, instructions | Save is `config set channel --channel <id>`; Clear is `config clear`; the instructions box is `config instructions` |
| `GET /settings/installation` | The running `config.yaml`'s behaviour knobs with the value in force, and the capabilities that are on | Read-only by construction: a projection by allow-list, no env var name or URL ever on the page |
| `GET /mcp/connect/<nonce>` | The one-time MCP credential-paste form | Bound to whoever mints it or first opens it; single use, expires in 10 minutes |
| `GET /healthz` | `{ok, inFlight, draining, catchUp}` | **Not** gated — this is the process health probe, meant to be hit by the deploy tooling and the container platform |

## Command routes (`/api/<group>.<verb>`)

Every registered command has an HTTP twin behind the same dashboard gate, plus an MCP tool of the same name — one definition, every surface ([explanation](../explanation/one-command-many-surfaces.md)). A write is `POST`-only; a read takes either verb (`GET` with a kebab-case query string, `POST` with a camelCase JSON body). The `Scope` column is what an operator identity or service token must hold.

<!-- generated:api-routes · npm run docs:gen — generated from the code, do not edit by hand -->

| Route | Methods | Action | What it does |
|---|---|---|---|
| `/api/help.show` | `GET`, `POST` | `help:read` | How to ask in plain words: describe what you want, force an agent, change a route in the thread. |
| `/api/help.commands` | `GET`, `POST` | `help:read` | Every chat command by group, the grammar, and the per-request directives. |
| `/api/status.show` | `GET`, `POST` | `status:read` | Which build this process runs: version, commit, when it was built and started, runs in flight, draining. |
| `/api/config.show` | `GET`, `POST` | `config:read` | The effective agent/model/effort for you in this channel, the defaults, both scopes, and what is restricted. |
| `/api/config.overrides` | `GET`, `POST` | `config:read` | Which channels carry a scope (a config.yaml block or a runtime override) and which settings each one names — never a value; `config show --channel <id>` reads one. |
| `/api/config.set` | `POST` | `config:write` | Set the agent, model, effort or boundary for a channel (gated) or for yourself; per-agent forms take --models.&lt;agent&gt; / --efforts.&lt;agent&gt;, the boundary's axes --boundary.&lt;axis&gt; (a boundary caps every run in the scope and never grants). |
| `/api/config.clear` | `POST` | `config:write` | Drop every runtime override of a channel (gated) or of yourself; static config.yaml values show through again. |
| `/api/config.instructions` | `POST` | `config:write` | Custom instructions for a channel (gated) or for yourself — advisory prompt content that never changes agent, model, or permissions. |
| `/api/runs.list` | `GET`, `POST` | `runs:read` | List runs (live and persisted, newest first) — metadata only, never message text. |
| `/api/runs.get` | `GET`, `POST` | `runs:read` | One run's record; `--include messages` adds its events with free text wrapped as untrusted content. |
| `/api/runs.events` | `GET`, `POST` | `runs:read` | A page of one run's events after `--after-seq` (server-capped); free text wrapped as untrusted content. |
| `/api/runs.friction` | `GET`, `POST` | `runs:read` | One run's friction diagnosis (live: computed now; persisted: as stored). |
| `/api/runs.stop` | `POST` | `runs:write` | Request a live run to stop (`--mode soft` = finish the current step; `hard` = abort now). Records the caller as the actor. |
| `/api/runs.unit` | `GET`, `POST` | `runs:read` | A ship unit's runs in round order — its coding thread's and its review thread's, live and finished, each with its round and thread — from one read. |
| `/api/runs.children` | `GET`, `POST` | `runs:read` | The runs one run spawned — a conductor's children, live and finished — oldest started first. |
| `/api/runs.search` | `GET`, `POST` | `runs:read` | Search one session's log — a thread's conversation on one agent, every run of it — for words: the matching turns in relevance order, each with its run; snippets wrapped as untrusted content. |
| `/api/review.abridge` | `POST` | `review:write` | Abridge a finished PR review's reading diff with meat.dev on the bot host (one Opus-class call) and store it on the run; idempotent — a stored one is answered, not recomputed. |
| `/api/friction.report` | `GET`, `POST` | `friction:read` | Ranked recurring friction patterns across recent runs — read-only, GitHub never consulted. |
| `/api/friction.propose` | `POST` | `friction:write` | Run the self-improvement step: cluster recent friction, dedupe against open issues, file the top proposals as labeled issues. |
| `/api/repo.list` | `GET`, `POST` | `repo:read` | Every onboarded resident repo with its live state, ref, sha, last refresh, and disk gauge. |
| `/api/repo.onboard` | `POST` | `repo:write` | Onboard a repo as an always-warm resident environment (provisions billable compute; admin-gated). |
| `/api/repo.offboard` | `POST` | `repo:write` | Tear down a resident repo: registry record, schedules, container, R2 snapshots (admin-gated; --dry-run plans only). |
| `/api/repo.reconfigure` | `POST` | `repo:write` | Change a resident's default branch and/or command table (admin-gated; takes effect on the next refresh/attach). |
| `/api/repo.rebuild` | `POST` | `repo:write` | Discard a resident's snapshot and reprovision it from scratch (admin-gated; --dry-run plans only). |
| `/api/repo.test` | `POST` | `repo:exec` | Run the repo's onboarded test command with zero model turns (needs coding-agent access; the ref must be a plausible branch). |
| `/api/repo.build` | `POST` | `repo:exec` | Run the repo's onboarded build command with zero model turns (needs coding-agent access; the ref must be a plausible branch). |
| `/api/memory.list` | `GET`, `POST` | `memory:read` | Your own memory records and the shared org / repo / channel records, with ids — what influences your runs. |
| `/api/memory.forget` | `POST` | `memory:write` | Soft-delete one memory record so it no longer influences any run (yours freely; shared org/repo/channel records need repo-management rights). |
| `/api/mcp.list` | `GET`, `POST` | `mcp:read` | External MCP servers your runs in this channel can use — org-wide, this channel's, and your own — with state and agents; never a credential. `--all` (admins): every tier. |
| `/api/mcp.add` | `POST` | `mcp:write` | Register an external MCP server for yourself, this channel, or the org — auth is detected from the server; sign-in or a token happens on a one-time link, never in chat. |
| `/api/mcp.connect` | `POST` | `mcp:write` | A fresh one-time link to sign in to an OAuth server or enter (or replace) a bearer server's token — only you can complete it; it expires in 10 minutes. |
| `/api/mcp.show` | `GET`, `POST` | `mcp:read` | One MCP server's entry plus a live probe of the tools it offers (names, read-only flags); never a credential. |
| `/api/mcp.remove` | `POST` | `mcp:write` | Remove an MCP server you added and its stored credential (yours freely; channel ones need channel-config rights, org-wide ones admin rights). |
| `/api/mcp.promote` | `POST` | `mcp:write` | Re-issue a person's MCP server in the org tier (admins): the same name, URL and auth, added by you; a bearer/oauth server gets a fresh org connect link for you to complete — the person's credential is never copied. |
| `/api/schedule.list` | `GET`, `POST` | `schedule:read` | Every scheduled job (cron, UTC), which Worker fires it, its next firing, and what its last firing did. |
| `/api/deploy.plan` | `GET`, `POST` | `deploy:read` | The production deploy plan: checks, Worker order, preflight handling — computed, nothing executed. With --affected, also which Workers this tree actually needs deployed and why. |
| `/api/delivery.report` | `GET`, `POST` | `delivery:read` | Delivery indicators per week and per unit — issue-to-merge time, first-pass CI, review rounds, findings and the share resolved with no human edit — from the repository's snapshot of GitHub's facts (--fresh reads GitHub now) and the run history; nothing written. |
| `/api/costs.snapshot` | `POST` | `costs:write` | Take the costs snapshot now: read both billing sources and the run history once over the page's widest range, store the result, and serve it to every reader of the costs page from then on. |

<!-- /generated:api-routes -->

## Screenshots

**Residents index** — every onboarded repo, its state, last activity; each row folds open to the runs on it and their worktrees:

<img src="../images/residents-index.jpg" alt="Residents index" width="720">

**Resident detail** — one repo's mirror, warm checkout, and per-thread worktrees:

<img src="../images/resident-detail.jpg" alt="Resident detail" width="720">

## What's not on the dashboard yet

Personal settings (`config set me`, `mcp add` for yourself) reach the person your session is linked to: when your Access email names your Slack user ([record 0042](../../docs/decisions/0042-a-dashboard-session-is-the-person-its-email-names-identity-not-authority.md)) the MCPs tab offers the `me` tier and `config set me` over `/api` writes your own scope, the one your chat runs read. A session no Slack user answers for is refused `me` with the pointer to chat ([record 0041](../../docs/decisions/0041-the-settings-page-is-a-surface-over-the-registry-and-configures-the-shared-tiers.md)). The org tier for agent, model and effort (`config set org`) is not there yet; the Installation tab shows the `defaults.*` in force. The frontend (`web/`) is a Vue 3 app served entirely from a JSON seed embedded in the page (no client-side data fetching to a separate API for the initial render), which is why every route above renders instantly with no loading spinner for its first paint.
