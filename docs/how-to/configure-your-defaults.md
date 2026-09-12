# Configure your defaults

Set the agent, model and effort once, at the scope that owns them, instead of repeating directives on every message.

**You need:**

- Switchboard answering you in Slack or on the CLI.
- For a channel's defaults, the `config:write` grant ([Restrict who can do what](restrict-who-can-do-what.md)); your own need none.

Examples are chat messages; the same commands work on the CLI (`npx @coreplane/switchboard config set me --model openai/gpt-5`), HTTP and MCP.

## See what is in force

```
@switchboard config show
```

The reply names the effective agent, model and effort for you, where each came from, and what is restricted. Six layers, highest first: message directives, thread history, your settings, the channel's settings, `config.yaml` defaults, the agent's built-in floor.

## Set your own defaults

```
@switchboard config set me --model openai/gpt-5
@switchboard config set me --models.coding openai/gpt-5 --effort medium
```

| Flag | Sets |
|---|---|
| `--agent <name>` | the agent that runs when a message names none |
| `--model <provider/model>` | one model for every agent |
| `--models.<agent> <provider/model>` | the model for one agent |
| `--effort <low\|medium\|high\|xhigh\|max>` | how hard the model thinks per turn; lower is much faster |
| `--efforts.<agent> <level>` | the effort for one agent |

A `provider/model` value names a `providers` block from `config.yaml` and a model that provider knows; the first slash is the separator, the rest is passed through. OpenRouter is one such block with no code behind it: `type: openai-compatible`, `baseUrl: https://openrouter.ai/api/v1`, `apiKeyEnv: OPENROUTER_API_KEY` (`config/config.example.yaml` carries it commented out), and because its own ids already name the vendor a model there is `openrouter/anthropic/claude-sonnet-4`. Three things the native adapter does are not done through the compatible one: `--effort` is not sent, so the model runs at its own default; document inputs reach the model as a text note saying the file was not sent; and no provider-side prompt caching is requested, so every turn pays for the whole context.

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
| `--boundary.maxIdentity <none\|read\|write>` | the credential a run acts as; a preset above it (`coding` needs `write`) is refused by name before anything starts |
| `--boundary.machines <a,b>` | the machine classes a run may execute on (`none`, `blank`, `repo-cold`, `repo-resident`); a preset outside the list is refused |

A boundary caps and never grants: it cannot let you run an agent you are not granted. Boundaries are the one setting that does not override — yours intersects with the channel's and the installation's (the smallest budget, the lowest identity, the classes every one allows), so you can only tighten what they allow. `config show` prints the effective boundary once one is in force.

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

## Undo

```
@switchboard config clear me            # drop your overrides; config.yaml shows through again
@switchboard config clear channel       # drop this channel's overrides (needs config:write)
```

Nothing set here bypasses a restriction; the gate applies when a run starts.

## Next

- [Slack commands](../reference/slack-commands.md#config): every `config` flag.
- [Why config is layered](../explanation/config-layers.md): the resolution order.
