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

## Every command you can run in chat

One table per group. "Who can run it" is what the authorization policy decides for a Slack user holding each `permissions` set (the narrowest set admitted is named) — see [reference: permissions](permissions.md) for what each set defaults to. A registered command that is deliberately not exposed to chat (`deploy all`, `deploy restart`, `env bootstrap`, `friction analyze`, and the paged `runs get|events|friction` reads) is absent from this table and reachable on the [CLI](cli.md), over HTTP, or as an MCP tool instead.

<!-- generated:chat-commands · npm run docs:gen — generated from the code, do not edit by hand -->

### `help`

| Command | What it does | Who can run it |
|---|---|---|
| `help show` | What Switchboard can do: agents, per-request directives, and every chat command. | anyone |

### `config`

| Command | What it does | Who can run it |
|---|---|---|
| `config show [--channel <string>]` | The effective agent/model/effort for you in this channel, the defaults, both scopes, and what is restricted. | anyone |
| `config set <channel\|me> [--agent <string>] [--model <string>] [--models <object>] [--effort <low\|medium\|high\|xhigh\|max>] [--efforts <object>] [--channel <string>]` | Set the agent, model, or effort for a channel (gated) or for yourself; per-agent forms take --models.&lt;agent&gt; / --efforts.&lt;agent&gt;. | anyone |
| `config clear <channel\|me> [--channel <string>]` | Drop every runtime override of a channel (gated) or of yourself; static config.yaml values show through again. | anyone |
| `config instructions <channel\|me> [text…] [--channel <string>]` | Custom instructions for a channel (gated) or for yourself — advisory prompt content that never changes agent, model, or permissions. | anyone |

### `runs`

| Command | What it does | Who can run it |
|---|---|---|
| `runs list [--status <active\|finished\|all>] [--agent <string>] [--channel <string>] [--since-ms <integer>] [--limit <integer>] [--before <integer>] [--before-id <string>]` | List runs (live and persisted, newest first) — metadata only, never message text. | admins |
| `runs stop <id> --mode <soft\|hard>` | Request a live run to stop (`--mode soft` = finish the current step; `hard` = abort now). Records the caller as the actor. | admins |

### `friction`

| Command | What it does | Who can run it |
|---|---|---|
| `friction report [--since-ms <integer>] [--limit <integer>] [--min-runs <integer>]` | Ranked recurring friction patterns across recent runs — read-only, GitHub never consulted. | anyone |
| `friction propose [--dry-run] [--top <integer>] [--min-runs <integer>] [--repo <string>]` | Run the self-improvement step: cluster recent friction, dedupe against open issues, file the top proposals as labeled issues. | repo managers (`repoManagement`) |

### `repo`

| Command | What it does | Who can run it |
|---|---|---|
| `repo list` | Every onboarded resident repo with its live state, ref, sha, last refresh, and disk gauge. | anyone |
| `repo onboard <slug> [--ref <string>] [--test <string>] [--build <string>] [--install <string>] [--evict-coldest]` | Onboard a repo as an always-warm resident environment (provisions billable compute; admin-gated). | repo managers (`repoManagement`) |
| `repo offboard <slug> [--dry-run]` | Tear down a resident repo: registry record, schedules, container, R2 snapshots (admin-gated; --dry-run plans only). | repo managers (`repoManagement`) |
| `repo reconfigure <slug> [--ref <string>] [--test <string>] [--build <string>] [--install <string>]` | Change a resident's default branch and/or command table (admin-gated; takes effect on the next refresh/attach). | repo managers (`repoManagement`) |
| `repo rebuild <slug> [--dry-run]` | Discard a resident's snapshot and reprovision it from scratch (admin-gated; --dry-run plans only). | repo managers (`repoManagement`) |
| `repo test <slug> [ref]` | Run the repo's onboarded test command with zero model turns (needs coding-agent access; the ref must be a plausible branch). | anyone allowed to run `coding` |
| `repo build <slug> [ref]` | Run the repo's onboarded build command with zero model turns (needs coding-agent access; the ref must be a plausible branch). | anyone allowed to run `coding` |

### `memory`

| Command | What it does | Who can run it |
|---|---|---|
| `memory list [query…] [--scope <me\|org\|repo\|channel\|all>] [--limit <integer>] [--repo <string>]` | Your own memory records and the shared org / repo / channel records, with ids — what influences your runs. | anyone |
| `memory forget <id>` | Soft-delete one memory record so it no longer influences any run (yours freely; shared org/repo/channel records need repo-management rights). | anyone |

### `mcp`

| Command | What it does | Who can run it |
|---|---|---|
| `mcp list [--channel <string>]` | External MCP servers your runs in this channel can use — org-wide, this channel's, and your own — with state and agents; never a credential. | anyone |
| `mcp add <name> --url <string> [--scope <me\|channel\|org>] [--agents <string>] [--auth <oauth\|bearer\|none>] [--channel <string>]` | Register an external MCP server for yourself, this channel, or the org — auth is detected from the server; sign-in or a token happens on a one-time link, never in chat. | anyone |
| `mcp connect <name> [--scope <me\|channel\|org>] [--channel <string>]` | A fresh one-time link to sign in to an OAuth server or enter (or replace) a bearer server's token — only you can complete it; it expires in 10 minutes. | anyone |
| `mcp show <name> [--scope <me\|channel\|org>] [--channel <string>]` | One MCP server's entry plus a live probe of the tools it offers (names, read-only flags); never a credential. | anyone |
| `mcp remove <name> [--scope <me\|channel\|org>] [--channel <string>]` | Remove an MCP server you added and its stored credential (yours freely; channel ones need channel-config rights, org-wide ones admin rights). | anyone |

### `schedule`

| Command | What it does | Who can run it |
|---|---|---|
| `schedule list` | Every scheduled job (cron, UTC), which Worker fires it, its next firing, and what its last firing did. | anyone |

### `deploy`

| Command | What it does | Who can run it |
|---|---|---|
| `deploy plan [--only <string>] [--skip <string>] [--force] [--allow-branch] [--wait-max <integer>] [--poll <integer>]` | The production deploy plan: checks, Worker order, preflight handling — computed, nothing executed. | admins |

<!-- /generated:chat-commands -->

## Where each group is explained

| Group | The narrative version |
|---|---|
| `config` | [how-to: configure your defaults](../how-to/configure-your-defaults.md), [explanation: config layers](../explanation/config-layers.md) |
| `mcp` | [how-to: connect an MCP server](../how-to/connect-an-mcp-server.md) |
| `repo` | [how-to: onboard a repo](../how-to/onboard-a-repo.md) |
| `runs` | [how-to: watch a run and check spend](../how-to/watch-a-run-and-check-spend.md) |
| `friction` | [explanation: how Switchboard improves itself](../self-improvement-architecture.md) |

## Repo commands run no model turns

`repo test` and `repo build` run the repo's onboarded command and report pass/fail with zero model calls — an operation, not an agent run. Natural-language equivalents ("run the tests on main in acme/api") are recognized too and route to the same zero-turn operation.
