# Restrict who can do what

Goal: lock down a real deployment. Authorization is two blocks in `config.yaml`: **`grants`** — what each person or credential holds — and **`restrict`** — which agents and repos are closed to everyone not granted them. A fresh config with neither block is open: every Slack user can run every agent against every repo, but nobody can change channel config, onboard repos, read the run history, or act over HTTP/MCP, because none of those is ever a baseline.

## Start here: an admin

```yaml
grants:
  slack:U0123ADMIN:
    actions: all
    channels: all
    repos: all
```

`all` on every axis is what "admin" means. Without such an entry nobody is one: the 🚫 replies have nobody to name, and the fail-closed commands below are refused for everyone.

## Gate an agent

```yaml
restrict:
  agents: [coding]                      # closed unless granted …
grants:
  slack:U0456DEV:
    actions: [agent:run:coding]         # … and here is the grant
```

The restriction is enforced **at run time, against the resolved agent** — after directives, thread stickiness, and every config layer. Typing `agent:coding` without the grant gets you a run of the agent you were already allowed to use, with a reply naming who to ask. `config set me --agent coding` is always allowed to *set*, harmlessly, because the gate applies when the run actually happens. Agents not listed under `restrict.agents` stay open to everyone.

## Gate who can touch a repo's resident

```yaml
restrict:
  repos: [acme/payments]                # closed unless granted …
grants:
  slack:U0456DEV:
    repos: [acme/payments]              # … to whoever's `repos` axis names it
```

Repos not listed stay open to anyone who may run the coding agent. A listed repo refuses everyone else **by name**, before any executor is created and before any GitHub write on it. Slugs compare case-insensitively.

## Channel-level config changes

`config set/clear/instructions channel` (and channel-tier MCP servers) need `config:write`, which no one holds by default. Grant it:

```yaml
grants:
  slack:U0456DEV:
    actions: [config:write]
```

A Slack user's own scope (`config set me`) is always open.

## Repo management

`repo onboard/offboard/reconfigure/rebuild` provision always-on billable compute and bind GitHub credentials — real money and real repo access. They need `repo:write`, never a baseline: only admins until you say otherwise.

```yaml
grants:
  slack:U0789OPS:
    actions: [repo:write, friction:write]   # friction propose files issues; usually the same people
```

`repo list` (read-only) is open regardless.

## The machine surfaces (HTTP/MCP)

The `/api/*` and MCP surfaces run the same commands chat does, for identities that are not Slack users:

```yaml
grants:
  access:jane@acme.com:                 # a Cloudflare Access browser identity (its `sub`)
    actions: [runs:write, friction:write]
    channels: all                       # sees the whole fleet's runs
  access:svc:ops-bot:                   # an Access service token (its common_name)
    actions: [runs:read, runs:write, friction:read]
    channels: all
  http:ci:                              # an ingress token's subject over /ingress …
    actions: [dispatch, runs:read]
  mcp:ci:                               # … and the same subject over MCP
    actions: [dispatch, runs:read]
```

Every signed-in Access browser session holds every group's `read` for free; writes come from a grant. Service tokens and ingress tokens hold **exactly** their entry — an unlisted one can do nothing, not even start a run (`dispatch`). The token map itself (`SWITCHBOARD_INGRESS_TOKENS`) only identifies: `{ "<token>": { "subject": "ci" } }`.

## A realistic locked-down example

```yaml
restrict:
  agents: [coding, ship]
  repos: [acme/payments]                # only this one repo is name-restricted
grants:
  slack:U0100FOUNDER:
    actions: all
    channels: all
    repos: all
  slack:U0456DEV:
    actions: [agent:run:coding, agent:run:ship, config:write, repo:write, friction:write]
    repos: [acme/payments]
  slack:U0457DEV:
    actions: [agent:run:coding]
```

Everything not mentioned — the `review`/`research`/`general` agents, every other repo — stays open. A restriction closes one thing; a grant opens one thing for one actor; neither is an all-or-nothing switch.

## See also

- [Reference: authorization](../reference/authorization.md) — every axis, every baseline, the actions vocabulary, and the mapping from the retired `permissions` block.
- [Onboard a repo](onboard-a-repo.md) — the command surface `repo:write` is gating.
