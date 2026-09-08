# Switchboard docs

Switchboard is a Slack bot — and a CLI, and an HTTP/MCP surface — that runs agents (answer questions, review PRs, ship code) against your repos, configurable per organization, per channel, and per person. This tree is the human orientation layer for it: not the engineering README, not the agent-facing spec, but the docs for whoever actually *uses*, *watches*, or *runs* Switchboard.

It's organized by [the Diataxis framework](https://diataxis.fr): four kinds of writing, because "documentation" is really four different jobs that shouldn't be mixed into one page.

You can read this tree here on GitHub or as a site — [docs.switchboard.coreplanelabs.dev](https://docs.switchboard.coreplanelabs.dev), also reachable at `/docs` on the dashboard and from the docs icon in its header. Same markdown, same links: the site is compiled from these files on every push, with search, diagrams, and dark mode.

| Kind | Answers | When you reach for it |
|---|---|---|
| **[Tutorials](tutorials/)** | "Walk me through it" | You're new — you want a working result, not a decision |
| **[How-to guides](how-to/)** | "How do I do X?" | You know the basics, you have a goal, you want the steps |
| **[Reference](reference/)** | "What's the exact syntax / value / default?" | You know what you want, you just need the fact |
| **[Explanation](explanation/)** | "Why does it work this way?" | You want the mental model, not the next command |

## Pick your surface

| You're... | Start with | Then |
|---|---|---|
| new, talking to the bot in Slack | [Your first request in Slack](tutorials/first-request-in-slack.md) | [Configure your defaults](how-to/configure-your-defaults.md) |
| watching runs or spend on the dashboard | [Watch a run and check spend](how-to/watch-a-run-and-check-spend.md) | [Dashboard routes](reference/dashboard-routes.md) |
| developing or extending Switchboard | [Run it locally](tutorials/run-it-locally.md) | [How a request flows](explanation/how-a-request-flows.md) |
| operating it in production | [Deploy and rotate a secret](how-to/deploy-and-rotate-a-secret.md) | [Worker topology](explanation/worker-topology.md) |

## Tutorials

- [Your first request in Slack](tutorials/first-request-in-slack.md) — mention it, follow up, ask for something real, in ten minutes.
- [Run it locally](tutorials/run-it-locally.md) — get an answer from Switchboard on your own machine, no Slack required.

## How-to guides

- [Configure your defaults](how-to/configure-your-defaults.md) — agent, model, and effort, per you or per channel.
- [Connect an MCP server](how-to/connect-an-mcp-server.md) — give an agent tools from Linear, Notion, or your own service.
- [Onboard a repo](how-to/onboard-a-repo.md) — make a repo always-warm instead of cloning cold every time.
- [Watch a run and check spend](how-to/watch-a-run-and-check-spend.md) — the dashboard: live runs, history, stopping one, costs.
- [Restrict who can do what](how-to/restrict-who-can-do-what.md) — `grants` and `restrict`, built up from open to locked down.
- [Add a provider or an agent](how-to/add-a-provider-or-agent.md) — extend Switchboard without touching the dispatcher.
- [Deploy and rotate a secret](how-to/deploy-and-rotate-a-secret.md) — the one command to ship, the runbook to rotate a credential.
- [Run a load test](how-to/run-a-load-test.md) — a number for how Switchboard behaves with many runs at once, before and after a capacity change.

## Reference

- [Slack commands](reference/slack-commands.md) — every directive and command, by category.
- [CLI](reference/cli.md) — command form, every group, exit codes.
- [Configuration](reference/configuration.md) — every `config.yaml` block, what it does, its off-state.
- [Authorization](reference/authorization.md) — the `grants` and `restrict` blocks: every axis, every baseline, what fails closed.
- [Dashboard routes](reference/dashboard-routes.md) — every route, its auth, what it shows.

## Explanation

- [How a request flows](explanation/how-a-request-flows.md) — channel → dispatcher → provider/executor, the one pipeline everything shares.
- [Why config is layered](explanation/config-layers.md) — six independent layers, and why effort is one of them.
- [Execution and trust](explanation/execution-and-trust.md) — where `bash` actually runs, and why blast radius is the design constraint.
- [Worker topology](explanation/worker-topology.md) — the bot plus three Cloudflare Workers, what each owns, how they call each other.
- [One definition, every surface](explanation/one-command-many-surfaces.md) — how one command definition becomes chat, CLI, HTTP, and MCP with no per-surface code.
- [Runs: live, then remembered](explanation/runs-live-and-history.md) — why a run has two lives, and what a restart does and doesn't lose.
- [How Switchboard improves itself](self-improvement-architecture.md) — the friction → pattern → GitHub-issue loop, and where each piece runs.

## Where the ground truth lives

This tree explains and orients. It is not the contract. [`features/`](https://github.com/coreplanelabs/switchboard/blob/main/features/README.md) is the versioned behavioral contract — one file per feature, every criterion backed by a named test or explicit agent-runnable instructions, updated in the same PR as any behavior change. When something here and a feature file disagree, the feature file is right — and that disagreement is a docs bug worth filing.

The root [`README.md`](https://github.com/coreplanelabs/switchboard/blob/main/README.md) and [`AGENTS.md`](https://github.com/coreplanelabs/switchboard/blob/main/AGENTS.md) serve a different reader: an engineer or a coding agent working *on* Switchboard's own codebase — architecture internals, the deploy runbook in full, invariants that must not break. Read this tree to understand and use Switchboard; read those to change it.
