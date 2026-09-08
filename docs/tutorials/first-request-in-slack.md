# Your first request in Slack

By the end, you have sent OpenSwitchboard a request, followed up without repeating yourself, and handed a real task to a specialist agent.

**You need:** a Slack workspace where the bot is installed and a channel it is in (or a direct message with it). Ten minutes.

## Say something

```
@switchboard what's the syntax for a postgres lateral join?
```

```mermaid
sequenceDiagram
    participant You
    participant Slack
    participant OpenSwitchboard

    You->>Slack: @switchboard what's a lateral join?
    Slack->>OpenSwitchboard: message event
    OpenSwitchboard->>Slack: 👀 reaction — "got it"
    OpenSwitchboard->>Slack: status card: "thinking…"
    Note over OpenSwitchboard: reads, answers, no tools needed
    OpenSwitchboard->>Slack: reply in-thread
```

You should see a 👀 reaction (the receipt), one status card edited in place, then the answer in a thread. No 👀 means the bot is not in the channel.

## Follow up without the mention

Reply in the same thread:

```
what about a recursive CTE instead?
```

Every reply in a thread the bot has answered in reaches it, and the thread keeps its agent and model.

## Hand off something bigger

```
@switchboard agent:coding in acme/api: add a retry to the webhook sender
```

`agent:coding` picks the agent; `in acme/api` names the repository. The status card links to a live run page; open it to watch files read, commands run and tests as they happen. The run ends in a pull request.

## Check what it did

When the card closes, its first line is the run's shape: time getting ready, thinking, in tools, finishing up. The run page keeps the whole record.

## Try a few more

```
@switchboard agent:review model:anthropic/claude-opus-5 review https://github.com/acme/api/pull/123
@switchboard config show
@switchboard config set me --models.coding openai/gpt-5
@switchboard config instructions me "Always reply in bullet points"
@switchboard help
```

`help` lists every agent, directive and command. A refused request says why and who can grant it.

## Next

- [Configure your defaults](../how-to/configure-your-defaults.md): stop typing `agent:coding model:…` every time.
- [Watch a run](../how-to/watch-a-run.md): the run page, stopping a run, reading history.
- [Slack commands](../reference/slack-commands.md): every directive and command.
