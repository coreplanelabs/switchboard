# Your first request in Slack

You'll send a message to Switchboard, watch it work, and follow up without repeating yourself. Ten minutes, no setup — if you can see the bot in a channel or DM it, you're ready.

## Say something

Mention the bot anywhere it's present, or DM it directly (DMs never need a mention):

```
@switchboard what's the syntax for a postgres lateral join?
```

Three things happen, in order:

```mermaid
sequenceDiagram
    participant You
    participant Slack
    participant Switchboard

    You->>Slack: @switchboard what's a lateral join?
    Slack->>Switchboard: message event
    Switchboard->>Slack: :eyes: reaction — "got it"
    Switchboard->>Slack: status card: "thinking…"
    Note over Switchboard: reads, answers, no tools needed
    Switchboard->>Slack: reply in-thread
```

The :eyes: reaction is your receipt that the request landed — if you never see it, the bot didn't get the message (check it's actually in the channel). The status card is a single message that gets edited in place as the agent works, so a long-running request doesn't spam the channel with progress notes.

## Follow up without re-mentioning

Reply in the same thread — no `@switchboard` needed:

```
what about a recursive CTE instead?
```

Once the bot has replied in a thread (or been mentioned anywhere in it), every reply in that thread reaches it. This also means the thread remembers what agent/model you were using — see [configure your defaults](../how-to/configure-your-defaults.md).

## Ask for something bigger

The default agent just answers. Point it at a real task and it hands off to a specialist:

```
@switchboard agent:coding in acme/api: add a retry to the webhook sender
```

This one opens a pull request. While it works, the status card links to a **live run page** — click it to watch the agent's steps (files read, commands run, tests) as they happen, not just the final answer. See [watch a run and check spend](../how-to/watch-a-run-and-check-spend.md).

## When you're stuck

```
@switchboard help
```

lists every command. If a request gets refused, the reply names who to ask — permissions are per-agent and per-repo, and denials always say why.

## Next

- [Configure your defaults](../how-to/configure-your-defaults.md) — stop typing `agent:coding model:...` every time.
- [Reference: Slack commands](../reference/slack-commands.md) — the full command grammar.
