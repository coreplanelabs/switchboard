# Run it locally, no Slack required

Get Switchboard answering questions on your own machine, then run an agent against a real repo — all from one CLI command. Slack is one front door among several; this tutorial uses the one that needs no external setup.

**Needs:** Node 22+ (`.nvmrc` pins it), an Anthropic API key.

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
work: `npm test` for the bot, `npm test -w web` for the dashboard.

## Next

- **Point it at Slack for real:** the root [README's Setup section](https://github.com/coreplanelabs/switchboard/blob/main/README.md#setup) walks through creating the Slack app and wiring tokens — nothing above changes.
- **Understand what just ran:** [how a request flows](../explanation/how-a-request-flows.md).
- **Extend it:** [add a provider or agent](../how-to/add-a-provider-or-agent.md).
