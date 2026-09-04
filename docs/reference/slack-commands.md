# Reference: Slack commands

Everything below works identically as a bare mention, a DM, or a thread follow-up. The same grammar also works, unmodified, on the CLI and as chat text over HTTP/MCP ingress — see [reference: CLI](cli.md).

## Talking to it

| Do this | To |
|---|---|
| `@switchboard <anything>` | start or continue a conversation (first message in a channel needs the mention; DMs and thread follow-ups never do) |
| `@switchboard help` | list every command |
| `<group> help` | usage for one command group, e.g. `config help` |

## Directives (inline, per-request only)

Placed right after the mention, before the request text:

| Directive | Example | Effect |
|---|---|---|
| `agent:<name>` | `agent:review` | run this agent for this message only |
| `model:<provider>/<model>` | `model:openai/gpt-5` | use this model for this message only |
| `effort:<low\|medium\|high>` | `effort:low` | how hard the model thinks this turn |

Combine freely: `agent:ship model:anthropic/claude-opus-5 effort:high in acme/api: fix #42`.

## Config

| Command | Effect |
|---|---|
| `config show` | what's active right now, and why |
| `config set me --model <p/m>` / `--models.<agent> <p/m>` / `--effort <e>` / `--efforts.<agent> <e>` / `--agent <name>` | your personal defaults |
| `config set channel --agent <name>` / `--model …` / `--efforts.<agent> …` | this channel's defaults (needs `channelConfig`) |
| `config clear me` / `config clear channel` | drop the overrides at that scope |
| `config instructions me "<text>"` / `config instructions channel "<text>"` | free-text advisory instructions (≤2000 chars); empty string clears |

Full precedence and rationale: [how-to: configure your defaults](../how-to/configure-your-defaults.md), [explanation: config layers](../explanation/config-layers.md).

## MCP servers

| Command | Effect |
|---|---|
| `mcp add <name> --url <url> [--auth bearer\|none]` | register a server (self-serve, your scope) |
| `mcp connect <name>` | re-mint a connect link for an existing server |
| `mcp list` | servers visible to you: org + this channel + your own |
| `mcp show <name>` | that server's tools |
| `mcp remove <name>` | remove one you own |

Details: [how-to: connect an MCP server](../how-to/connect-an-mcp-server.md).

## Resident repos

| Command | Effect |
|---|---|
| `repo list` | every onboarded repo and its lifecycle state (open to everyone) |
| `repo onboard <owner/name> [--ref <ref>] [--test <cmd>] [--build <cmd>] [--install <cmd>]` | provision an always-warm environment (gated: `repoManagement`) |
| `repo reconfigure <owner/name> <key>=<value>...` | change its test/build/install command |
| `repo offboard <owner/name> [--dry-run]` | tear it down |
| `repo rebuild <owner/name>` | discard and reprovision from scratch |

Details: [how-to: onboard a repo](../how-to/onboard-a-repo.md).

## Runs

| Command | Effect |
|---|---|
| `runs list [--status all\|active]` | recent runs |
| `runs get <id>` | one run's summary |
| `runs events <id>` | its full event stream |
| `runs friction <id>` | why it was slow, if it was |
| `runs stop <id> --mode soft\|hard` | stop it — `soft` lets it wrap up, `hard` aborts mid-call |

## Friction and self-improvement

| Command | Effect |
|---|---|
| `friction report [--since-ms n] [--limit n] [--min-runs n]` | recurring friction patterns across recent runs (open to everyone, read-only) |
| `friction propose [--dry-run] [--top n] [--min-runs n] [--repo o/n]` | file the top patterns as labeled GitHub issues (gated: admins/`repoManagement`) |

## Memory

| Command | Effect |
|---|---|
| `memory list [words…] [--scope me\|org\|repo\|channel\|all] [--limit n] [--repo o/n]` | search what's remembered |
| `memory forget <id>` | soft-delete a record (own scope: free; shared scopes: admin-gated) |

## Schedule

| Command | Effect |
|---|---|
| `schedule list` | every cron job Switchboard runs, and when it last fired |

## Repo commands (no model turn)

| Command | Effect |
|---|---|
| `repo test <owner/name> [<ref>]` | run the repo's onboarded test command, report pass/fail — zero model calls |
| `repo build <owner/name> [<ref>]` | same, for the build command |

Natural-language equivalents ("run the tests on main in acme/api") are recognized too and route to the same zero-turn operation.
