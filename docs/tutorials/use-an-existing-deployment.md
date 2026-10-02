---
description: Send your first request through a Switchboard your team already runs. No installation or API key needed.
---

# Use an existing deployment

By the end, you have sent a request to your team's Switchboard and followed up in the same conversation. Someone else already runs the service and manages its model keys, tools, and access rules.

This walkthrough uses Slack. Other installations may expose [browser chat](../reference/dashboard-routes.md) or another channel.

**You need:** the Slack workspace and app name your team uses, plus a channel where the app is present or a direct message with it. Ask the person who runs your deployment for these if you do not have them. You do not need to install the CLI or start a server.

## Send a request

In a channel with the app, mention it:

```text
@<your Switchboard app> what can you help me with?
```

In a direct message with the app, send the question without a mention. You should see a 👀 reaction, a status card, and then an answer. The card names the agent chosen for your request.

## Follow up

Reply in the same thread without another mention:

```text
Can you give me a concrete example?
```

The reply stays in that conversation. For a longer task, describe the outcome you want in plain words. For example, if your deployment has access to the repository and you have permission to use its review agent:

```text
@<your Switchboard app> review https://github.com/<org>/<repo>/pull/<number>
```

The status card links to the run page, where you can watch the work. Your deployment may require a separate dashboard sign-in. [Your first request in Slack](first-request-in-slack.md) walks through more kinds of requests and follow-ups.

## If you cannot get started

- No receipt in a channel: check that the app is in that channel. Ask your deployment operator which app and channel to use.
- A refusal: read the missing permission named in the reply, then ask the operator who manages access.
- A run page you cannot open: ask the operator how to sign in to the dashboard. The answer still appears in Slack.

If you are the person setting up Switchboard for a team, follow [Get started](get-started.md) to run your own deployment.
