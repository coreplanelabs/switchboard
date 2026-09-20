# Configure your defaults

A plain message picks its own agent; the model and effort it runs on come from these layers. Set them once, at the scope that owns them, instead of on every message. Set an agent for a scope too, and every message there runs it, no picking.

**You need:**

- Switchboard answering you in Slack or on the CLI.
- For a channel's defaults, the `config:write` grant ([Restrict who can do what](restrict-who-can-do-what.md)); your own need none.

Examples are chat messages; the same commands work on the CLI (`npx @coreplane/switchboard config set me --model openai/gpt-5`), HTTP and MCP.

## See what is in force

```
@switchboard config show
```

The reply names the effective agent, model, effort and verbosity for you, where each came from, and what is restricted. Six layers, highest first: message directives, thread history, your settings, the channel's settings, `config.yaml` defaults, the agent's built-in floor.

## Set your own defaults

```
@switchboard config set me --model openai/gpt-5
@switchboard config set me --models.coding openai/gpt-5 --effort medium
```

| Flag | Sets |
|---|---|
| `--agent <name>` | the agent every plain message of yours runs, instead of one picked per message |
| `--model <provider/model>` | one model for every agent |
| `--models.<agent> <provider/model>` | the model for one agent |
| `--effort <low\|medium\|high\|xhigh\|max>` | how hard the model thinks per turn; lower is much faster |
| `--efforts.<agent> <level>` | the effort for one agent |
| `--verbosity <quiet\|verbose\|debug>` | how much the bot says about its own doing: `quiet` (the default) is only what needs you; `verbose` adds every acknowledgement of what it is doing for you; `debug` adds the router's reason and the ledger's word |
| `--harness.<agent> <pi\|opencode>` | which harness drives that agent's runs — under `me`, your own runs and nobody else's ([Put a preset on OpenCode](put-a-preset-on-opencode.md)) |

A `provider/model` value names a `providers` block from `config.yaml` and a model that provider knows; the first slash is the separator, the rest is passed through. OpenRouter is one such block with no code behind it — `wire: openai-chat`, `baseUrl: https://openrouter.ai/api/v1`, `apiKeyEnv: OPENROUTER_API_KEY` — and `config/config.example.yaml` ships it live: `switchboard init --openrouter-key <key>` keeps it in a fresh installation and writes the variable; without the flag the block is dropped, as `anthropic` and `openai` are without their keys. Its model ids already name the vendor, so the block declares `vendor: model` and `catalog: openrouter` (the pi registry file its cards are read from) and any preset's model may be `openrouter/<vendor>/<model>`: `config set me --models.coding openrouter/anthropic/claude-sonnet-4` here, or `defaults.models.general: openrouter/anthropic/claude-sonnet-4` in `config.yaml`. The key is read at the first model call, never at load, so a deployment without `OPENROUTER_API_KEY` runs every other preset as before and only a run whose model names the block fails, naming the variable. A run's turns go through the bot's model proxy on the OpenAI shape to the block's `/chat/completions` ([model-proxy.md](../reference/specs/model-proxy.md)), in the plain Chat Completions dialect pi speaks to any compatible endpoint: the card's effort word as `reasoning_effort` and the output cap under the card's cap field; a document input reaches the model as a text note saying the file was not sent. Everything else the run needs is the card's, decided before the first call and written into the harness's own configuration ([model-proxy.md](../reference/specs/model-proxy.md) item 11; [harness-pi.md](../reference/specs/harness-pi.md) item 4): the vendor is the model id's first part, so `anthropic/…` models get Anthropic's marker cache rule through this aggregator — carried onto the wire by the harness write (`compat.cacheControlFormat: "anthropic"` in pi's `models.json`), never by pi's own OpenRouter rule, which keys on a provider literally named `openrouter` while a run's provider is the proxy — an effort the OpenRouter registry file refuses is refused by name before any call, and a field no layer names goes out unvouched with a note on the run's record. The request router and memory reflection reach the same block through pi's model library ([harness-pi.md](../reference/specs/harness-pi.md) item 13), where pi sees OpenRouter by name and applies its OpenRouter rules — Anthropic-form cache markers on `anthropic/…` models included. What the OpenRouter path costs against the native one is the A/B the program plan owes on its tracker, not a promise made here.

## Set a channel's defaults

```
@switchboard config set channel --agent review
@switchboard config set channel --efforts.coding medium
```

Every message here now defaults to `review` unless a directive or the sender's own setting overrides it. From the CLI, or from another channel, add `--channel <id>`. A channel's boundary (`config set channel --boundary.maxIdentity read`, the same flags as your own) caps every run in it: [Restrict who can do what](restrict-who-can-do-what.md#cap-what-a-channels-runs-may-have).

## Cap what your own runs may have

```
@switchboard config set me --boundary.maxMinutes 20
@switchboard config set me --boundary.maxIdentity read --boundary.machines none,repo-cold
```

| Flag | Caps |
|---|---|
| `--boundary.maxMinutes <n>` | the wall-clock budget of every run, in minutes (at least 2); a preset asking for more is clipped, and the card says so |
| `--boundary.maxIdentity <none\|read\|write>` | the credential a run acts as; a preset above it (`ship` needs `write`) is refused by name before anything starts |
| `--boundary.machines <a,b>` | the machine classes a run may execute on (`none`, `blank`, `repo-cold`, `repo-resident`); a preset outside the list is refused |
| `--boundary.confirm <write\|destructive>` | not a run's cap but the front door's: the first blast-radius class a command the router bound from a plain sentence is handed back at (`To run this: …`) instead of run — `write` (the built-in: every write is handed back, a read or a repository's test runs) or `destructive` (a write runs at once; only a destructive one is handed back) |

A boundary caps and never grants: it cannot let you run an agent you are not granted. Boundaries are the one setting that does not override — yours intersects with the channel's and the installation's (the smallest budget, the lowest identity, the classes every one allows, the most cautious confirm class), so you can only tighten what they allow: under an installation `confirm: write`, your own `destructive` changes nothing. `config show` prints the effective boundary once one is in force, and the effective confirm with the scope that set it once any scope did.

## Add instructions in plain language

```
@switchboard config instructions me "Always reply in bullet points"
@switchboard config instructions channel "This channel is about billing questions"
```

Advisory system-prompt text; it never changes the agent, the model or a permission. Yours win over the channel's. Omit the text to show it; pass `""` to clear it.

## Override once

Directives in the message always win and persist nothing:

```
@switchboard agent:ship model:anthropic/claude-opus-5 effort:high in acme/api: fix issue #42
```

`budget:<minutes>` caps that one run's wall clock (whole minutes, at least 2) and only ever narrows: `agent:explore budget:30 …` runs thirty minutes instead of the agent's two hours, and the card says so; a `budget:` above the agent's own budget or a boundary's cap changes nothing, and the card says that too.

## Undo

```
@switchboard config clear me            # drop your overrides; config.yaml shows through again
@switchboard config clear channel       # drop this channel's overrides (needs config:write)
```

Nothing set here bypasses a restriction; the gate applies when a run starts.

## From the dashboard

Open **Settings → Channels** on the dashboard (`/settings/channels`): every channel that carries a scope, and one channel's scope as a form — agent, models, effort, the boundary and the instructions — over the same `config set channel`, `config instructions channel` and `config clear channel`. Your own defaults stay in chat (`config set me`), where your runs are requested as you. **Settings → Installation** shows the `config.yaml` values in force, the `defaults.*` a channel overrides among them.

## Next

- [Slack commands](../reference/slack-commands.md#config): every `config` flag.
- [Why config is layered](../explanation/config-layers.md): the resolution order.
