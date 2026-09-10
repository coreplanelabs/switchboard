# Get started

By the end, OpenSwitchboard has answered you three times: in your terminal, in Slack, and from a production deployment on Cloudflare.

**You need:** Node 24 and an Anthropic API key. Part 2 adds a Slack workspace where you may create an app. Part 3 adds a Cloudflare account with a domain in it.

## Part 1: an answer in your terminal

### Install

```bash
mkdir switchboard && cd switchboard
npx @coreplane/switchboard init --organization <org> --anthropic-key <key>
```

You should see:

```
wrote:
  .env                  (mode 600)
  config/config.yaml
providers: anthropic
capabilities: execution local · github off · memory off · run history off · …
next:
  npx @coreplane/switchboard ask "what can you do?"
  npx @coreplane/switchboard start
  …
```

`.env` holds your key and only you can read it; `config/config.yaml` is the example config with every optional block off. `init --help` lists every flag.

### Ask

```bash
npx @coreplane/switchboard ask "what can you do?"
```

You should see status lines (`preparing workspace…`, `preparing the prompt…`), then the general agent's answer.

## Part 2: an answer in Slack

### Create the Slack app

1. At [api.slack.com/apps](https://api.slack.com/apps): *Create New App* → *From a manifest* → paste [`slack-app-manifest.yaml`](https://openswitchboard.dev/slack-app-manifest.yaml).
2. *Basic Information* → *App-Level Tokens* → generate one with `connections:write`. It starts with `xapp-`.
3. *Install App* → *Install to Workspace*. The *Bot User OAuth Token* starts with `xoxb-`.

### Add the tokens

```bash
npx @coreplane/switchboard init --force --organization <org> --anthropic-key <key> --slack-app-token <xapp-token> --slack-bot-token <xoxb-token>
```

### Start the bot

```bash
npx @coreplane/switchboard start
```

You should see `switchboard running (providers: anthropic; default agent: general)`. This is the process the production container runs, over Slack's Socket Mode: no port, no Docker. Leave it running.

### Say something

In Slack, `/invite @<your app>` into a channel, then:

```
@<your app> what can you do?
```

You should see a 👀 reaction, a status card, and the answer in a thread. Reply in the thread without a mention and it answers again.

## Part 3: an answer from production

Production is the bot as a container on Cloudflare plus a **state Worker** that keeps state across restarts.

**You need:** a Cloudflare account, a domain (a *zone*) in it, and an API token for that account in `CLOUDFLARE_API_TOKEN` with the scopes [Set up accounts](../how-to/set-up-accounts.md) lists. Stop the local bot first (Ctrl-C).

### Write the deployment profile

```bash
npx @coreplane/switchboard init --force --organization <org> --anthropic-key <key> --slack-app-token <xapp-token> --slack-bot-token <xoxb-token> --cloudflare <account id> --zone <zone>
```

You should see:

```
wrote:
  .env                  (mode 600)
  config/config.yaml
  deploy/profile.json
Worker configs from deploy/profile.json:
  written   .switchboard/deploy/cloudflare-memory/wrangler.jsonc
  written   .switchboard/deploy/cloudflare/wrangler.jsonc
  …
```

The profile names all four Workers under your zone; this lesson deploys the two required ones.

### Point the config at the state Worker

Add to `config/config.yaml` (which `--force` rewrote):

```yaml
runHistory:
  worker:
    baseUrl: https://switchboard-memory.<zone>
runtimeOverrides:
  worker:
    baseUrl: https://switchboard-memory.<zone>
```

### Stage the secrets

```bash
mkdir -p -m 700 ~/.secrets/switchboard
openssl rand -hex 32 > ~/.secrets/switchboard/MEMORY_TOKEN
```

Write `SLACK_BOT_TOKEN`, `SLACK_APP_TOKEN` and `ANTHROPIC_API_KEY` there too, one value per file. Then:

```bash
npx @coreplane/switchboard deploy secrets memory
npx @coreplane/switchboard deploy secrets bot
```

### Deploy

```bash
npx @coreplane/switchboard deploy plan --only memory,bot
MEMORY_TOKEN="$(cat ~/.secrets/switchboard/MEMORY_TOKEN)" npx @coreplane/switchboard deploy all --only memory,bot
```

You should see the plan's `Images: registry … 0 of 1 present; deploy all copies the rest`, then:

```
copied into the account registry: bot …
[deploy:all] bot: live (commit <sha>; 45s after the upload)
deployed and live
```

That copied the release's image into your account, deployed both Workers, and waited until `/healthz` answered from the new container.

### Say something, again

Mention the bot in Slack as before; the reply now comes from production.

```bash
curl -sS https://switchboard.<zone>/healthz
```

## Next

- [Your first request in Slack](first-request-in-slack.md): follow-ups, directives, handing off to the coding agent.
- [Deploy](../how-to/deploy.md): the optional Workers, the GitHub App, deploying from CI.
- [Architecture](../explanation/architecture.md): what you just ran.
