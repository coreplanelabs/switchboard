# Switchboard docs

Switchboard is an agent gateway: a message arrives over a channel — Slack, the CLI, HTTP, MCP — and an agent answers it, reviews a pull request, or ships code against your repositories, configurable per organization, per channel and per person. This tree is the documentation for whoever *uses*, *watches*, *runs* or *extends* it.

It is organized by [the Diataxis framework](https://diataxis.fr): four kinds of writing, because documentation is four different jobs that should not be mixed on one page.

You can read this tree here on GitHub or as a site — [openswitchboard.dev](https://openswitchboard.dev), also reachable at `/docs` on the dashboard and from the docs icon in its header. Same markdown, same links: the site is compiled from these files on every push, with search, diagrams and dark mode.

| Kind | Answers | When you reach for it |
|---|---|---|
| **[Tutorials](tutorials/)** | "Walk me through it" | You are new and want a working result, not a decision |
| **[How-to guides](how-to/)** | "How do I do X?" | You know the basics, you have a goal, you want the steps |
| **[Reference](reference/)** | "What is the exact syntax, value, default?" | You know what you want and need the fact |
| **[Explanation](explanation/)** | "Why does it work this way?" | You want the mental model, not the next command |

## Start here

New to Switchboard? [Get started](tutorials/get-started.md) takes you from nothing to a running `ask`, then Slack, then production. Then pick your surface:

| You are… | Start with | Then |
|---|---|---|
| talking to the bot in Slack | [Your first request in Slack](tutorials/first-request-in-slack.md) | [Configure your defaults](how-to/configure-your-defaults.md) |
| watching runs or spend on the dashboard | [Watch a run](how-to/watch-a-run.md) | [Dashboard routes](reference/dashboard-routes.md) |
| developing or extending Switchboard | [Run it locally](tutorials/run-it-locally.md) | [How a request flows](explanation/how-a-request-flows.md) |
| operating it in production | [Deploy](how-to/deploy.md) | [Operate production](how-to/operate-production.md) |

## Tutorials

- [Get started](tutorials/get-started.md) — from nothing to a running `ask`, then Slack, then production, one command each.
- [Your first request in Slack](tutorials/first-request-in-slack.md) — send a request, follow up in the thread, hand a task to a specialist agent and watch its run.
- [Run it locally](tutorials/run-it-locally.md) — an answer from Switchboard on your own machine, and the run it recorded, with no Slack workspace.

## How-to guides

Set it up:

- [Set up accounts](how-to/set-up-accounts.md) — the Slack app, a model key, the GitHub App, and the optional Cloudflare and E2B accounts, with what each unlocks.
- [Turn features on and off](how-to/turn-features-on-and-off.md) — the capability matrix: the config block that turns each feature on, what appears, what disappears, what it costs.
- [Restrict who can do what](how-to/restrict-who-can-do-what.md) — `grants` and `restrict`, built up from open to locked down.

Use it:

- [Configure your defaults](how-to/configure-your-defaults.md) — agent, model and effort, per you or per channel.
- [Connect an MCP server](how-to/connect-an-mcp-server.md) — give an agent tools from an external service, without a token in chat.
- [Onboard a repo](how-to/onboard-a-repo.md) — make a repository always warm instead of cloning cold every time.
- [Watch a run](how-to/watch-a-run.md) — the dashboard: live runs, stopping one, reading back history.
- [Check spend](how-to/check-spend.md) — daily cost per group, and the JSON twin to alert on.

Extend it:

- [Add a model provider](how-to/add-a-provider.md) — a config block for an OpenAI-compatible API, an adapter for anything else.
- [Add an agent](how-to/add-an-agent.md) — a prompt, a toolset and budgets, reachable on every surface.

Run it in production:

- [Deploy](how-to/deploy.md) — Cloudflare, the one supported target: the profile, `deploy init`, `deploy secrets`, `deploy config`, `deploy all`, and what the release workflow does with them.
- [Ship a release](how-to/ship-a-release.md) — read the release PR's deploy plan, merge it, confirm the new code is live.
- [Rotate a secret](how-to/rotate-a-secret.md) — a put and a restart, on every Worker that holds the value.
- [Operate production](how-to/operate-production.md) — deploys outside a release, config changes without one, the preflights, the span log.
- [Configure the repository](how-to/configure-the-repository.md) — the GitHub settings a fork reproduces: squash-only merges, the required checks, the merge queue.
- [Run a load test](how-to/run-a-load-test.md) — a number for how Switchboard behaves with many runs at once, before and after a capacity change.

## Reference

- [Slack commands](reference/slack-commands.md) — every directive and command, by category.
- [CLI](reference/cli.md) — command form, every group, exit codes.
- [Configuration](reference/configuration.md) — every `config.yaml` block, what it does, its off-state.
- [Authorization](reference/authorization.md) — the `grants` and `restrict` blocks: every axis, every baseline, what fails closed.
- [Dashboard routes](reference/dashboard-routes.md) — every route, its auth, what it shows.
- [Code map](reference/code-map.md) — every module, what it owns, and the rule a change there must keep.
- [Specs](reference/specs/README.md) — the behavioral contract: one file per feature, every criterion bound to the test or procedure that proves it.

## Explanation

The system:

- [Architecture](explanation/architecture.md) — the parts and how they fit, in one set of diagrams.
- [How a request flows](explanation/how-a-request-flows.md) — channel, dispatcher, provider, executor: the one pipeline everything shares.
- [The agents and their toolsets](explanation/agents-and-toolsets.md) — the five agents, what each may reach, and why the toolset is the boundary but not the wall.
- [Worker topology](explanation/worker-topology.md) — the bot plus three Cloudflare Workers, what each owns, how they call each other.
- [One definition, every surface](explanation/one-command-many-surfaces.md) — how one command definition becomes chat, CLI, HTTP and MCP with no per-surface code.
- [Runs: live, then remembered](explanation/runs-live-and-history.md) — why a run has two lives, and what a restart does and does not lose.
- [Why config is layered](explanation/config-layers.md) — six independent layers, and why effort is one of them.

Trust:

- [Security model](explanation/security-model.md) — what an attacker can reach from each place, and what stops them.
- [Execution and trust](explanation/execution-and-trust.md) — where `bash` actually runs, and why blast radius is the design constraint.

Running it:

- [Capacity and sizing](explanation/capacity-and-sizing.md) — one Node process per container, and why the resident is sized by disk.
- [Known limits](explanation/known-limits.md) — what is off by default, narrow on purpose, or not yet proven.

The project:

- [How Switchboard improves itself](explanation/how-switchboard-improves-itself.md) — the friction → pattern → issue loop, and where each piece runs.
- [How we work](explanation/how-we-work.md) — spec, failing test, implementation, a PR with a Tour, an agent review in the open, an automated release.
- [Design decisions](explanation/design-decisions.md) — the decision records: what was decided, why, what was rejected, and the pattern each one instantiates.

## Where the ground truth lives

This tree explains and orients. It is not the contract. [`docs/reference/specs/`](reference/specs/README.md) is the versioned behavioral contract: one file per feature, every criterion backed by a named test or an agent-runnable procedure, updated in the same PR as any behavior change. When something here and a spec disagree, the spec is right, and the disagreement is a docs bug worth filing.

The root [`README.md`](../README.md) is the front door — the pitch, what you need, the quick start — and it links here for everything else. [`AGENTS.md`](../AGENTS.md) serves a different reader: an engineer or a coding agent working *on* Switchboard's own codebase, with the invariants that must not break and the commands that are the repo's whole interface. Read this tree to understand and use Switchboard; read that to change it.
