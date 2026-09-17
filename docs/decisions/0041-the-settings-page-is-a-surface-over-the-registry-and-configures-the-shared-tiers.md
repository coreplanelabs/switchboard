---
title: The settings page is a surface over the command registry and configures the shared tiers; personal settings stay where the identity is
status: accepted
date: 2026-09-16
pattern: Adapter over the registry (no second write path); the null tier for an identity the store cannot map; an allow-list projection instead of a filtered secret
---

# The settings page is a surface over the command registry and configures the shared tiers; personal settings stay where the identity is

**The ask.** Decide (the maintainer, before the first settings PR opens): adopt this shape for a dashboard page where a customer configures what Switchboard already lets them configure, with a section for external MCP servers first. Written for an engineer who knows the command registry ([command-registry.md](../reference/specs/command-registry.md)) and the config layers ([routing-and-config.md](../reference/specs/routing-and-config.md) item 2) and has not read the MCP spec or the web app. The frame is the maintainer's ask of 2026-09-16 ("a settings page for all our app settings that we want to let customers configure, an MCPs section, and what is configurable today with small effort"); the reader and the deadline are assumed.

Success criteria: (1) a signed-in admin adds, connects and removes an MCP server at the org and channel tiers from the browser without a credential ever passing through the page; (2) a signed-in admin sets and clears a channel's agent, models, effort, boundary and instructions from the browser; (3) every write the page makes is a command the registry already exposes, decided by the policy table with the viewer's grants, so chat, CLI and the page cannot disagree; (4) a customer can see in the product which knobs are configurable at run time, which only through `config.yaml`, and which subsystems are off in their installation; (5) a viewer without the grant sees the page read-only, and a write they force through anyway gets the refusal the command's handler gives on every surface.

## TL;DR

Switchboard has 8 runtime-settable keys per config scope and 28 top-level `config.yaml` keys, every runtime one already a typed command with an HTTP twin at `/api/<group>.<verb>`, and no page that shows any of it; the MCP spec's roadmap defers the dashboard page. The bet is that the settings page is an adapter over the registry and nothing more: the page renders `config show` and `mcp list`, every write is a `POST /api/config.*` or `/api/mcp.*` call, and the page carries no rule of its own about who may do what. The one tier the dashboard does not offer is `me`, because a browser session is `access:<sub>` and a run is requested as `slack:U…`, so a personal setting written from the dashboard lands on a scope no run reads; today the API accepts that write, and this record closes it in the handlers, on the Access surface, for the config and MCP commands alike. It costs one new read (which channels carry a scope, filtered by the viewer's right to read each) and one read-only projection of the running config built by allow-list. Decided: the shape above, the three sections (MCPs, Channels, Installation), and that the org tier for agent, model and effort, which the store holds today for MCP servers only, lands in a second PR under this record and adds a Workspace tab; open: whether an Access email should ever be mapped onto a Slack user so `me` can come to the dashboard.

## Today at `95b4face`

The delta from what a veteran expects, each with its proof.

- Every registered command already answers over HTTP for a dashboard identity at `/api/<group>.<verb>`, with no per-command code: writes are POST-only, same-origin, JSON ([`src/channels/commandHttp.ts`](../../src/channels/commandHttp.ts)). A settings page therefore needs no new write route.
- The browser's caller id is `access:<sub>` ([`commandHttp.ts`](../../src/channels/commandHttp.ts), `callerIdFor`), and `config set me` writes `overrides.users[caller.id]` ([`src/core/commands/config.ts`](../../src/core/commands/config.ts), the `me` branch of `config.set`). A run's requester is `slack:U…`, and nothing ever dispatches a run as an Access identity. The two never meet: the store has no link from an Access subject to a Slack user. Two reads bridge the gap by email match: the costs page's "my runs" ([`src/core/costs.ts`](../../src/core/costs.ts), `emailOfSlackUser`) and the MCP connect ticket, which only the Access session with the requester's email may complete.
- A browser session holds every command group's read and never a write unless `grants` name it ([`src/core/authz/grants.ts`](../../src/core/authz/grants.ts), `browserReadActions`). The policy rows that admit channel and org writes are grant rows ([`src/core/authz/policy.ts`](../../src/core/authz/policy.ts), the `config` and `mcp` sections), so an admin's grants entry already opens them. The `me` row for `config:write` admits every actor of kind `user`, and an Access browser session is that kind ([`src/core/authz/actor.ts`](../../src/core/authz/actor.ts), `kindFor`): `POST /api/config.set` with scope `me` writes `overrides.users["access:<sub>"]` today, a scope no run reads, and a test pins it as deliberate.
- The MCP client half is complete: servers live on the three config tiers; the `mcp` commands ask the policy table two questions (org and channel) and hand the answers to the service, whose `target` refuses a tier the caller may not manage ([`src/core/commands/mcp.ts`](../../src/core/commands/mcp.ts), `actorOf`; [`src/mcp/service.ts`](../../src/mcp/service.ts), `target`); credentials never travel through a command, and `add` and `connect` return a link to an Access-gated connect page ([mcp-tools.md](../reference/specs/mcp-tools.md) items 13 to 19). The spec's roadmap defers the dashboard page.
- The web app has no channel context and no design-system input: navigation is full page loads over a server-rendered seed, the nav is one capability-gated list ([`web/src/lib/navSections.ts`](../../web/src/lib/navSections.ts)), and no Nuxt UI input component is used anywhere under `web/src` (one native search form exists).
- A channel's **scope** (`agent`, `model`, `models`, `effort`, `efforts`, `boundary`, `instructions`, `mcpServers`) comes from two places layered: the **static scope** is the `channels.<id>` block in `config.yaml`, read once at start; the **runtime scope** is the same shape in the overrides document `{ channels, users, org }` the state Worker holds and `config set` writes ([`src/config.ts`](../../src/config.ts), `Scope`, `Overrides`). The org tier of that document is read for `mcpServers` only (`orgScope`, `mcpServersFor`); `resolve` never opens it. No command lists which channels have a scope.
- Whether a viewer may read another channel's scope is already a policy question with two answers ([`src/core/authz/policy.ts`](../../src/core/authz/policy.ts), the `config:read` rows on `config-scope`): by the `config:write` grant, or by membership asked for a **pointing actor**, whose one fact is the channel's visibility from the **channel directory** (the bot's Slack channel lookup; `unknown` when it is absent, slow, or the channel does not exist) and where `unknown` reads as private.

## The shape

*Amended 2026-09-16 (while proposed): settings is chrome, not a fifth section. The way in is a cog beside the docs link in every page's header, lit on `/settings`, and the site nav keeps its four sections; the maintainer asked for the conventional icon after the first deploy. Nothing else in this record changes.*

The settings page is `/settings`, reached from the header's cog, three tabs, each a full page load over a seed the bot renders from the viewer's own actor: **MCPs** is `mcp list` as a table with an add form, a connect link and a remove button; **Channels** is a picker over the channels whose scope the viewer may read, then `config show --channel` as a form whose Save is `config set channel` and whose Clear is `config clear channel`; **Installation** is a read-only table of the running `config.yaml` behaviour knobs, each with its current value and the sentence that says how it changes, plus the capabilities that are on. Every button on the page is one `POST /api/<group>.<verb>`; the page then reloads and shows what the registry now says. The page carries the viewer's write rights only as a boolean the seed computed with the same `authorize` call the handler will make, and uses it to disable controls, never to decide.

The closest known shape is the GitHub repository settings page over the REST API the `gh` CLI also uses: one API, two clients, and the page has no capability the CLI lacks. The one way this differs is the missing tier: GitHub's page can show "your" settings because the browser session is the same identity as the API token; here it is not, so the dashboard shows the shared tiers and points at chat for the personal one.

```mermaid
sequenceDiagram
  participant B as Browser (access:<sub>)
  participant G as Dashboard gate + settingsView
  participant R as /api commandHttp
  participant S as McpService / ConfigStore
  B->>G: GET /settings/mcps
  G->>S: mcp list (actor, channel?) + canWrite = authorize(actor, mcp:write, org|channel)
  G-->>B: shell + seed { servers, canWrite }
  B->>R: POST /api/mcp.add { name, url, scope: "org", agents }
  R->>S: invoke mcp.add as Caller(access:<sub>, grants)
  S-->>R: { server, connectUrl } or unauthorized (same text as chat)
  R-->>B: JSON; page reloads and renders the connect link
```

## One trace: an admin adds an org-tier server for the coding agent from the browser

1. An admin whose own `grants` entry, keyed by their Access subject, is `{ actions: all, channels: all, repos: all }` opens `/settings/mcps`. The dashboard gate verifies the Access JWT; the view resolves the actor `access:<sub>` with the grants table.
2. The view calls `McpService.list(actor, undefined)`: the org tier plus the actor's own user tier, which is empty since nothing was ever written under `access:<sub>`. It computes `canWrite.org = authorize(actor, "mcp:write", config-scope org).allow`, true because the policy row for org servers asks for the repo-management grant `repo:write` (the table's spelling of "admin" for a person: an org server reaches the coding and review agents, the same blast radius as onboarding a repository) and `all` holds it.
3. The seed carries two rows (`lake`, static, org) and `canWrite: { org: true, channel: true }`. The page paints the table and an enabled add form with scope fixed to `org` or `channel`, no `me`.
4. The admin submits `name=notion`, `url=https://mcp.example.com/mcp`, `scope=org`, `agents=general,coding`. The page posts `POST /api/mcp.add` with `content-type: application/json`, same origin.
5. `commandHttp` refuses a foreign origin, buffers the body under the cap, maps it onto `{ args: { name }, options: { url, scope, agents } }` and invokes `mcp.add` with the caller.
6. The handler builds `McpActor { orgAdmin: true, channelAdmin: true }` from the same two `authorize` calls the seed made, and the service's `target` accepts `org`. `auth` was omitted, so the service detects OAuth from the server and writes the entry into `overrides.org.mcpServers.notion` on the state Worker, then returns `connectUrl` for a ten-minute single-use ticket.
7. The page shows the row as `awaiting_credential` with the connect link. The admin opens it: the existing no-script connect page under the same gate signs them in with OAuth and completes the ticket.
8. The next `agent:coding` run in any channel calls `toolsFor("coding", …)`; the org tier is the only tier allowed to name `coding`, the entry is there, and `mcp__notion__*` tools join the run within the five-minute discovery cache.
9. A second viewer opens the same page in an installation where neither their own subject nor `access:*` (the one entry that grants every browser session at once) appears in `grants`: the seed says `canWrite: { org: false, channel: false }`, the form is disabled, and the row list is the same org tier. If they post anyway, `commandHttp` answers 403 with `access:<sub> is not allowed to run mcp.add`, the text every surface gives a caller without `mcp:write`.
10. The same viewer replays the request with `scope: "me"`: the handler answers `unauthorized` with the sentence that personal settings are set in chat, because the caller's surface is `access` and no run is ever requested as an Access identity. The same sentence answers `POST /api/config.set` with `me`.

The property this proves: the page never held a credential, never decided an authorization, and wrote nothing chat could not have written with the same grants; and the one write the API accepted that no run would read is refused where the handler decides, not where the page draws.

## The difficulty map

1. **Identity.** A `me` tier from the dashboard writes to a scope no run reads. Handled in [The tier the page does not offer](#the-tier-the-page-does-not-offer).
2. **The channel index.** No read lists which channels carry overrides, and the one we add must not leak a private channel's instructions to a member of another channel. Handled in [The channel picker](#the-channel-picker). The spec row that describes the overrides document as `{ channels, users }` ([routing-and-config.md](../reference/specs/routing-and-config.md) item 12) predates the org tier and is corrected in the same PR.
3. **The installation projection.** A read-only view of `AppConfig` leaks an env var name or an internal URL if built by filtering. Handled in [Installation, by allow-list](#installation-by-allow-list).
4. **(most work) Forms.** The web app has no input component and every new file under `web/src` re-hashes the screenshot manifest. Not a design risk; one sentence in [Boundaries](#boundaries).

## The tier the page does not offer

The constraint: `config set me` and `mcp add --scope me` key on the caller id, and the dashboard's caller id is `access:<sub>`. `ConfigStore.resolve` reads `userScope(requester)`, and the requester of a Slack run is `slack:U…`. So a personal setting written from the dashboard is stored, is reported back by `config show` on the dashboard, and changes no run. That is worse than a refusal: it is a setting that lies.

The design: the page offers `org` and `channel` and says, in the place the `me` control would be, that personal settings are set in chat with `config set me` and `mcp add`, because that is where the identity is. The seed carries no user scope. And the handlers close the hole the page would otherwise only paper over: `config set|clear|instructions me` and `mcp add|connect|remove --scope me` (the MCP default) answer `unauthorized` for a caller whose `Caller.kind` is `access`, naming the reason, since an Access identity never requests a run and the scope it would write is read by nothing. `Caller.kind` is the surface the command arrived on (`chat`, `cli`, `mcp`, `access`); the `access` kind covers every identity the dashboard gate produces: an Access browser session, the configured actor of the `token` dashboard strategy, and the loopback operator of the `none` strategy. None of the three ever requests a run. A chat person's `me` and the CLI's `cli:local` are untouched. The write was admitted until now on the reasoning that it is harmless (a person pointing themselves at a restricted agent still meets the run-time agent gate), which is true and beside the point: harmless is not the same as effective, and a settings page makes the difference visible. This is a data decision inside the handler ([command-registry.md](../reference/specs/command-registry.md) item 22), not a policy row: the policy table speaks of actors, and the fact here is about the surface.

Invariants: no request from `/settings` carries `scope: "me"`; a `me` write from an `access` caller is refused on every surface before the store is touched; `config show`'s `user` field is not rendered. Failure mode: a customer expects "my model" on the page and does not find it; the page says where it is.

The alternative it beat: map the Access email to the Slack user, as the costs page does for its "my runs" filter and as the connect ticket does to let the requester complete their own sign-in. Both are narrow: the first is a read, the second lets a person finish a write they themselves started in chat, keyed by a ticket that names them. A general mapping would make an Access session able to act as a Slack identity for every write row on the strength of an email match, a new authority path in a system whose third invariant ([AGENTS.md](../../AGENTS.md), "Authorization is one table") says adapters resolve identity and never authority. It is the open question below, not a default.

## The channel picker

The constraint: a chat caller has an origin channel; a browser has none, and `config set channel` on a machine surface requires `--channel <id>`. A customer opening the tab wants to see the channels that are configured, not remember an id. The registry has no read that answers "which channels have a scope"; the document is one JSON object the store already holds, and the static scopes are in the loaded config beside it.

The design: one new read command, `config overrides`, on every surface, under the existing `config:read` action (no new policy row): the channel ids that carry a static or runtime scope, each with the names of the settings it carries (never the values), filtered to the channels the caller may read by the same per-channel `config:read` question `config show --channel` asks. The Channels tab lists them; picking one loads `/settings/channels/<id>`, whose seed is `config show --channel <id>` and whose forms post `config set|clear|instructions channel --channel <id>`. Below the list, an id field admits a channel that has no scope yet, the one case the index cannot list; it goes through `config show`'s own refusal. The seed is built by invoking the same commands the CLI would, so the page cannot see a channel the CLI could not.

Invariants: the index names settings, never values; a channel the caller's `config:read` denies is absent from the index, not shown greyed; the index for an actor with the `config:write` grant needs no directory lookup at all. Failure modes: the directory is slow or down, so every membership answer is `unknown`, reads as private, and the index shrinks to the channels a grant admits, which is fail-closed; an installation with hundreds of configured channels makes one directory lookup per channel for a non-admin viewer, in parallel, each awaited at most the 1.5 seconds the run stamp allows, and the admin case, the common one, makes none.

The alternative it beat: derive channels from run history. It lists channels that ran something, not channels that are configured, and it needs run history, an optional capability, to be on.

## Installation, by allow-list

The constraint: 28 top-level keys are read once at start; a customer asking "why does routing pick that" or "how long are runs kept" has nothing to look at but the YAML they may not have. Most of the interesting values sit next to a secret's env var name or a Worker URL in the same block.

The design: a pure function from `AppConfig` and `Capabilities` to a list of rows `{ key, value, isDefault, how, note }` where every row is written out by name in the function body, like `row("ship.maxRounds", config.ship?.maxRounds, 3, "config", "review rounds a ship unit may take")`: the configured value when the key is set, else the default marked as such. A row is added by adding a line; nothing is iterated from the config object (the one map walked is `defaults.models`, whose keys are preset names and whose values are model refs). `how` is one of two sentences: "runtime, `config set`" for a key the scopes carry, or "`config.yaml`, then `deploy config` and `deploy restart`" for the rest. Capabilities render as an on/off list with the sentence that turns each on, from the how-to that already exists. The test asserts that the rendered rows, joined, contain no string ending in `Env`, no `https://`, and no key from the manifest of bot secrets.

Invariant: the projection is a function of the two values and nothing else, so a new `config.yaml` key is invisible until someone names it, and the test names the secret shapes that must never appear. Failure mode: a knob is missing from the table; the page under-reports and the fix is one line.

## Why not X

**Why not a settings store of its own, edited by the page and read by the bot?** The registry commands already write the one durable overrides document on the state Worker with optimistic versioning; a second document would need the same seam and would let the page and chat disagree.

**Why not let the page edit `config.yaml` through `deploy config`?** That command is CLI-only by design because it pushes a document the next restart reads; a page that says "restart to apply" and cannot restart is a promise the product does not keep. The Installation tab shows the value and names the route instead.

**Why a page at all, when chat and the CLI already do every write?** Because nothing shows the shared state in one place: `config show` describes one channel from inside it and `mcp list` one viewer's tiers, and the `config.yaml` knobs are visible only to whoever holds the file. A customer asking "what can I configure" has today no answer inside the product; the page is that answer, and it adds no write the registry lacks by design.

## Boundaries

The page does not manage `grants` or `restrict` (no runtime store; parsed once), agent presets (compiled data), notifications (nothing exists), ingress tokens or any `*Env` knob (secrets), or repositories (the Residents page). It does not add a transport picker: only Streamable HTTP exists. The first PR ships the shared tier that exists today, the channel, and the MCP tiers; the org tier for agent, model, effort, boundary and instructions is the second PR under this record, because `resolve` reads `overrides.org` for `mcpServers` only and `config set` has no `org` scope, and when it lands the page gains a Workspace tab. The forms are native controls in the house classes, as the one search form already is, and the screenshot manifest re-renders once; both are cost, not risk.

## What would change our mind

If customers set personal settings far more than shared ones, the missing `me` tier makes the page useless to most viewers; the cheap evidence is the count of `config set me` versus `config set channel` and `mcp add --scope me` versus other scopes in run history over a month, a number this record does not have because the counting is a run-history query nobody has run. If the count says so, the open question below becomes the next record. Everything here is reversible: the page adds a section and one read command and changes no stored shape.

## Open questions

| Question | Owner | Resolves it | Needed before |
|---|---|---|---|
| Should an Access email ever map onto a Slack user for writes, bringing `me` to the dashboard? | the maintainer | the usage count above, and a record that adds the identity link to the actor resolver rather than to the page | never for this PR |
| Does the Channels tab need channel names, not ids? | the maintainer | whether the channel directory exposes names to the bot without a new Slack scope | the second settings PR |

## Validation criteria

| Criterion | Proof |
|---|---|
| `/settings`, `/settings/mcps`, `/settings/channels`, `/settings/channels/<id>`, `/settings/installation` render the shell with a `settings` seed for a gated identity; anything else under `/settings` is a 404 | `[unit]` `src/channels/settingsView.test.ts::parseSettingsRoute::the page, its three tabs, a channel under Channels, and a channel query on MCPs`, `src/channels/settingsView.test.ts::parseSettingsRoute::anything else under /settings is not a route: an unknown tab, a channel under the wrong tab, a malformed id` |
| The seed's `canWrite` equals `authorize(actor, …)` for org and channel, for a granted and an ungranted actor | `[unit]` `src/channels/settingsView.test.ts::the settings view::MCPs: the seed is `mcp list` invoked as the viewer, with canWrite from the org and channel questions`, `src/channels/settingsView.test.ts::the settings view::MCPs: a viewer without the grants sees the same rows read-only; without a channel the channel right is false` |
| No request the page composes carries `scope: "me"` for an unlinked session; the user scope is never rendered for it (amended by [record 0042](0042-a-dashboard-session-is-the-person-its-email-names-identity-not-authority.md): a session linked to its Slack person composes `me` and sees its person's tier) | `[unit]` `web/src/pages/settings.test.ts::McpServersPanel::Add posts mcp.add with the org tier, the agents joined, and never a `me` scope`, `web/src/pages/settings.test.ts::McpServersPanel for a linked session (record 0042)::an unlinked session sees the person's row read-only and cannot pick me` |
| A `me` write from an unlinked `access` caller is refused with the pointer to chat, on the config and the MCP commands; a chat caller's `me` write is unchanged | `[unit]` `src/core/commands/config.test.ts::config set::a credential needs config:write for any scope; a chat person always has their own scope; an Access browser session writes neither `me` (no run is its) nor `channel` (no grant)`, `src/core/commands/mcp.test.ts::mcp.* commands::a `me` write from the Access surface is refused with the pointer to chat (record 0041); org and channel writes and every read are unchanged for it` |
| `config overrides` lists only channels the caller may read and names settings, never values | `[unit]` `src/core/commands/config.test.ts::config overrides — the index of configured channels::*` |
| The installation projection contains no `*Env` name, no URL and no bot secret name for the full example config | `[unit]` `src/core/installationSettings.test.ts::installationSettings::never renders an env var name, a URL, a bearer, or a manifest secret name, whatever the config holds` |
| The header carries the settings cog for every installation (amended: a cog, not a nav section) and the MCPs tab only with the `mcp` capability | `web/src/components/AppNav.test.ts`, `web/src/pages/settings.test.ts` (bound in settings-page.md item 6) |
| Human-gated: an admin adds, connects and removes an org server from the deployed page; an ungranted viewer sees the page read-only | read half posted on #1375 (release 1.238.0, the tab and its rights as the maintainer); the write half and the ungranted viewer are the maintainer's, owed on the same thread |

## Accepted 2026-09-16

*Re-evaluation.* The bet was that the settings page is an adapter over the command registry and nothing more: it renders `config show` and `mcp list`, every write is a `POST /api/config.*` or `/api/mcp.*`, and the page carries no rule of its own about who may do what. Six PRs later it held without a page-only rule: #1375 built the three tabs, #1387 moved the way in to the header's cog, and [record 0042](0042-a-dashboard-session-is-the-person-its-email-names-identity-not-authority.md)'s three PRs (#1395, #1399, #1409) and its polish (#1428) added the `me` tier, every tier for an admin and promotion by adding commands and options to the registry, which the page then rendered; the conformance suite grew rows, the page grew no logic. The maintainer accepted the shape on that evidence ("agree with 41, settings is a projection / adapter over command registry"), live on release 1.238.0.

What changed since the proposal, checked against the reasoning above:

- **The tier the page did not offer is offered.** Record 0042 answered this record's first open question: the Access email links a session to its Slack person in the actor resolver, as identity and never authority, so the page's `me` is the person's and the refusal stands only for an unlinked session. The "what would change our mind" count of personal versus shared settings is moot; the validation row about `scope: "me"` is amended above, not removed.
- **A settings page never has "no data".** The maintainer's acceptance condition: every installation has defaults and every viewer has a scope, so a page that says "no channel carries a scope yet" or "settings are unavailable" is showing the reader an internal state, not their settings. The Channels tab is to show the viewer's effective settings and the installation's defaults before any channel is picked; an empty MCP list is a legitimate state (a fresh installation) and reads as product copy; a page served without its seed is an application error and renders as one. This is the next settings PR, not a change to the shape.
- **Channel names, not ids**, the second open question, stays open with the maintainer; it needs a channel-name lookup the directory does not expose today.

The record's validation rows carry their proofs now (the gap markers were the state before #1375); the human-gated row names what is still owed.

## Sources

- [mcp-tools.md](../reference/specs/mcp-tools.md), items 13 to 19 and the roadmap line deferring the page.
- [routing-and-config.md](../reference/specs/routing-and-config.md), items 2, 5, 12, 13, 16.
- [authorization.md](../reference/specs/authorization.md), the browser baseline and the `config-scope` rows.
- [Record 0040](0040-the-front-door-knows-the-data-sources-a-run-can-reach.md), the last change to the MCP tiers.
- [dashboard-routes.md](../reference/dashboard-routes.md), the generated `/api` table and the line that says there is no MCP page.
