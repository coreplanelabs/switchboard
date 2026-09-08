# Run it locally, no Slack required

Get Switchboard answering questions on your own machine, then run an agent against a real repo — all from one CLI command. Slack is one front door among several; this tutorial uses the one that needs no external setup.

**Needs:** Node 24 (`.nvmrc` pins it; 22+ runs), an Anthropic API key.

## Install and configure

```bash
git clone <this repo> && cd switchboard
npm ci
cp config/config.example.yaml config/config.yaml
cp .env.example .env
```

Open `.env` and set `ANTHROPIC_API_KEY`. Nothing else is required to start — every other block in `config.yaml` is commented out and off by default.

## Talk to it

```bash
npx tsx src/cli.ts ask "what tools do you have available right now?"
```

This runs the exact same pipeline a Slack message would: parse directives, resolve config, run the agent, print the answer. No websocket, no channel — `ask` is a channel adapter in its own right, just one that prints to your terminal instead of Slack.

Try a directive, the same syntax you'd type in Slack:

```bash
npx tsx src/cli.ts ask "agent:review model:anthropic/claude-opus-5 what would you look for in a PR that touches auth middleware?"
```

## See what just happened

```bash
npx tsx src/cli.ts runs list --status all
```

Every `ask` is a real run — the same registry that backs the Slack status card and the `/runs` dashboard. Grab an id from the list and:

```bash
npx tsx src/cli.ts runs get <id>
npx tsx src/cli.ts runs events <id>
```

## Run the same checks CI does

```bash
npm run verify
```

That is the whole gate, and CI runs nothing else. For a faster loop while you
work, run only what your change reaches: `npx vitest run --changed origin/main`
from the root covers the bot and the dashboard at once (see
[CONTRIBUTING](../../CONTRIBUTING.md#running-tests)).

## Connect it to Slack

The same process, one more channel. Nothing above changes; the Slack adapter opens an outbound websocket, so there is no public URL to host.

1. Create a Slack app (api.slack.com/apps → From scratch) and turn on **Socket Mode**. Create an app-level token with the `connections:write` scope — that is `SLACK_APP_TOKEN`.
2. Under **OAuth & Permissions**, give the bot token these scopes: `app_mentions:read`, `chat:write`, `channels:history`, `groups:history`, `channels:read`, `groups:read`, `users:read`, `files:read`, `files:write`, `reactions:write`. Each one buys something specific: `files:read` lets image attachments reach the model, `files:write` lets long command output arrive as a file instead of a wall of chunks, `reactions:write` is the 👀 receipt the moment a request is accepted, `channels:read` and `groups:read` let the reconnect catch-up list the channels it should re-read, and `users:read` names people and channels on run labels. Add `im:history`, `im:read` and `im:write` too if you want people to DM the bot.
3. Under **Event Subscriptions**, subscribe the bot to `app_mention`, `message.channels` and `message.groups` — the channel message events are what deliver thread follow-ups without a re-mention — and `message.im` for DMs.
4. Install the app to your workspace; the bot token it shows is `SLACK_BOT_TOKEN`.
5. Put both tokens in `.env` and start the bot from source:

```bash
npm run dev
```

The log ends with the providers it connected and where `/docs` points. On first connect the bot compares the token's scopes with the list above and logs any that are missing; the same report is under `catchUp` on `GET /healthz` when `PORT` is set. Then mention it in a channel it has been invited to — [Your first request in Slack](first-request-in-slack.md) takes it from there.

The catch-up is worth knowing about: Socket Mode drops every event that arrives while the bot is disconnected, and each restart is a disconnect. On every reconnect the bot re-reads the recent history of the channels it is in and runs whatever has no receipt from it — no 👀, no reply after it. It is on by default with a 30-minute window; `slack.catchUp` in the config tunes it ([decision record 0012](../decisions/0012-reconnect-catch-up-as-recovery.md)).

## Give it a GitHub identity

The coding and review agents, and the GitHub tools every agent carries, need a credential. The idiomatic one is a **GitHub App** on your organization (Settings → Developer settings → GitHub Apps → New GitHub App): permissions Contents (read and write), Pull requests (read and write) and Issues (read and write — agents read issues for task context and comment on them); webhook off; generate a private key; install it on the repositories the bot may touch. Set `GITHUB_APP_ID`, `GITHUB_APP_INSTALLATION_ID` and `GITHUB_APP_PRIVATE_KEY` in `.env`. The bot mints one-hour installation tokens on demand and hands them to wherever tools execute; pull requests are authored as the App. The fallback is a fine-grained personal access token scoped to only those repositories, as `GH_TOKEN`.

With `execution.type: local` (the default) tools run on your machine, so the credential is reachable from anything the coding agent runs. That is fine on a laptop you trust with every message that reaches the bot, and not fine for anyone else — read [Execution and trust](../explanation/execution-and-trust.md) before pointing it at a shared workspace.

## Next

- **Understand what just ran:** [how a request flows](../explanation/how-a-request-flows.md).
- **Extend it:** [add a provider or agent](../how-to/add-a-provider-or-agent.md).
