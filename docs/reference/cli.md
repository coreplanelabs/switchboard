# Reference: CLI

`npx tsx src/cli.ts` (or `npm run cli --`) is the operator toolbox — every registered command, plus one built-in for talking to the agent pipeline directly.

## Form

```
npx tsx src/cli.ts <group> <verb> [args…] [--kebab-option value…] [--json]
```

- Flags are kebab-case on the CLI (`--min-runs 2`), camelCase in the underlying schema, and dotted for nested options (`--models.coding openai/gpt-5`) — the same grammar chat and HTTP use, just a different flag style.
- `--json` prints the exact result the command produced, with no rendering — useful for scripting or for confirming what a chat/HTTP call would have gotten back.
- `<group> help` and the bare `help` are derived automatically from the registry; there is no separate help text to maintain.

## The one built-in: `ask`

```
npx tsx src/cli.ts ask [--thread <key>] "<request>"
```

Not a registered command — a **channel**, exactly like Slack, just printing to your terminal instead. Directives (`agent:`, `model:`, `effort:`) work identically. Use `--thread` to simulate a follow-up in an existing thread (stickiness applies).

## Every command group

| Group | Verbs | Needs bot config? |
|---|---|---|
| `help` | `show` | no |
| `config` | `show`, `set`, `clear`, `instructions` | yes |
| `runs` | `list`, `get`, `events`, `friction`, `stop` | yes |
| `friction` | `report`, `propose`, `analyze` (analyze is CLI-only) | yes |
| `repo` | `list`, `onboard`, `offboard`, `reconfigure`, `rebuild`, `test`, `build` | yes |
| `memory` | `list`, `forget` | yes |
| `schedule` | `list` | yes |
| `deploy` | `plan`, `all` (both CLI-only) | no |
| `env` | `bootstrap` (CLI-only) | no |

"Needs bot config" means the command loads `SWITCHBOARD_CONFIG` (default `./config/config.yaml`) on first use; a command that doesn't need it (`deploy`, `env bootstrap`, `friction analyze`, `schedule list`, `help`) runs from a bare worktree, a fresh clone, or CI with no config file present at all.

## Exit codes

| Code | Meaning |
|---|---|
| `0` | success |
| `1` | the command ran and failed (a real error — a stack trace is never shown) |
| `2` | the invocation itself was rejected — bad usage, or `invalid_input` from the grammar or the command's own validation |

The same distinction (rejected-before-running vs. failed-while-running) applies identically over HTTP and MCP: it's one error vocabulary per fault, not per surface. See [explanation: one definition, every surface](../explanation/one-command-many-surfaces.md).

## A fresh process has no live runs

The CLI starts cold every invocation — `runs list` right after an `ask` sees that run because it was already written to persisted history, not because anything is held in memory between CLI invocations.
