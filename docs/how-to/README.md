# How-to guides

**"How do I do X?"** A how-to guide is a recipe for a goal you already have: what you need before you start, the numbered steps, and what you have when you are done. It assumes you know the basics, it addresses the real world including its complications, and it points at the [reference](../reference/) rather than repeating it.

If you are new and want a guided first success instead, start with a [tutorial](../tutorials/).

## Set it up

- [Set up accounts](set-up-accounts.md) — the Slack app, a model key, the GitHub App, and the optional Cloudflare and E2B accounts, with what each unlocks.
- [Turn features on and off](turn-features-on-and-off.md) — the capability matrix: the config block that turns each feature on, what appears, what disappears, what it costs.
- [Restrict who can do what](restrict-who-can-do-what.md) — `grants` and `restrict`, built up from open to locked down.

## Use it

- [Configure your defaults](configure-your-defaults.md) — agent, model and effort, per you or per channel.
- [Connect an MCP server](connect-an-mcp-server.md) — give an agent tools from an external service, without a token in chat.
- [Onboard a repo](onboard-a-repo.md) — make a repository always warm instead of cloning cold every time.
- [Watch a run](watch-a-run.md) — the dashboard: live runs, stopping one, reading back history.
- [Check spend](check-spend.md) — daily cost per group, and the JSON twin to alert on.

## Extend it

- [Add a model provider](add-a-provider.md) — a config block for an OpenAI-compatible API, an adapter for anything else.
- [Add an agent](add-an-agent.md) — a prompt, a toolset and budgets, reachable on every surface.

## Run it in production

- [Deploy](deploy.md) — Cloudflare, the one supported target: the profile, `deploy init`, `deploy secrets`, `deploy config`, `deploy all`, and what the release workflow does with them.
- [Ship a release](ship-a-release.md) — read the release PR's deploy plan, merge it, confirm the new code is live.
- [Rotate a secret](rotate-a-secret.md) — a put and a restart, on every Worker that holds the value.
- [Operate production](operate-production.md) — deploys outside a release, config changes without one, the preflights, the span log.
- [Configure the repository](configure-the-repository.md) — the GitHub settings a fork reproduces: squash-only merges, the required checks, the merge queue.
- [Run a load test](run-a-load-test.md) — a number for how Switchboard behaves with many runs at once, before and after a capacity change.
