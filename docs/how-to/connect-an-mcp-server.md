# Connect an MCP server

Give an agent tools from an external service — an issue tracker, a wiki, a server of your own — over the Model Context Protocol, without pasting a token into chat.

## Before you start

- The installation has an `mcp` block in `config.yaml` naming the env var that holds the credential key (`credentialKeyEnv`, `MCP_CREDENTIAL_KEY` by default). Without it the `mcp` commands do not exist ([Turn features on and off](turn-features-on-and-off.md)).
- The server's URL. OpenSwitchboard detects whether it uses OAuth or a bearer token; `--auth` overrides the detection.
- For a channel-wide server, the `config:write` grant; for an org-wide one, admin rights.

## 1. Register the server

```
@switchboard mcp add linear --url https://mcp.linear.app/sse
```

With no `--scope`, the server is yours alone. The reply carries a one-time link, not a request for a token in chat.

## 2. Sign in, or paste the token, on the link

Open the link. An OAuth server sends you through its own sign-in; a bearer server shows a form for the token. Only you can complete the link, once, and it expires after ten minutes. If you lose it, `@switchboard mcp connect linear` mints a fresh one. The credential is sealed at rest and decrypted only while a request to that server is being built; no command ever prints it.

## 3. Check what the agent can now call

```
@switchboard mcp list             # servers your runs in this channel can use
@switchboard mcp show linear      # a live probe of its tools
```

Then ask for something that needs the tool. The run page lists the `mcp__linear__…` calls the agent made ([Watch a run](watch-a-run.md)).

## 4. Share it wider, if you mean to

| Scope | Who may set it | Reaches | Agents that may use it |
|---|---|---|---|
| `me` (the default) | anyone | your own runs | `general`, `research` |
| `channel` | `config:write` holders | every run in that channel | `general`, `research` |
| `org` | admins, or `mcpServers` in `config.yaml` | every run everywhere | any, including `coding`, `review`, `ship` |

```
@switchboard mcp add linear --url https://mcp.linear.app/sse --scope channel
@switchboard mcp add linear --url https://mcp.linear.app/sse --scope org --agents general,research,coding
```

`--agents` is a comma-separated list; the default is `general,research`. A name set at more than one scope resolves org first, then channel, then you. Naming `coding`, `review` or `ship` on a `me` or `channel` server is refused, not ignored; why is in [Execution and trust](../explanation/execution-and-trust.md#why-only-an-org-wide-mcp-server-reaches-the-writing-agents).

## 5. Remove it

```
@switchboard mcp remove linear
```

This removes the entry and its stored credential. A channel entry needs `config:write`; an org entry needs admin rights.

## What you did

You registered a server, gave it a credential over a single-use link, confirmed its tools, and chose who else it reaches. The agent now sees the server's tools as `mcp__<server>__<tool>` on every run the scope covers.

## See also

- [Slack commands](../reference/slack-commands.md#mcp) — every `mcp` flag.
- [MCP tools](../reference/specs/mcp-tools.md) — the contract: scopes, sealing, what a run sees.
