# Get started

By the end of this lesson Switchboard has answered you three times: from a terminal on your own machine, from a Slack channel, and from a production deployment on Cloudflare. Each part builds on the one before it, and nothing is undone along the way — the checkout you make in the first part is the one you deploy in the last.

**You need:** Node 24 (`.nvmrc` pins it; 22 or newer runs), a terminal, and an Anthropic API key. The second part adds a Slack workspace where you may create an app; the third adds a Cloudflare account with a domain in it and Docker running locally.

## Part 1 — an answer in your terminal

Clone the repository and install every package at once; the root lockfile covers the bot, the dashboard, the docs site and the Workers.

```bash
git clone https://github.com/coreplanelabs/switchboard.git
cd switchboard
npm ci
```

Make the two local files that the tree deliberately does not carry. Both are ignored by git; the first is every knob of the bot with everything optional left off, the second is where credentials live.

```bash
cp config/config.example.yaml config/config.yaml
cp .env.example .env
```

Open `.env` and replace the placeholder on the `ANTHROPIC_API_KEY` line with your key. Leave the rest alone — nothing reads a line until you turn its feature on.

Now ask. The CLI is a channel like Slack is: the same dispatcher, the same agents, printing to your terminal instead of a thread.

```bash
npx tsx src/cli.ts ask "what can you do?"
```

Switchboard reads credentials from the environment and from nowhere else; the process loads `.env` from the directory you run it in — the repo root here — and a variable your shell already exports wins over the file.

You will see a status line tick (`preparing workspace…`, then `thinking…`), and then the answer: the general agent introduces itself and the agents it can hand work to. That took one model call on the default model, `anthropic/claude-haiku-4-5`.

Every `ask` is a run, and a run leaves a record when history is on. Turn it on with the smallest possible block — a file store under `data/` — by appending to `config/config.yaml`:

```yaml
runHistory:
  store: file
```

Ask once more, then list what happened and open the record:

```bash
npx tsx src/cli.ts ask "in one sentence, what is a lateral join?"
npx tsx src/cli.ts runs list --status all
```

The list prints one row per run with a short id, the agent, the outcome and the duration. Copy the full id from `runs list --status all --json` and read the record and its event stream — the same data the dashboard's run page shows:

```bash
npx tsx src/cli.ts runs get <run id>
npx tsx src/cli.ts runs events <run id>
```

That is the whole product in miniature: a message arrives over a channel, a dispatcher routes it to an agent, the agent runs on a model, and the run is recorded. Everything after this is the same pipeline with a different front door and a different place to run.

## Part 2 — an answer in Slack

Switchboard connects to Slack over Socket Mode: the bot dials out to Slack and holds a websocket, so it needs no public address, no ingress and no TLS to run from your laptop.

**Create the app from the manifest.** Go to [api.slack.com/apps](https://api.slack.com/apps), choose *Create New App* → *From a manifest*, pick your workspace, and paste the contents of the checked-in manifest — [`slack-app-manifest.yaml`](https://openswitchboard.dev/slack-app-manifest.yaml), which is `docs/public/slack-app-manifest.yaml` in the tree. It declares every bot scope and event the adapter uses and turns Socket Mode on; [Set up accounts](../how-to/set-up-accounts.md) explains each scope, if you want to know before you click. Create the app.

**Make the two tokens.** A Socket Mode app has an app-level token and a bot token:

1. *Basic Information* → *App-Level Tokens* → *Generate Token and Scopes*: name it anything, add the scope `connections:write`, generate. The value starts with `xapp-`; that is `SLACK_APP_TOKEN`. (A manifest cannot create this token, which is why it is a click.)
2. *Install App* → *Install to Workspace*, and allow the scopes. The *Bot User OAuth Token* starts with `xoxb-`; that is `SLACK_BOT_TOKEN`.

Put both values on their lines in `.env`.

**Start the bot.** This is the same process the production container runs, from source (`npm run dev` is the same command):

```bash
npx tsx src/index.ts
```

The startup log states what it computed: the capabilities that are on, where runtime overrides are stored, the dashboard's auth strategy — and, once the socket is up, `switchboard running (providers: anthropic, openai; default agent: general)`. Leave it running.

**Say something.** In Slack, invite the bot to a channel (`/invite @<your app's name>`) and mention it:

```
@<your app's name> what can you do?
```

Three things happen in order: an 👀 reaction on your message (the receipt that the request landed), a status card that edits itself in place as the run progresses, and the answer in a thread under your message. Reply in that thread without a mention and the bot answers again — once it is part of a thread, every reply reaches it.

The same `runs list` from Part 1 now shows this run too, with `slack:` in its channel id. Stop the process with Ctrl-C when you are done; nothing is lost, because the thread's context lives in Slack, not in the process.

## Part 3 — an answer from production

Production is the bot as a container on Cloudflare, with a **state Worker** beside it so that config, run history and chat-set overrides survive the container's restarts. Those two are the smallest deployment that behaves like production; the sandbox, resident and docs Workers are optional additions described in [Deploy](../how-to/deploy.md).

**Before you start:** a Cloudflare account, a domain (a *zone*) in it, `npx wrangler login` run once in `deploy/cloudflare` against that account, and Docker running — the bot's image is built on your machine.

**Write the deployment profile.** Copy the example and fill in the account id, the zone, and two hostnames under that zone; delete the `resident`, `sandbox` and `docs` entries so the plan has only the two steps you want:

```bash
cp deploy/profile.example.json deploy/profile.json
```

```json
{
  "account": "<your Cloudflare account id>",
  "zone": "example.com",
  "workers": {
    "memory": { "script": "switchboard-memory", "hostname": "switchboard-memory.example.com" },
    "bot": { "script": "switchboard", "hostname": "switchboard.example.com" }
  },
  "configSource": "config/config.yaml"
}
```

The profile is ignored by git: it names your account and your hostnames, and the tree carries neither.

**Point the config at the state Worker.** In `config/config.yaml`, replace the `runHistory` block from Part 1 with one that names the state Worker's hostname, and add the block that sends chat-set overrides there too. Both use the same bearer, `MEMORY_TOKEN`, by default:

```yaml
runHistory:
  worker:
    baseUrl: https://switchboard-memory.example.com
runtimeOverrides:
  worker:
    baseUrl: https://switchboard-memory.example.com
```

**Render the Worker configs and read the plan.** Every Worker's `wrangler.jsonc` is generated from the template beside it and your profile — never edited by hand:

```bash
npx tsx src/cli.ts deploy init
npx tsx src/cli.ts deploy plan
```

The plan lists two steps in the only supported order — the state Worker, then the bot — with the checks each one runs and the health URL it waits on. Nothing is executed.

**Stage the secrets.** `deploy secrets` reads values from a directory of files named after the secrets, `~/.secrets/switchboard/<NAME>`, one value per file, and pipes each into `wrangler secret put` — no value ever appears in a command line or a log. Create the directory (mode 700) and write four files: your two Slack tokens and your Anthropic key from `.env`, and a bearer you mint for the state Worker:

```bash
mkdir -p -m 700 ~/.secrets/switchboard
openssl rand -hex 32 > ~/.secrets/switchboard/MEMORY_TOKEN
```

Then put them. The state Worker holds one secret; the bot holds many, and every one that belongs to a feature you have not turned on is optional — the command skips it by name and says so (the full list, and which are required, is `deploy/secrets.manifest.json`):

```bash
npx tsx src/cli.ts deploy secrets memory
npx tsx src/cli.ts deploy secrets bot
```

**Deploy.** One command runs the plan: it checks that wrangler is logged in to the profile's account and that the tree is clean at `origin/main`, validates your config and pushes it to the state Worker as the document the bot reads at startup, deploys the state Worker, builds and deploys the bot's image, and then waits until the bot's `/healthz` answers from a container running this commit. It needs the state Worker's bearer in its own environment to push the config:

```bash
MEMORY_TOKEN="$(cat ~/.secrets/switchboard/MEMORY_TOKEN)" npx tsx src/cli.ts deploy all
```

The command exits 0 only when the new container is live; "deployed" and "live" are different moments on Cloudflare, and it waits for the second one.

**Say something, again.** Stop the local bot if it is still running from Part 2 (two processes on one Slack app would share the events), then mention the bot in Slack exactly as before. The reply now comes from your production container. Confirm it from the outside:

```bash
curl -sS https://switchboard.example.com/healthz
```

The JSON names the commit the container was built from, whether it is draining, and how many runs are in flight.

You have Switchboard in your terminal, in Slack, and in production, and every one of those was the same pipeline. What to read next depends on which of the three you care about:

- **Slack**: [Your first request in Slack](first-request-in-slack.md) for what else a thread can do, then [Configure your defaults](../how-to/configure-your-defaults.md).
- **Production**: [Deploy](../how-to/deploy.md) for the optional Workers, the release workflow that deploys for you, and rotating a secret; [Set up accounts](../how-to/set-up-accounts.md) for the GitHub App that lets the coding agent open pull requests.
- **The design**: [Architecture](../explanation/architecture.md), then [Security model](../explanation/security-model.md).
