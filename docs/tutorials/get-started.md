---
description: Install Switchboard, get an answer in your terminal, then put it in a Slack channel. Ten minutes, one process, your keys on your machine.
---

# Get started

Switchboard is an open-source agent gateway. You mention it in Slack, or call it from a terminal, and an AI agent answers the question, reviews the pull request, or ships the fix — on the model you choose, with its tools running where you decide. You install it; you do not fork it.

In ten minutes it will be answering you in your terminal and in a Slack channel, from one process on your machine. Production comes after, as a how-to.

**You need:** Node 24 and an Anthropic API key. Part 2 adds a Slack workspace where you may create an app.

## What you are installing

| | |
|---|---|
| **One process** | The bot. It talks to your terminal, and to Slack over Socket Mode: no public URL, no Docker, no hosted service in between. |
| **Three agents** | `general` answers and reads links. `review` reviews a pull request. `coding` makes a change and opens the PR. Say `agent:review` or `agent:coding` in a message to pick one; the default is `general`. |
| **Your keys, at home** | Keys live in `~/.switchboard/.env`, readable only by you. Every later command finds them from any directory. |

## Part 1: an answer in your terminal

### 1. Install

```bash
npx @coreplane/switchboard init --organization <your-github-org> --anthropic-key <sk-ant-…>
```

```
wrote to /Users/you/.switchboard:
  .env                  (mode 600)
  config/config.yaml
providers: anthropic
capabilities: execution local · github off · memory off · run history off · …
next:
  npx @coreplane/switchboard ask "what can you do?"
  npx @coreplane/switchboard start
```

`--organization` is the GitHub organization the agents will work in once you connect GitHub; it is a name in `config/config.yaml`, editable later. Every optional capability starts off. `init --help` lists every flag.

### 2. Ask

```bash
npx @coreplane/switchboard ask "what can you do?"
```

Status lines appear (`preparing workspace…`, `preparing the prompt…`), then the answer. Now ask something that needs a tool:

```bash
npx @coreplane/switchboard ask "read https://github.com/coreplanelabs/switchboard and say what it does in two sentences"
```

The `general` agent fetched the page and answered. That was the whole pipeline — the same one Slack will use.

## Part 2: an answer in Slack

### 3. Create the Slack app

1. At [api.slack.com/apps](https://api.slack.com/apps): **Create New App → From a manifest** → paste [`slack-app-manifest.yaml`](https://openswitchboard.dev/slack-app-manifest.yaml).
2. **Basic Information → App-Level Tokens** → generate one with `connections:write`. It starts with `xapp-`.
3. **Install App → Install to Workspace**. The **Bot User OAuth Token** starts with `xoxb-`.

### 4. Add the tokens

```bash
npx @coreplane/switchboard init --force --organization <your-github-org> --anthropic-key <sk-ant-…> --slack-app-token <xapp-…> --slack-bot-token <xoxb-…>
```

`--force` rewrites the same two files with the tokens added. Nothing else changes.

### 5. Start the bot

```bash
npx @coreplane/switchboard start
```

```
switchboard running (providers: anthropic; default agent: general)
```

Leave it running. This is the same process production runs in a container.

### 6. Mention it

In Slack, `/invite @<your app>` into a channel, then:

```
@<your app> what can you do?
```

You should see a 👀 reaction (the receipt), a status card that updates in place, and the answer in a thread. Reply in the thread without the mention: it answers again, and the thread keeps its context. No 👀 means the bot is not in the channel.

## What you have

One process, answering on two channels, with your keys in a file only you can read. Nothing runs anywhere else yet.

## Next

- [Your first request in Slack](first-request-in-slack.md): follow-ups, `agent:` and `model:` directives, handing a task to the coding agent.
- [Set up accounts](../how-to/set-up-accounts.md): the GitHub App, so agents can read your repositories and open pull requests.
- [Deploy](../how-to/deploy.md): run it on Cloudflare so it no longer depends on your laptop.
- [Architecture](../explanation/architecture.md): what you just ran.
