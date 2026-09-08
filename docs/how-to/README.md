# How-to guides

**"How do I do X?"** A how-to guide is a recipe for a goal you already have: what you need, the steps, the result. It assumes the basics and points at the [reference](../reference/) rather than repeating it; new here, start with a [tutorial](../tutorials/).

## Set it up

- [Set up accounts](set-up-accounts.md): the Slack app, a model key, the GitHub App, Cloudflare, E2B, Brave.
- [Turn features on and off](turn-features-on-and-off.md): the capability matrix and what each costs.
- [Restrict who can do what](restrict-who-can-do-what.md): `grants` and `restrict`, from open to locked down.

## Use it

- [Configure your defaults](configure-your-defaults.md): agent, model and effort, per you or per channel.
- [Connect an MCP server](connect-an-mcp-server.md): external tools without a token in chat.
- [Onboard a repo](onboard-a-repo.md): an always-warm environment for one repository.
- [Watch a run](watch-a-run.md): live runs, stopping one, reading history.
- [Check spend](check-spend.md): cost per day and group, and the JSON twin.

## Extend it

- [Add a model provider](add-a-provider.md): a config block, or an adapter.
- [Add an agent](add-an-agent.md): a prompt, a toolset and budgets, on every surface.

## Run it in production

- [Deploy](deploy.md): the profile, the secrets, `deploy all`, the optional Workers, CI.
- [Operate production](operate-production.md): a deploy or config change outside a release; the span log.
- [Rotate a secret](rotate-a-secret.md): a put and a restart.
- [Ship a release](ship-a-release.md): read the release PR's plan, merge, confirm it is live.
- [Configure the repository](configure-the-repository.md): the GitHub settings a fork reproduces.
- [Run a load test](run-a-load-test.md): a number for many runs at once.
