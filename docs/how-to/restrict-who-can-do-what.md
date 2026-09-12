# Restrict who can do what

Name the admins, grant the org, close what needs a grant, and give machines exactly what they hold.

**You need:** `config.yaml`, a way to make it live (restart; on Cloudflare `deploy config` then `deploy restart`), and the ids (`config show` prints yours).

`grants` says what each actor holds; `restrict` closes agents and repositories to the ungranted.

## Name an admin

```yaml
grants:
  slack:U0123ADMIN:
    actions: all
    channels: all
    repos: all
```

Without an `all` entry nobody is admin and every gated command is refused.

## Everyone in the org

```yaml
grants:
  access:*:                             # every Access browser session
    actions: all
    channels: all
    repos: all
```

Access already decides who may log in, so `access:*` is the org, granted once; `slack:*`, `http:*`, `mcp:*` work the same. A person's own entry adds to it, never narrows it.

## Close an agent

```yaml
restrict:
  agents: [coding]                      # closed unless granted …
grants:
  slack:U0456DEV:
    actions: [agent:run:coding]         # … and the grant
```

Checked when the run starts, against the resolved agent; unlisted agents stay open.

## Close a repository

```yaml
restrict:
  repos: [acme/payments]                # closed unless granted …
grants:
  slack:U0456DEV:
    repos: [acme/payments]              # … on the `repos` axis
```

Unlisted repositories stay open; slugs are case-insensitive.

## Cap what a channel's runs may have

```yaml
channels:
  slack:C012345:
    boundary:
      maxMinutes: 45                     # every run here is clipped to 45 minutes
      maxIdentity: read                  # a preset that needs `write` (coding, ship) is refused by name
      machines: [none, repo-resident]    # a preset on another class is refused
```

Or from chat, with `config:write`: `@switchboard config set channel --boundary.maxIdentity read`.

A boundary is not a grant and not a restriction: `restrict` says who may run a preset, a boundary says how much any run in the scope may have — its wall-clock budget, the credential it acts as (`none < read < write`), the machine class its tools execute on. A budget above the cap is clipped and the card says so; an identity or class above the cap is refused before a card, a thread claim or an executor exists, naming the preset, the cap and whose boundary it is. Boundaries intersect across `defaults`, the channel and the user — the smallest budget, the lowest identity, the classes every layer allows — so nobody can widen one from below: `config set me --boundary.…` is open to everyone because it can only tighten.

## Allow channel configuration

```yaml
grants:
  slack:U0456DEV:
    actions: [config:write]
```

Gates channel `config set`/`clear`/`instructions` and channel-scope MCP servers; `config set me` is always open.

## Allow repository management

```yaml
grants:
  slack:U0789OPS:
    actions: [repo:write, friction:write]   # friction propose files issues
```

Gates `repo onboard`/`offboard`/`reconfigure`/`rebuild` (billable compute); `repo list` is open.

## Grant the machine surfaces

```yaml
grants:
  access:jane@acme.com:                 # Access browser identity (its `sub`)
    actions: [runs:write, friction:write]
    channels: all
  access:svc:ops-bot:                   # Access service token (its common_name)
    actions: [runs:read, runs:write, friction:read]
    channels: all
  http:ci:                              # ingress token subject (`mcp:ci` over MCP)
    actions: [dispatch, runs:read]
```

- Access browser sessions hold every group's `read`; writes need a grant.
- Service and ingress tokens hold exactly their entry; unlisted ones cannot `dispatch`. `SWITCHBOARD_INGRESS_TOKENS` only identifies.

## Check it

```
@switchboard config show
```

Every refusal names the missing grant and who can give it.

## A locked-down example

```yaml
restrict:
  agents: [coding, ship]
  repos: [acme/payments]
grants:
  slack:U0100FOUNDER:
    actions: all
    channels: all
    repos: all
  slack:U0456DEV:
    actions: [agent:run:coding, agent:run:ship, config:write, repo:write, friction:write]
    repos: [acme/payments]
```

Everything unnamed stays open: `review`, `research`, `explore`, `conductor`, `general`, other repositories. Add a `boundary` under a channel to cap what even the granted may have there. `conductor` starts child runs as the person who asked — each child passes these same gates as that person, so it grants nothing they lack — and the example config lists it under `restrict.agents` for a deployment that wants fan-out closed by default: uncomment one line.

## Next

- [Authorization](../reference/authorization.md): the policy table.
- [Decision record](../decisions/0007-authorization-policy-table.md): why one table.
