# Restrict who can do what

Lock down a deployment: name the admins, close the agents and repositories that need a grant, and give machines exactly what they hold.

Authorization is two blocks in `config.yaml`. **`grants`** says what each person or credential holds; **`restrict`** says which agents and repositories are closed to everyone not granted them. A fresh config with neither block is open: every Slack user can run every agent against every repository, but nobody can change channel config, onboard a repository, read run history, or act over HTTP or MCP, because none of those is ever a baseline.

## Before you start

- Access to the installation's `config.yaml` and a way to make a change live: a restart locally, `deploy config` then `deploy restart` on Cloudflare ([Operate production](operate-production.md)).
- The platform ids of the people involved. A Slack user is `slack:U…`; `config show` prints yours.

## 1. Name an admin

```yaml
grants:
  slack:U0123ADMIN:
    actions: all
    channels: all
    repos: all
```

`all` on every axis is what "admin" means. Without such an entry nobody is one: refusals have nobody to name, and the fail-closed commands below are refused for everyone.

## 2. Close an agent

```yaml
restrict:
  agents: [coding]                      # closed unless granted …
grants:
  slack:U0456DEV:
    actions: [agent:run:coding]         # … and here is the grant
```

The check runs when a run starts, against the agent that resolved after directives, thread stickiness and every config layer. Typing `agent:coding` without the grant runs the agent you were already allowed to use, with a reply naming who to ask. `config set me --agent coding` still succeeds as a write, harmlessly. Agents not listed stay open.

## 3. Close a repository

```yaml
restrict:
  repos: [acme/payments]                # closed unless granted …
grants:
  slack:U0456DEV:
    repos: [acme/payments]              # … to whoever's `repos` axis names it
```

Unlisted repositories stay open to anyone who may run the coding agent. A listed one refuses everyone else by name, before any executor is created and before any GitHub write. Slugs compare case-insensitively.

## 4. Allow channel configuration

`config set`, `config clear` and `config instructions` on a channel, and channel-scope MCP servers, need `config:write`:

```yaml
grants:
  slack:U0456DEV:
    actions: [config:write]
```

A user's own scope (`config set me`) is always open.

## 5. Allow repository management

`repo onboard`, `repo offboard`, `repo reconfigure` and `repo rebuild` provision billable compute and bind a GitHub credential, so they need `repo:write`, never a baseline:

```yaml
grants:
  slack:U0789OPS:
    actions: [repo:write, friction:write]   # friction propose files issues; usually the same people
```

`repo list` is open regardless.

## 6. Grant the machine surfaces

`/api/*` and MCP run the same commands chat does, for identities that are not Slack users:

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

A signed-in Access browser session holds every group's `read` without an entry; writes come from a grant. Service tokens and ingress tokens hold exactly their entry: an unlisted one can do nothing, not even start a run (`dispatch`). The token map itself, `SWITCHBOARD_INGRESS_TOKENS`, only identifies: `{ "<token>": { "subject": "ci" } }`.

## 7. Check it

`config show` prints what is restricted alongside the effective settings. Every refusal names the grant it wanted and who can give it.

## A locked-down example

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

Everything not mentioned — the `review`, `research` and `general` agents, every other repository — stays open. A restriction closes one thing; a grant opens one thing for one actor; neither is an all-or-nothing switch.

## What you did

You named the admins, closed what needs closing, and granted each person and machine exactly what it holds. Every entry above is one row in the policy table that [Authorization](../reference/authorization.md) lists axis by axis; why authorization is one table asked once per request is [the decision record](../decisions/0007-authorization-policy-table.md).
