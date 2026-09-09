# Configure your defaults

Set the agent, model and effort once, at the scope where the choice belongs, instead of repeating `agent:coding model:openai/gpt-5` on every message.

## Before you start

- OpenSwitchboard already answers you, in Slack or on the CLI ([Your first request in Slack](../tutorials/first-request-in-slack.md), [Run it locally](../tutorials/run-it-locally.md)).
- To change a channel's defaults you need the `config:write` grant. Admins hold it through `all`; nobody else does until granted ([Restrict who can do what](restrict-who-can-do-what.md)). Your own defaults need no grant.

The examples are chat messages. The same commands work word for word on the CLI (`npm run cli -- config set me --model openai/gpt-5`) and over HTTP and MCP ([One definition, every surface](../explanation/one-command-many-surfaces.md)).

## 1. See what is in force

```
@switchboard config show
```

The reply names the effective agent, model and effort for you in this channel, where each value came from, and what is restricted. Every value resolves through six layers, highest first: the message's directives, the thread's own history, your settings, the channel's settings, the installation's `config.yaml` defaults, the agent's built-in floor. Why it is shaped that way: [Why config is layered](../explanation/config-layers.md).

## 2. Set your own defaults

```
@switchboard config set me --model openai/gpt-5
@switchboard config set me --models.coding openai/gpt-5 --effort medium
```

`--model` sets one model for every agent; `--models.<agent>` overrides it for one agent. `--effort` takes `low`, `medium`, `high`, `xhigh` or `max` and decides how hard the model thinks per turn (lower is much faster); `--efforts.<agent>` is the per-agent form. `--agent` sets the agent that runs when a message names none.

## 3. Set a channel's defaults

```
@switchboard config set channel --agent review
@switchboard config set channel --efforts.coding medium
```

Every message in that channel now defaults to the `review` agent unless a directive or the sender's own setting says otherwise. From the CLI, or from another channel, add `--channel <id>`.

## 4. Add instructions in plain language

```
@switchboard config instructions me "Always reply in bullet points"
@switchboard config instructions channel "This channel is about billing questions"
```

Instructions are advisory text in the system prompt. They never change which agent or model runs and never touch a permission. Channel instructions apply to every run in the channel, yours to the runs you request; when both exist, yours win. Omit the text to see what is set; pass an empty value to clear it: `config instructions me ""`.

## 5. Override once, without changing anything

Directives in the message itself always win and persist nothing:

```
@switchboard agent:ship model:anthropic/claude-opus-5 effort:high in acme/api: fix issue #42
```

## 6. Undo

```
@switchboard config clear me            # drop your overrides; config.yaml shows through again
@switchboard config clear channel       # drop this channel's overrides (needs config:write)
```

## What you did

You set defaults at the scope that owns them and confirmed the result with `config show`. Nothing you set can bypass a restriction: `config set me --agent coding` always succeeds as a write, because the gate is applied when a run starts, against the agent that actually resolved.

## See also

- [Slack commands](../reference/slack-commands.md#config) — every `config` flag.
- [Why config is layered](../explanation/config-layers.md) — the resolution order and why effort is one of its dimensions.
