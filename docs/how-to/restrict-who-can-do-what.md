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

Everything unnamed stays open: `review`, `research`, `general`, other repositories.

## Next

- [Authorization](../reference/authorization.md): the policy table.
- [Decision record](../decisions/0007-authorization-policy-table.md): why one table.
