# Your first request in Slack

By the end, you have asked Switchboard a question, followed up without repeating yourself, and handed it a real task in plain words.

**You need:** a Slack workspace where the bot is installed and a channel it is in (or a direct message with it). Ten minutes.

## Say something

```
@switchboard what's the syntax for a postgres lateral join?
```

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

You should see a 👀 reaction (the receipt), one status card edited in place, then the answer in a thread. The card's first line names the agent it picked and why. No 👀 means the bot is not in the channel.

## Follow up without the mention

Reply in the same thread:

```
what about a recursive CTE instead?
```

Every reply in a thread the bot has answered in reaches it, and the thread keeps its agent and model.

## Hand off something bigger

```
@switchboard in acme/api, add a retry to the webhook sender and open a PR
```

You named no agent. The bot read the sentence and routed it to `ship`, and the card's first line says so: `ship · routed: <its reason>`. `in acme/api` names the repository. The card links to a live run page; open it to watch files read, commands run and tests as they happen. The run ends in a pull request.

## Check what it did

When the card closes, its first line is the run's shape: time getting ready, thinking, in tools, finishing up. The run page keeps the whole record.

## Try a few more

```
@switchboard can you take a look at https://github.com/acme/api/pull/123 and tell me if anything in it worries you?
@switchboard what is the latest version of undici on npm, and what changed in it?
@switchboard two things: check https://github.com/acme/api/pull/123 for anything wrong in its wording, and find out whether Node 24 changed the default fetch timeout
```

The first runs as `review`, the second as `research`, the third as a `conductor` with one child per part; each card says which and why. A refused request says why and who can grant it.

## When you want to choose

Say `agent:coding` in the message and that agent runs, no picking; reply `agent:<name>` in a thread to run it another way; a routed `ship` runs your change through coding and review, and a person merges the pull request. Commands exist too, for whoever wants them: [Slack commands](../reference/slack-commands.md). To turn the picking off for a deployment, set `routing: { auto: false }` ([Turn features on and off](../how-to/turn-features-on-and-off.md)); every plain message then runs `general`.

## Next

- [Configure your defaults](../how-to/configure-your-defaults.md): pick the model and effort once, at the scope that owns them.
- [Watch a run](../how-to/watch-a-run.md): the run page, stopping a run, reading history.
- [Slack commands](../reference/slack-commands.md): every directive and command.
