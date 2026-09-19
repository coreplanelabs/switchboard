# Reference: Slack commands

Everything below works identically as a bare mention, a DM, or a thread follow-up. The same grammar also works, unmodified, on the CLI and as chat text over HTTP/MCP ingress — see [reference: CLI](cli.md).

## Talking to it

| Do this | To |
|---|---|
| `@switchboard <anything>` | start or continue a conversation (first message in a channel needs the mention; DMs and thread follow-ups never do) |
| `@switchboard help` | how to ask, in plain words: describe what you want, force an agent with `agent:<preset>`, change a route by replying `agent:<preset>` — it lists no commands |
| `@switchboard help commands` | list every command, by group, with the grammar and the per-request directives |
| `<group> help` | usage for one command group, e.g. `config help` |

## Directives (inline, per-request only)

Placed right after the mention, before the request text:

| Directive | Example | Effect |
|---|---|---|
| `agent:<name>` | `agent:review` | force this agent for this message; without it a plain message picks its own agent and the card says why — the router, on by default; `routing: { auto: false }` turns it off ([Turn features on and off](../how-to/turn-features-on-and-off.md)) and a plain message then runs the default. `coding` is never picked for you: name it — a routed change request runs `ship`, the coding → review loop a person merges |
| `model:<provider>/<model>` | `model:openai/gpt-5` | use this model for this message only |
| `effort:<low\|medium\|high\|xhigh\|max>` | `effort:low` | how hard the model thinks this turn |
| `budget:<minutes>` | `budget:30` | cap this run's wall clock, in whole minutes (at least 2); it only ever narrows the agent's own budget or a boundary's, and the card says what it did |
| `verbosity:<quiet\|verbose\|debug>` | `verbosity:verbose` | how much the bot says about its own doing: `quiet` (the default) is only what needs you — answers, verdicts, refusals, questions; `verbose` adds what it is doing for you (a follow-up folded in, a plan handed to the runner, the workspace on the card); `debug` adds the router's reason. Sticky in the thread; `config set me --verbosity <level>` sets it for good |

Combine freely: `agent:ship model:anthropic/claude-opus-5 effort:high in acme/api: fix #42`.

`model:`, `effort:` and `verbosity:` are sticky in a thread — a follow-up without them keeps the last ones used. The agent is sticky by transcript: a follow-up continues the agent whose conversation the thread holds — the thread's newest finished run's — and picks up where it left off ([session-log.md](specs/session-log.md) item 9); an `agent:` in an earlier message decides nothing by itself. `budget:` is not sticky: it bounds the one run it rides on; a lower budget on every turn is a boundary (`config set me --boundary.maxMinutes <n>`).

## Every command you can run in chat

`help` in chat prints none of this — it is the plain-language guide; `help commands` prints this list. One table per group. "Who can run it" is what the authorization policy decides for a Slack user holding each grant set (the narrowest admitted is named: anyone, `agent:run:coding`, `repo:write`, `config:write`, admins) — see [reference: authorization](authorization.md). A registered command that is deliberately not exposed to chat (`deploy all`, `deploy restart`, `env bootstrap`, `friction analyze`, and the paged `runs get|events|friction` reads) is absent from this table and reachable on the [CLI](cli.md), over HTTP, or as an MCP tool instead.

<!-- generated:chat-commands · npm run docs:gen — generated from the code, do not edit by hand -->

### `help`

| Command | What it does | Who can run it |
|---|---|---|
| `help show` | How to talk to this bot — the agents, forcing one, changing a route in the thread — for a person asking about the bot itself, never for a task or a thing to show. | anyone |
| `help commands` | Every chat command by group, the grammar, and the per-request directives. | anyone |

### `status`

| Command | What it does | Who can run it |
|---|---|---|
| `status show` | Which build this process runs: version, commit, when it was built and started, runs in flight, draining. | anyone |

### `config`

| Command | What it does | Who can run it |
|---|---|---|
| `config show [--channel <string>]` | The effective agent/model/effort for you in this channel, the defaults, both scopes, and what is restricted; without a channel (a browser, a token, the CLI), your settings outside any channel. | anyone |
| `config overrides` | Which channels carry a scope (a config.yaml block or a runtime override) and which settings each one names — never a value; `config show --channel <id>` reads one. | anyone |
| `config channels` | The channels you may pick settings or MCP servers for, by name: the channels the bot is in that you may read, plus any that already carry a scope; `listed: false` says the bot could not list its channels and only the scoped ones are here. | anyone |
| `config set <channel\|me\|thread> [--agent <string>] [--model <string>] [--models <object>] [--effort <low\|medium\|high\|xhigh\|max>] [--efforts <object>] [--verbosity <quiet\|verbose\|debug>] [--harness <object>] [--boundary <object>] [--review <object>] [--intake <object>] [--channel <string>] [--thread <string>]` | Set the agent, model, effort, verbosity, harness or boundary for a channel (gated) or for yourself, or the intake gate's mode for a thread (gated like the channel); per-agent forms take --models.&lt;agent&gt; / --efforts.&lt;agent&gt; / --harness.&lt;agent&gt;, the boundary's axes --boundary.&lt;axis&gt; (a boundary caps every run in the scope and never grants). | anyone |
| `config clear <channel\|me\|thread> [--channel <string>] [--thread <string>]` | Drop every runtime override of a channel (gated), of yourself, or of a thread (gated like the channel); static config.yaml values show through again. | anyone |
| `config instructions <channel\|me> [text…] [--channel <string>]` | Custom instructions for a channel (gated) or for yourself — advisory prompt content that never changes agent, model, or permissions. | anyone |

### `runs`

| Command | What it does | Who can run it |
|---|---|---|
| `runs list [--status <active\|finished\|all>] [--agent <string>] [--channel <string>] [--thread <string>] [--parent <string>] [--since-ms <integer>] [--limit <integer>] [--before <integer>] [--before-id <string>] [--mine]` | List runs (live and persisted, newest first) — metadata only, never message text. | admins |
| `runs stop <id> --mode <soft\|hard>` | Request a live run to stop (`--mode soft` = finish the current step; `hard` = abort now). A hosted pipeline's parent refuses soft — `--mode hard` seals it failed and releases its thread. Records the caller as the actor. | admins |
| `runs unit <unit>` | A ship unit's runs in round order — its coding thread's and its review thread's, live and finished, each with its round and thread — from one read. | admins |
| `runs children <id>` | The runs one run spawned — a conductor's children, live and finished — oldest started first. | admins |
| `runs findings <pr>` | A pull request's findings ledger — every review finding by id with its severity, where it was raised, what the coding run recorded against it and whether the next review agreed — read from the run records alone. | admins |

### `review`

| Command | What it does | Who can run it |
|---|---|---|
| `review abridge <id> [--model <string>] [--force] [--wait]` | Abridge a finished PR review's reading diff with meat.dev on the bot host (one Opus-class call) and store it on the run; idempotent — a stored one is answered, not recomputed. | admins |

### `friction`

| Command | What it does | Who can run it |
|---|---|---|
| `friction report [--since-ms <integer>] [--limit <integer>] [--min-runs <integer>]` | Ranked recurring friction patterns across recent runs — read-only, GitHub never consulted. | anyone |
| `friction propose [--dry-run] [--top <integer>] [--min-runs <integer>] [--repo <string>]` | Run the self-improvement step: cluster recent friction, dedupe against open issues, file the top proposals as labeled issues. | repo managers (`repo:write`) |

### `repo`

| Command | What it does | Who can run it |
|---|---|---|
| `repo list` | Every onboarded resident repo with its live state, ref, sha, last refresh, and disk gauge. | anyone |
| `repo onboard <slug> [--ref <string>] [--test <string>] [--build <string>] [--install <string>] [--evict-coldest]` | Onboard a repo as an always-warm resident environment (provisions billable compute; admin-gated). | repo managers (`repo:write`) |
| `repo offboard <slug> [--dry-run]` | Tear down a resident repo: registry record, schedules, container, R2 snapshots (admin-gated; --dry-run plans only). | repo managers (`repo:write`) |
| `repo reconfigure <slug> [--ref <string>] [--test <string>] [--build <string>] [--install <string>]` | Change a resident's default branch and/or command table (admin-gated; takes effect on the next refresh/attach). | repo managers (`repo:write`) |
| `repo rebuild <slug> [--dry-run]` | Discard a resident's snapshot and reprovision it from scratch (admin-gated; --dry-run plans only). | repo managers (`repo:write`) |
| `repo test <slug> [ref]` | Run the repo's onboarded test command with zero model turns (needs coding-agent access; the ref must be a plausible branch). | anyone granted `agent:run:coding` |
| `repo build <slug> [ref]` | Run the repo's onboarded build command with zero model turns (needs coding-agent access; the ref must be a plausible branch). | anyone granted `agent:run:coding` |

### `memory`

| Command | What it does | Who can run it |
|---|---|---|
| `memory list [query…] [--scope <me\|org\|repo\|channel\|all>] [--limit <integer>] [--repo <string>]` | Your own memory records and the shared org / repo / channel records, with ids — what influences your runs. | anyone |
| `memory forget <id>` | Soft-delete one memory record so it no longer influences any run (yours freely; shared org/repo/channel records need repo-management rights). | anyone |
| `memory sweep --scope <me\|org\|repo\|channel\|all> [--repo <string>] [--dry-run]` | Retire the stored status records the write gate rejects today (soft delete, per scope; yours freely, shared org/repo/channel scopes need repo-management rights); `--dry-run` lists the marked ids and changes nothing. | anyone |

### `mcp`

| Command | What it does | Who can run it |
|---|---|---|
| `mcp list [--channel <string>] [--all]` | External MCP servers your runs in this channel can use — org-wide, this channel's, and your own — with state and agents; never a credential. `--all` (admins): every tier. | anyone |
| `mcp add <name> --url <string> [--scope <me\|channel\|org>] [--agents <string>] [--auth <oauth\|bearer\|none>] [--channel <string>]` | Register an external MCP server for yourself, this channel, or the org — auth is detected from the server; sign-in or a token happens on a one-time link, never in chat. | anyone |
| `mcp connect <name> [--scope <me\|channel\|org>] [--channel <string>]` | A fresh one-time link to sign in to an OAuth server or enter (or replace) a bearer server's token — only you can complete it; it expires in 10 minutes. | anyone |
| `mcp show <name> [--scope <me\|channel\|org>] [--channel <string>]` | One MCP server's entry plus a live probe of the tools it offers (names, read-only flags); never a credential. | anyone |
| `mcp remove <name> [--scope <me\|channel\|org>] [--channel <string>]` | Remove an MCP server you added and its stored credential (yours freely; channel ones need channel-config rights, org-wide ones admin rights). | anyone |
| `mcp promote <name> --from <string> [--agents <string>]` | Re-issue a person's MCP server in the org tier (admins): the same name, URL and auth, added by you; a bearer/oauth server gets a fresh org connect link for you to complete — the person's credential is never copied. | repo managers (`repo:write`) |

### `schedule`

| Command | What it does | Who can run it |
|---|---|---|
| `schedule list` | Every scheduled job (cron, UTC), which Worker fires it, its next firing, and what its last firing did. | anyone |

### `deploy`

| Command | What it does | Who can run it |
|---|---|---|
| `deploy plan [--only <string>] [--skip <string>] [--affected] [--base <string>] [--force] [--allow-branch] [--wait-max <integer>] [--poll <integer>]` | The production deploy plan: checks, Worker order, preflight handling — computed, nothing executed. With --affected, also which Workers this tree actually needs deployed and why. | admins |

### `delivery`

| Command | What it does | Who can run it |
|---|---|---|
| `delivery report [--repo <string>] [--since <string>] [--weeks <integer>] [--fresh]` | Delivery indicators per week and per unit — issue-to-merge time, first-pass CI, review rounds, findings and the share resolved with no human edit — from the repository's snapshot of GitHub's facts (--fresh reads GitHub now) and the run history; nothing written. | admins |

### `costs`

| Command | What it does | Who can run it |
|---|---|---|
| `costs by <user\|thread\|channel\|agent\|model> [--days <integer>] [--group <string>]` | What the runs cost by user, thread, channel, agent or model over the range — LLM from their tokens through the price table, cloud allocated by run wall-clock — the costs page's tabs as text or JSON, from the snapshot; nothing written. | admins |
| `costs snapshot` | Take the costs snapshot now: read both billing sources and the run history once over the page's widest range, store the result, and serve it to every reader of the costs page from then on. | admins |

### `providers`

| Command | What it does | Who can run it |
|---|---|---|
| `providers check` | Read the provider's own endpoints for each aggregator model the configuration names and report where the resolved model card disagrees — supported parameters, context length, modalities — with the override that would pin each. | admins |

### `plane`

| Command | What it does | Who can run it |
|---|---|---|
| `plane show` | What is happening: every live and recently ended run, every tracked pull request and every ship unit, each with its owner and its health — the plane's table, as text or JSON; nothing written. | admins |

<!-- /generated:chat-commands -->

## Where each group is explained

| Group | The narrative version |
|---|---|
| `config` | [how-to: configure your defaults](../how-to/configure-your-defaults.md), [explanation: config layers](../explanation/config-layers.md) |
| `mcp` | [how-to: connect an MCP server](../how-to/connect-an-mcp-server.md) |
| `repo` | [how-to: onboard a repo](../how-to/onboard-a-repo.md) |
| `runs` | [how-to: watch a run](../how-to/watch-a-run.md) |
| `friction` | [explanation: how Switchboard improves itself](../explanation/how-switchboard-improves-itself.md) |

## Repo commands run no model turns

`repo test` and `repo build` run the repo's onboarded command and report pass/fail with zero model calls — an operation, not an agent run. A plain sentence that means one ("run the tests on main in acme/api", or "run the tests on main" in a thread that already named the repository) routes to the same command: one fast model call binds it, the reply leads with a receipt line (`routed: repo test acme/api main`), and the operation runs at once. If the repository has no resident, the reply is that receipt, the command's own not-onboarded line and the `wrong preset? reply agent:<preset> to run it another way` footer — nothing runs.
