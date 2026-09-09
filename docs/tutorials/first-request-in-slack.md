# Your first request in Slack

By the end of this lesson you have sent OpenSwitchboard a request, followed up without repeating yourself, and handed a real task to a specialist agent while watching it work. It is for someone in a Slack workspace where OpenSwitchboard is already installed; if you can see the bot in a channel, or open a direct message with it, you have everything you need. Ten minutes.

## 1. Say something

Mention the bot in a channel it is in, or message it directly (a direct message never needs the mention):

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
    Switchboard->>Slack: 👀 reaction — "got it"
    Switchboard->>Slack: status card: "thinking…"
    Note over Switchboard: reads, answers, no tools needed
    Switchboard->>Slack: reply in-thread
```

The 👀 reaction is your receipt that the request landed. If you never see it, the bot did not get the message; check that it is in the channel. The status card is one message edited in place as the agent works, so a long request never fills the channel with progress notes.

## 2. Follow up without the mention

Reply in the same thread:

```
what about a recursive CTE instead?
```

Once the bot has replied in a thread, or been mentioned anywhere in it, every reply in that thread reaches it. The thread also remembers which agent and model it was using, so a follow-up needs no directive.

## 3. Hand off something bigger

The default agent answers questions. Name a task and a repository and it hands off to a specialist:

```
@switchboard agent:coding in acme/api: add a retry to the webhook sender
```

`agent:coding` chooses the agent; `in acme/api` names the repository. This request ends in a pull request. While it works, the status card links to a **live run page**: open it and watch the agent's steps — files read, commands run, tests — as they happen, not only the final answer.

## 4. Check what it did

When the card closes, its first detail line is the run's shape: how the time split between getting ready, thinking, running tools and finishing up. The run page keeps the whole record ([Watch a run](../how-to/watch-a-run.md)).

## 5. Try a few more

Directives combine, and the operator commands use the same grammar as a message:

```
@switchboard agent:review model:anthropic/claude-opus-5 review https://github.com/acme/api/pull/123
@switchboard config show
@switchboard config set me --models.coding openai/gpt-5
@switchboard config instructions me "Always reply in bullet points"
```

## When you are stuck

```
@switchboard help
```

lists every agent, directive and command. A refused request says why and names who can grant what it needed.

## What you did

You sent a request, continued it in its thread, and handed a task to the coding agent while watching its run. The same three moves are the whole interface; everything else is a default you can set once.

## Next

- [Configure your defaults](../how-to/configure-your-defaults.md) — stop typing `agent:coding model:…` every time.
- [Slack commands](../reference/slack-commands.md) — every directive and command.
