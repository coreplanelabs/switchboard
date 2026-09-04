# Connect an MCP server

Goal: give an agent tools from an external service — Linear, Notion, your own internal server — over MCP, without ever pasting a token into chat.

## Connect one for yourself

```
@switchboard mcp add linear --url https://mcp.linear.app/sse
```

The bot replies with a **one-time link**, not a prompt for a token in chat. Open it (you'll need to be signed in behind the same access gate as the dashboard), paste the server's token into the form, submit. That's the entire credential path — the token is sealed on the state Worker and the bot decrypts it only for the moment it builds a request to that server.

```
@switchboard mcp list             # servers you can currently see
@switchboard mcp show linear      # its tools
```

Ask the bot something that needs the tool — the [run page](watch-a-run-and-check-spend.md) shows the `mcp__linear__…` calls it made along the way.

Remove it: `@switchboard mcp remove linear`.

## Three tiers, three audiences

| Tier | Who sets it | Reaches | Notes |
|---|---|---|---|
| `me` | anyone, self-serve | only your own runs | `mcp add` with no scope flag |
| `channel` | anyone with `channelConfig` | every run in that channel | same gate as `config set channel` |
| `org` | admins only (or `config.yaml` `defaults.mcpServers`) | every run, everywhere | the only tier that may reach `coding`, `review`, or `ship` |

A name set at more than one tier resolves org-first, channel-second, user-last — the opposite order from model/agent precedence, because an org-level server is an admin's decision that a user shouldn't be able to shadow.

## Why coding/review/ship are org-only

A remote MCP server's tool descriptions and results are attacker-controlled text as far as Switchboard is concerned — the same untrusted-input treatment as anything else a model reads off the internet. The `coding` and `review`/`ship` agents run with repo write tokens or a trust contract that a channel or personal server shouldn't get to influence, so only an org-approved server can reach them. `general` and `research` — the agents with no write access — can use any tier. Adding a channel/user server naming `coding` is refused outright, not silently ignored.

## See also

- [Reference: Slack commands](../reference/slack-commands.md)
- [Explanation: execution and trust](../explanation/execution-and-trust.md) — the same untrusted-input reasoning applied to tools generally.
