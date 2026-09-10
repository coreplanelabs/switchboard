# Configure your defaults

Set the agent, model and effort once, at the scope that owns them, instead of repeating directives on every message.

**You need:**

- OpenSwitchboard answering you in Slack or on the CLI.
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

Every message here now defaults to `review` unless a directive or the sender's own setting overrides it. From the CLI, or from another channel, add `--channel <id>`.

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
