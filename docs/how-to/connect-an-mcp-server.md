# Connect an MCP server

Give an agent tools from an external service over the Model Context Protocol, with the credential entered on a one-time link, never in chat.

**You need:**

- An `mcp` block in `config.yaml` naming the credential-key env var (`credentialKeyEnv`, default `MCP_CREDENTIAL_KEY`); without it the `mcp` commands do not exist ([Turn features on and off](turn-features-on-and-off.md)).
- The server's URL. OAuth or bearer is detected; `--auth oauth|bearer|none` overrides.
- For a channel-wide server, the `config:write` grant; for an org-wide one, admin rights.

## Register the server

```
@switchboard mcp add linear --url https://mcp.linear.app/sse
```

With no `--scope` the server is yours alone; the reply carries a one-time link.

## Complete the link

Open it: an OAuth server sends you through its own sign-in, a bearer server shows a form for the token. Only you can complete it, once, within ten minutes; `@switchboard mcp connect linear` mints a fresh one. The credential is sealed at rest and no command ever prints it.

## Check what the agent can call

```
@switchboard mcp list             # servers your runs in this channel can use
@switchboard mcp show linear      # a live probe of its tools
```

Then ask for something that needs the tool; the run page lists the `mcp__linear__…` calls ([Watch a run](watch-a-run.md)).

## Share it wider

| Scope | Who may set it | Reaches | Agents that may use it |
|---|---|---|---|
| `me` (the default) | anyone | your own runs | `general`, `research` |
| `channel` | `config:write` holders | every run in that channel | `general`, `research` |
| `org` | admins, or `mcpServers` in `config.yaml` | every run everywhere | any, including `coding`, `review`, `ship` |

```
@switchboard mcp add linear --url https://mcp.linear.app/sse --scope channel
@switchboard mcp add linear --url https://mcp.linear.app/sse --scope org --agents general,research,coding
```

- `--agents` is a comma-separated list; the default is `general,research`.
- A name set at more than one scope resolves org first, then channel, then you.
- Naming `coding`, `review` or `ship` on a `me` or `channel` server is refused ([why](../explanation/execution-and-trust.md#why-only-an-org-wide-mcp-server-reaches-the-writing-agents)).

## A server behind Cloudflare Access

Access admits a machine by two headers, `CF-Access-Client-Id` and `CF-Access-Client-Secret`, not by the server's own auth, so such a server is pinned in `config.yaml` with `headersEnv` — header name → the bot env var holding the value:

```yaml
defaults:
  mcpServers:
    lake:
      url: https://vega.example.com/mcp
      auth: none
      headersEnv:
        CF-Access-Client-Id: MCP_ACCESS_CLIENT_ID
        CF-Access-Client-Secret: MCP_ACCESS_CLIENT_SECRET
      agents: [general, research]
```

Mint the service token in the guarding account (Zero Trust → Access → Service Auth), enroll its id on that Access application's policy, then on Cloudflare put both values (`deploy secrets bot --only MCP_ACCESS_CLIENT_ID`, again for the secret) and `deploy restart`. `mcp list` shows it as `static`; an unset variable makes the server `unavailable` for the run, naming the variable. `headersEnv` composes with `auth: bearer` + `tokenEnv` when the server behind the gate wants a token of its own; the Authorization header itself is refused there.

## Remove it

```
@switchboard mcp remove linear
```

Removes the entry and its stored credential; a channel entry needs `config:write`, an org entry admin rights.

## From the dashboard

Open **Settings → MCPs** on the dashboard (`/settings/mcps`). It lists every server your runs can reach, by tier, and adds one for the whole org or for one channel (type the channel's id in the field at the top): the same `mcp add`, with the one-time link shown on the page. Personal servers stay in chat, where your runs are requested as you; the dashboard refuses a `me` write and says so.

## Next

- [Slack commands](../reference/slack-commands.md#mcp): every `mcp` flag.
- [MCP tools](../reference/specs/mcp-tools.md): scopes, sealing, what a run sees.
