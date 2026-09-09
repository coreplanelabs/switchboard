# Get started

By the end of this lesson OpenSwitchboard has answered you three times: from a terminal on your own machine, from a Slack channel, and from a production deployment on Cloudflare. Each part builds on the one before it, and nothing is undone along the way — the checkout you make in the first part is the one you deploy in the last.

**You need:** Node 24 (`.nvmrc` pins it; 22 or newer runs), a terminal, and an Anthropic API key. The second part adds a Slack workspace where you may create an app; the third adds a Cloudflare account with a domain in it and Docker running locally.

## Part 1 — an answer in your terminal

Clone the repository and install every package at once; the root lockfile covers the bot, the dashboard, the docs site and the Workers.

```bash
git clone https://github.com/coreplanelabs/switchboard.git
cd switchboard
npm ci
```

Now the one command this lesson is built on. `init` writes the two local files the tree deliberately does not carry, from their checked-in examples, with the values you give it; `<org>` is the GitHub organization (or user) this installation will serve, and the key is yours:

```bash
npm run cli -- init --organization <org> --anthropic-key <your key>
```

It prints what it did:

```
wrote:
  .env                  (mode 600)
  config/config.yaml
providers: anthropic
capabilities: execution local · github off · memory off · run history off · run ledger off · mcp off · costs off · schedules off · ingress off · residents off · dashboard auth none · docs off
next:
  npm run cli -- ask "what can you do?"
  npx tsx src/index.ts
  docker compose up -d   # the same bot from the published image …
```

Two things happened. `.env` holds your key on its `ANTHROPIC_API_KEY` line and nothing else that is real — every other placeholder from the example is commented out — and only you can read it (`ls -l .env` shows `-rw-------`). `config/config.yaml` is the example config with your organization, one provider, and every optional block still off; `init` loaded it through the same loader the bot uses and printed the result as the `capabilities` line. Run it on a terminal without the flags and it asks for each answer instead; run it again and it refuses to overwrite either file unless you say `--force`; `init --dry-run` shows both files with the secrets masked; `init --help` lists every flag, including the ones for an OpenAI-compatible endpoint, Slack and the GitHub App.

Now ask, as the output told you to. The CLI is a channel like Slack is: the same dispatcher, the same agents, printing to your terminal instead of a thread.

```bash
npm run cli -- ask "what can you do?"
```

OpenSwitchboard reads credentials from the environment and from nowhere else; the process loads `.env` from the directory you run it in — the repo root here — and a variable your shell already exports wins over the file.

You will see a status line tick (`preparing workspace…`, then `thinking…`), and then the answer: the general agent introduces itself and the agents it can hand work to. That took one model call on the default model, `anthropic/claude-haiku-4-5`.

**What `init` did for you, by hand.** The files it wrote are the two copies the manual path makes — `cp config/config.example.yaml config/config.yaml`, `cp .env.example .env`, then editing `organization:` in the first and the `ANTHROPIC_API_KEY` line in the second. Nothing about them is special: open either one, and change it, whenever you like.

Every `ask` is a run, and a run leaves a record when history is on. Turn it on with the smallest possible block — a file store under `data/` — by appending to `config/config.yaml`:

```yaml
runHistory:
  store: file
```

Ask once more, then list what happened and open the record:

```bash
npm run cli -- ask "in one sentence, what is a lateral join?"
npm run cli -- runs list --status all
```

The list prints one row per run with a short id, the agent, the outcome and the duration. Copy the full id from `runs list --status all --json` and read the record and its event stream — the same data the dashboard's run page shows:

```bash
npm run cli -- runs get <run id>
npm run cli -- runs events <run id>
```

That is the whole product in miniature: a message arrives over a channel, a dispatcher routes it to an agent, the agent runs on a model, and the run is recorded. Everything after this is the same pipeline with a different front door and a different place to run.

## Part 2 — an answer in Slack

OpenSwitchboard connects to Slack over Socket Mode: the bot dials out to Slack and holds a websocket, so it needs no public address, no ingress and no TLS to run from your laptop.

**Create the app from the manifest.** Go to [api.slack.com/apps](https://api.slack.com/apps), choose *Create New App* → *From a manifest*, pick your workspace, and paste the contents of the checked-in manifest — [`slack-app-manifest.yaml`](https://openswitchboard.dev/slack-app-manifest.yaml), which is `docs/public/slack-app-manifest.yaml` in the tree. It declares every bot scope and event the adapter uses and turns Socket Mode on; [Set up accounts](../how-to/set-up-accounts.md) explains each scope, if you want to know before you click. Create the app.

**Make the two tokens.** A Socket Mode app has an app-level token and a bot token:

1. *Basic Information* → *App-Level Tokens* → *Generate Token and Scopes*: name it anything, add the scope `connections:write`, generate. The value starts with `xapp-`; that is `SLACK_APP_TOKEN`. (A manifest cannot create this token, which is why it is a click.)
2. *Install App* → *Install to Workspace*, and allow the scopes. The *Bot User OAuth Token* starts with `xoxb-`; that is `SLACK_BOT_TOKEN`.

Put both values in `.env`: either on their two lines by hand, or by running `init` again with everything it knows plus the two tokens — `--force` lets it replace the files it wrote in Part 1:

```bash
npm run cli -- init --force --organization <org> --anthropic-key <your key> --slack-app-token xapp-… --slack-bot-token xoxb-…
```

**Start the bot.** This is the same process the production container runs, from source (`npm run dev` is the same command):

```bash
npx tsx src/index.ts
```

The startup log states what it computed: the capabilities that are on, where runtime overrides are stored, the dashboard's auth strategy — and, once the socket is up, `switchboard running (providers: anthropic; default agent: general)`. Leave it running.

**Say something.** In Slack, invite the bot to a channel (`/invite @<your app's name>`) and mention it:

```
@<your app's name> what can you do?
```

Three things happen in order: an 👀 reaction on your message (the receipt that the request landed), a status card that edits itself in place as the run progresses, and the answer in a thread under your message. Reply in that thread without a mention and the bot answers again — once it is part of a thread, every reply reaches it.

The same `runs list` from Part 1 now shows this run too, with `slack:` in its channel id. Stop the process with Ctrl-C when you are done; nothing is lost, because the thread's context lives in Slack, not in the process.

## Part 3 — an answer from production

Production is the bot as a container on Cloudflare, with a **state Worker** beside it so that config, run history and chat-set overrides survive the container's restarts. Those two are the smallest deployment that behaves like production; the sandbox and resident Workers are optional additions described in [Deploy](../how-to/deploy.md).

**Before you start:** a Cloudflare account, a domain (a *zone*) in it, `npx wrangler login` run once in `deploy/cloudflare` against that account, and Docker running — the bot's image is built on your machine.

**Write the deployment profile and render the Worker configs.** One more `init`, with your account id and your zone. It writes `deploy/profile.json` — the bot as `switchboard.<zone>` and the state Worker as `switchboard-memory.<zone>` (`--name` changes the stem) — and, because the profile is now there, renders every Worker's `wrangler.jsonc` from the template beside it, the way `deploy init` does:

```bash
npm run cli -- init --force --organization <org> --anthropic-key <your key> --slack-app-token xapp-… --slack-bot-token xoxb-… --cloudflare <your Cloudflare account id> --zone example.com
```

```
wrote:
  .env                  (mode 600)
  config/config.yaml
  deploy/profile.json
…
Worker configs from deploy/profile.json:
  written   deploy/cloudflare-memory/wrangler.jsonc
  written   deploy/cloudflare/wrangler.jsonc
next:
  …
  npm run cli -- deploy secrets memory
  npm run cli -- deploy secrets bot
  MEMORY_TOKEN="$(cat ~/.secrets/switchboard/MEMORY_TOKEN)" npm run cli -- deploy all
```

The profile is ignored by git: it names your account and your hostnames, and the tree carries neither. `init` writes it only from the root of a checkout — the Worker templates and `deploy all` live there — and refuses anywhere else.

**Point the config at the state Worker.** `--force` rewrote `config/config.yaml` from the example, so the `runHistory` block from Part 1 is gone; add the one that names the state Worker's hostname instead, and the block that sends chat-set overrides there too. Both use the same bearer, `MEMORY_TOKEN`, by default:

```yaml
runHistory:
  worker:
    baseUrl: https://switchboard-memory.example.com
runtimeOverrides:
  worker:
    baseUrl: https://switchboard-memory.example.com
```

**Read the plan.** The Worker configs are already rendered; the plan is what `deploy all` will do:

```bash
npm run cli -- deploy plan
```

The plan lists two steps in the only supported order — the state Worker, then the bot — with the checks each one runs and the health URL it waits on. Nothing is executed.

**Stage the secrets.** `deploy secrets` reads values from a directory of files named after the secrets, `~/.secrets/switchboard/<NAME>`, one value per file, and pipes each into `wrangler secret put` — no value ever appears in a command line or a log. `init` never writes there: a secret's only file on this machine is `.env`. Create the directory (mode 700) and write four files: your two Slack tokens and your Anthropic key from `.env`, and a bearer you mint for the state Worker:

```bash
mkdir -p -m 700 ~/.secrets/switchboard
openssl rand -hex 32 > ~/.secrets/switchboard/MEMORY_TOKEN
```

Then put them. The state Worker holds one secret; the bot holds many, and every one that belongs to a feature you have not turned on is optional — the command skips it by name and says so (the full list, and which are required, is `deploy/secrets.manifest.json`):

```bash
npm run cli -- deploy secrets memory
npm run cli -- deploy secrets bot
```

**Deploy.** One command runs the plan: it checks that wrangler is logged in to the profile's account and that the tree is clean at `origin/main`, validates your config and pushes it to the state Worker as the document the bot reads at startup, deploys the state Worker, builds and deploys the bot's image, and then waits until the bot's `/healthz` answers from a container running this commit. It needs the state Worker's bearer in its own environment to push the config:

```bash
MEMORY_TOKEN="$(cat ~/.secrets/switchboard/MEMORY_TOKEN)" npm run cli -- deploy all
```

The command exits 0 only when the new container is live; "deployed" and "live" are different moments on Cloudflare, and it waits for the second one.

**Say something, again.** Stop the local bot if it is still running from Part 2 (two processes on one Slack app would share the events), then mention the bot in Slack exactly as before. The reply now comes from your production container. Confirm it from the outside:

```bash
curl -sS https://switchboard.example.com/healthz
```

The JSON names the commit the container was built from, whether it is draining, and how many runs are in flight.

You have OpenSwitchboard in your terminal, in Slack, and in production, and every one of those was the same pipeline. What to read next depends on which of the three you care about:

- **Slack**: [Your first request in Slack](first-request-in-slack.md) for what else a thread can do, then [Configure your defaults](../how-to/configure-your-defaults.md).
- **Production**: [Deploy](../how-to/deploy.md) for the optional Workers, the release workflow that deploys for you, and rotating a secret; [Set up accounts](../how-to/set-up-accounts.md) for the GitHub App that lets the coding agent open pull requests — `init --github-app-id … --github-installation-id … --github-private-key-file …` puts its three values in `.env`.
- **The design**: [Architecture](../explanation/architecture.md), then [Security model](../explanation/security-model.md).
