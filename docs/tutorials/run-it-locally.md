# Run it locally

By the end of this lesson Switchboard has answered a question on your own machine, run an agent with a directive, and shown you the run it recorded — all from the terminal, with no Slack workspace. It is for a developer who has a model provider API key and wants to see the pipeline work before connecting anything else.

## What you need

- Node 24 (`.nvmrc` pins it; 22 or newer runs).
- An Anthropic API key. Any provider works later; this lesson uses the one the example config names first.
- Ten minutes.

## 1. Clone and install

```bash
git clone <repository-url> switchboard && cd switchboard
npm ci
npm run cli -- init --organization <your GitHub org> --anthropic-key <your key>
```

`init` writes `.env` (mode 600, your key on its line) and `config/config.yaml` from the checked-in examples and prints what is on; the process loads `.env` at startup (a variable your shell exports wins). Nothing else is required to start: every optional block in `config.yaml` is commented out, and off means absent, not degraded ([Turn features on and off](../how-to/turn-features-on-and-off.md)).

## 2. Ask it something

```bash
npm run cli -- ask "what tools do you have available right now?"
```

The answer prints to your terminal. This ran the same pipeline a Slack message would: parse the directives, resolve the config, run the agent, deliver the reply. `ask` is a channel in its own right, one that prints instead of posting.

## 3. Steer it with a directive

```bash
npm run cli -- ask "agent:review model:anthropic/claude-opus-5 what would you look for in a PR that touches auth middleware?"
```

`agent:` and `model:` are the same directives you would type after a Slack mention; `effort:low` would make the turn faster. `--thread <key>` before the text makes the next `ask` a follow-up in that thread, with the same stickiness a Slack thread has.

## 4. Keep the runs

A run is live-only until you say otherwise, and a CLI process ends with its run. Open `config/config.yaml`, find the commented `runHistory` block, and turn on the file store:

```yaml
runHistory:
  store: file
```

Now every `ask` writes its record to `data/runs/` when it finishes.

## 5. Read a run back

```bash
npm run cli -- ask "in one line, what is a lateral join?"
npm run cli -- runs list --status all
```

The list is the same registry the Slack status card and the dashboard read. Take the run's full id (`runs list --status all --json` prints it) and:

```bash
npm run cli -- runs get <id>
npm run cli -- runs events <id>
```

The first is the record; the second is its event stream, tool calls and results included.

## What you built

A working Switchboard with one provider and the terminal as its channel, and the habit of reading a run's record after it finishes. Nothing here is undone by adding Slack: the same config and the same runs carry over.

## Next

- Connect Slack and a GitHub App: [Set up accounts](../how-to/set-up-accounts.md).
- Understand what just ran: [How a request flows](../explanation/how-a-request-flows.md).
- Change the code and run the checks: [Contributing](../../CONTRIBUTING.md).
