# Reference: CLI

`npx tsx src/cli.ts` (or `npm run cli --`) is the operator toolbox — every registered command, plus two built-ins: one for talking to the agent pipeline directly, one for running the bot.

## Form

```
npx tsx src/cli.ts <group> <verb> [args…] [--kebab-option value…] [--json]
```

- Flags are kebab-case on the CLI (`--min-runs 2`), camelCase in the underlying schema, and dotted for nested options (`--models.coding openai/gpt-5`) — the same grammar chat and HTTP use, just a different flag style.
- `--json` prints the exact result the command produced, with no rendering — useful for scripting or for confirming what a chat/HTTP call would have gotten back.
- `<group> help` and the bare `help` are derived automatically from the registry; there is no separate help text to maintain.

## The two built-ins: `ask` and `start`

```
npx tsx src/cli.ts ask [--thread <key>] "<request>"
```

Not a registered command — a **channel**, exactly like Slack, just printing to your terminal instead. Directives (`agent:`, `model:`, `effort:`) work identically. Use `--thread` to simulate a follow-up in an existing thread (stickiness applies). The answer goes to stdout and nothing else does — the status lines and the process log (`[run] …`) go to stderr — and the process exits 1 when the run did not complete — a refused key, a failed tool — so a script can tell an answer from a failure.

```
npx tsx src/cli.ts start
```

Not a registered command either — the **bot process** itself, the one the container image runs: Slack over Socket Mode and, with `PORT` set, the HTTP server and the dashboard, until Ctrl-C. It reads `.env` and `config/config.yaml` from the installation (`SWITCHBOARD_HOME`, else the directory you run it in when that holds one, else `~/.switchboard`; a checkout is always its own); `start --help` lists everything it reads. From the published package it is `npx @coreplane/switchboard start` — the bot from an empty directory with no Docker.

## Every command

One table per group, in registration order. "Surfaces" is where that command can be invoked at all: `every surface` means Slack, the CLI, HTTP, and MCP alike, and anything narrower — `CLI only`, `CLI · HTTP · MCP` — is a deliberate opt-out, not an oversight.

<!-- generated:cli-commands · npm run docs:gen — generated from the code, do not edit by hand -->

### `help`

| Command | What it does | Surfaces |
|---|---|---|
| `help show` | What Switchboard can do: agents, per-request directives, and every chat command. | every surface |

### `status`

| Command | What it does | Surfaces |
|---|---|---|
| `status show` | Which build this process runs: version, commit, when it was built and started, runs in flight, draining. | every surface |

### `config`

| Command | What it does | Surfaces |
|---|---|---|
| `config show [--channel <string>]` | The effective agent/model/effort for you in this channel, the defaults, both scopes, and what is restricted. | every surface |
| `config set <channel\|me> [--agent <string>] [--model <string>] [--models <object>] [--effort <low\|medium\|high\|xhigh\|max>] [--efforts <object>] [--channel <string>]` | Set the agent, model, or effort for a channel (gated) or for yourself; per-agent forms take --models.&lt;agent&gt; / --efforts.&lt;agent&gt;. | every surface |
| `config clear <channel\|me> [--channel <string>]` | Drop every runtime override of a channel (gated) or of yourself; static config.yaml values show through again. | every surface |
| `config instructions <channel\|me> [text…] [--channel <string>]` | Custom instructions for a channel (gated) or for yourself — advisory prompt content that never changes agent, model, or permissions. | every surface |

### `runs`

| Command | What it does | Surfaces |
|---|---|---|
| `runs list [--status <active\|finished\|all>] [--agent <string>] [--channel <string>] [--since-ms <integer>] [--limit <integer>] [--before <integer>] [--before-id <string>]` | List runs (live and persisted, newest first) — metadata only, never message text. | every surface |
| `runs get <id> [--include <messages>]` | One run's record; `--include messages` adds its events with free text wrapped as untrusted content. | CLI · HTTP · MCP |
| `runs events <id> [--after-seq <integer>] [--limit <integer>]` | A page of one run's events after `--after-seq` (server-capped); free text wrapped as untrusted content. | CLI · HTTP · MCP |
| `runs friction <id>` | One run's friction diagnosis (live: computed now; persisted: as stored). | CLI · HTTP · MCP |
| `runs stop <id> --mode <soft\|hard>` | Request a live run to stop (`--mode soft` = finish the current step; `hard` = abort now). Records the caller as the actor. | every surface |

### `review`

| Command | What it does | Surfaces |
|---|---|---|
| `review abridge <id> [--model <string>] [--force] [--wait]` | Abridge a finished PR review's reading diff with meat.dev on the bot host (one Opus-class call) and store it on the run; idempotent — a stored one is answered, not recomputed. | every surface |

### `friction`

| Command | What it does | Surfaces |
|---|---|---|
| `friction report [--since-ms <integer>] [--limit <integer>] [--min-runs <integer>]` | Ranked recurring friction patterns across recent runs — read-only, GitHub never consulted. | every surface |
| `friction propose [--dry-run] [--top <integer>] [--min-runs <integer>] [--repo <string>]` | Run the self-improvement step: cluster recent friction, dedupe against open issues, file the top proposals as labeled issues. | every surface |
| `friction analyze [source] [--slow-ms <number>] [--in-progress]` | Read-only friction diagnosis of a saved run-event stream (JSONL or an SSE capture) — the former frictionCli. | CLI only |

### `repo`

| Command | What it does | Surfaces |
|---|---|---|
| `repo list` | Every onboarded resident repo with its live state, ref, sha, last refresh, and disk gauge. | every surface |
| `repo onboard <slug> [--ref <string>] [--test <string>] [--build <string>] [--install <string>] [--evict-coldest]` | Onboard a repo as an always-warm resident environment (provisions billable compute; admin-gated). | every surface |
| `repo offboard <slug> [--dry-run]` | Tear down a resident repo: registry record, schedules, container, R2 snapshots (admin-gated; --dry-run plans only). | every surface |
| `repo reconfigure <slug> [--ref <string>] [--test <string>] [--build <string>] [--install <string>]` | Change a resident's default branch and/or command table (admin-gated; takes effect on the next refresh/attach). | every surface |
| `repo rebuild <slug> [--dry-run]` | Discard a resident's snapshot and reprovision it from scratch (admin-gated; --dry-run plans only). | every surface |
| `repo test <slug> [ref]` | Run the repo's onboarded test command with zero model turns (needs coding-agent access; the ref must be a plausible branch). | every surface |
| `repo build <slug> [ref]` | Run the repo's onboarded build command with zero model turns (needs coding-agent access; the ref must be a plausible branch). | every surface |

### `memory`

| Command | What it does | Surfaces |
|---|---|---|
| `memory list [query…] [--scope <me\|org\|repo\|channel\|all>] [--limit <integer>] [--repo <string>]` | Your own memory records and the shared org / repo / channel records, with ids — what influences your runs. | every surface |
| `memory forget <id>` | Soft-delete one memory record so it no longer influences any run (yours freely; shared org/repo/channel records need repo-management rights). | every surface |

### `mcp`

| Command | What it does | Surfaces |
|---|---|---|
| `mcp list [--channel <string>]` | External MCP servers your runs in this channel can use — org-wide, this channel's, and your own — with state and agents; never a credential. | every surface |
| `mcp add <name> --url <string> [--scope <me\|channel\|org>] [--agents <string>] [--auth <oauth\|bearer\|none>] [--channel <string>]` | Register an external MCP server for yourself, this channel, or the org — auth is detected from the server; sign-in or a token happens on a one-time link, never in chat. | every surface |
| `mcp connect <name> [--scope <me\|channel\|org>] [--channel <string>]` | A fresh one-time link to sign in to an OAuth server or enter (or replace) a bearer server's token — only you can complete it; it expires in 10 minutes. | every surface |
| `mcp show <name> [--scope <me\|channel\|org>] [--channel <string>]` | One MCP server's entry plus a live probe of the tools it offers (names, read-only flags); never a credential. | every surface |
| `mcp remove <name> [--scope <me\|channel\|org>] [--channel <string>]` | Remove an MCP server you added and its stored credential (yours freely; channel ones need channel-config rights, org-wide ones admin rights). | every surface |

### `schedule`

| Command | What it does | Surfaces |
|---|---|---|
| `schedule list` | Every scheduled job (cron, UTC), which Worker fires it, its next firing, and what its last firing did. | every surface |

### `deploy`

| Command | What it does | Surfaces |
|---|---|---|
| `deploy plan [--only <string>] [--skip <string>] [--affected] [--base <string>] [--force] [--allow-branch] [--wait-max <integer>] [--poll <integer>]` | The production deploy plan: checks, Worker order, preflight handling — computed, nothing executed. With --affected, also which Workers this tree actually needs deployed and why. | every surface |
| `deploy all [--only <string>] [--skip <string>] [--affected] [--base <string>] [--force] [--allow-branch] [--wait-max <integer>] [--poll <integer>] [--dry-run]` | Deploy production in the one supported order (memory → bot → resident → sandbox), waiting out preflights and each live gate — the bot's drain, the sandbox's image rollout and an `echo ok` probe — until the new containers are live. In `registry` mode it first copies the release's images its Workers lack into the account registry (what `deploy images` does). --affected deploys only the Workers whose inputs changed since what they serve — the release deploy. | CLI only |
| `deploy restart [--only <bot>] [--force] [--wait-max <integer>] [--poll <integer>]` | Restart the bot container without an image build — how a rotated bot secret goes live (~30 s): runs in flight hand off to the next container; done once /healthz answers with a later startedAt. | CLI only |
| `deploy init [--check]` | Render every Worker's wrangler.jsonc from the wrangler.template.jsonc beside it and the deployment profile, and the project's docs site's from project.json — generated files, never hand-edited. --check compares without writing (the `deploy:check` gate). | CLI only |
| `deploy secrets <memory\|bot\|resident\|sandbox> [--only <string>]` | Put a Worker's secrets from the deployment profile's secretsSource (a directory of &lt;NAME&gt; files, or an op://Vault/Item): every name deploy/secrets.manifest.json lists for it, refused before any upload when a required value is absent. Values ride stdin into `wrangler secret put`; none is ever printed. | CLI only |
| `deploy config [--source <string>]` | Push the bot's config to the state Worker as the `base` document the bot reads at startup — from the profile's configSource (or --source), validated first. The running container keeps its config until `deploy restart`. | CLI only |
| `deploy images [--dry-run]` | Copy the release's bot, resident and sandbox images from where the release published them into this account's Cloudflare registry — once per version, skipping any already there — so `registry`-mode Workers deploy without a build and every container starts from Cloudflare's own cached registry. A registry-to-registry transfer over HTTPS: needs CLOUDFLARE_API_TOKEN with Containers Edit, nothing else. | CLI only |

### `env`

| Command | What it does | Surfaces |
|---|---|---|
| `env bootstrap --env <string> --service <string> [--apply] [--out <string>] [--manifest <string>]` | Populate the agent's execution environment with a downstream service's UAT env vars from 1Password (dry-run unless --apply). | CLI only |

### `setup`

| Command | What it does | Surfaces |
|---|---|---|
| `setup init [--organization <string>] [--anthropic-key <string>] [--openai-compatible <string>] [--model <string>] [--model-key <string>] [--slack-app-token <string>] [--slack-bot-token <string>] [--github-app-id <string>] [--github-installation-id <string>] [--github-private-key-file <string>] [--cloudflare <string>] [--zone <string>] [--name <string>] [--force] [--dry-run]` | The one-command installer: write .env (mode 600) and config/config.yaml from the checked-in examples with the values given — flags first, prompts only on a terminal — and, with --cloudflare and --zone, deploy/profile.json plus every Worker's wrangler.jsonc; then load the config and say what is on and what to run next. Refuses to overwrite without --force; --dry-run writes nothing and previews with secrets masked, existing files or not. | CLI only |

### `contract`

| Command | What it does | Surfaces |
|---|---|---|
| `contract render --plan <string> --unit <string> [--root <string>] [--branch <string>] [--onto <string>] [--max-chars <integer>]` | Render one plan unit's child contract — its section, the spec rows it names with their proof bindings, the repository's agent rules, the guards — as the `## Contract` block a coding prompt carries, and measure it. | CLI only |

### `delivery`

| Command | What it does | Surfaces |
|---|---|---|
| `delivery report [--repo <string>] [--since <string>] [--weeks <integer>]` | Delivery indicators per week and per unit — issue-to-merge time, first-pass CI, review rounds, findings and the share resolved with no human edit — read from GitHub and the run history; nothing written. | every surface |

<!-- /generated:cli-commands -->

## Which commands need bot config

A command that needs bot config loads `SWITCHBOARD_CONFIG` (default `./config/config.yaml`) on first use; the ones that don't (`deploy`, `env bootstrap`, `friction analyze`, `schedule list`, `help`) run from a bare worktree, a fresh clone, or CI with no config file present at all.

## Exit codes

| Code | Meaning |
|---|---|
| `0` | success |
| `1` | the command ran and failed (a real error — a stack trace is never shown) |
| `2` | the invocation itself was rejected — bad usage, or `invalid_input` from the grammar or the command's own validation |
| `75` | the command was `busy` (sysexits `EX_TEMPFAIL`): refused for a reason that clears on its own, with nothing for you to change; the same invocation later may simply succeed |

The same distinction (rejected-before-running vs. failed-while-running) applies identically over HTTP and MCP: it's one error vocabulary per fault, not per surface. See [explanation: one definition, every surface](../explanation/one-command-many-surfaces.md).

## A fresh process has no live runs

The CLI starts cold every invocation — `runs list` right after an `ask` sees that run because it was already written to persisted history, not because anything is held in memory between CLI invocations.
