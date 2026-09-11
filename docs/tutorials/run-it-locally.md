# Run it locally

By the end, you run Switchboard from a checkout of the repository, ask it a question, connect it to Slack, and pass the check every change must pass. This is the contributor's loop; to use the product, [Get started](get-started.md) needs no checkout.

**You need:** Node 24 (`.nvmrc` pins it; 22 or newer runs), git, and an Anthropic API key.

## Clone and install

```bash
git clone https://github.com/coreplanelabs/switchboard.git
cd switchboard
npm ci
```

One lockfile covers the bot, the dashboard, the docs site, the Workers and the CLI package.

## Write the local files

```bash
npm run cli -- init --organization <org> --anthropic-key <key>
```

You should see:

```
wrote:
  .env                  (mode 600)
  config/config.yaml
providers: anthropic
```

`npm run cli --` is the checkout's spelling of the published CLI; the same code ships as `@coreplane/switchboard`.

## Ask

```bash
npm run cli -- ask "agent:review model:anthropic/claude-opus-5 what would you look for in a PR that touches auth middleware?"
```

`agent:` and `model:` are the directives a Slack mention takes; `--thread <key>` before the text makes the next `ask` a follow-up.

## Connect it to Slack

Create the app and its two tokens as in [Get started](get-started.md), then:

```bash
npm run cli -- init --force --organization <org> --anthropic-key <key> --slack-app-token <xapp-token> --slack-bot-token <xoxb-token>
npm run dev
```

You should see `switchboard running (providers: anthropic; default agent: general)`. This is the process the container runs, from source.

## Change something and check it

```bash
npx vitest run --changed origin/main   # the tests your change touches
npm run fix                            # regenerate, lint, format
npm run verify                         # everything CI runs, ~4 min
```

`verify` is the one gate; nothing lives only in CI.

## Next

- [Contributing](../../CONTRIBUTING.md): how a change is made, the PR title rule, releases.
- [How a request flows](../explanation/how-a-request-flows.md): what `ask` just ran.
- [Code map](../reference/code-map.md): where things are.
