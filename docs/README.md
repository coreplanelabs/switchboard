# Switchboard docs

Switchboard is an agent gateway: a message arrives over Slack, the CLI, HTTP or MCP, and an agent answers it, reviews a pull request, or ships code. Read this tree here or at [openswitchboard.dev](https://openswitchboard.dev).

## Pick your surface

New here? [Get started](tutorials/get-started.md) first.

| You are… | Start with | Then |
|---|---|---|
| talking to the bot in Slack | [Your first request in Slack](tutorials/first-request-in-slack.md) | [Configure your defaults](how-to/configure-your-defaults.md) |
| running it in production | [Deploy](how-to/deploy.md) | [Operate production](how-to/operate-production.md) |
| watching runs or spend | [Watch a run](how-to/watch-a-run.md) | [Check spend](how-to/check-spend.md) |
| locking it down | [Restrict who can do what](how-to/restrict-who-can-do-what.md) | [Security model](explanation/security-model.md) |
| changing the code | [Run it locally](tutorials/run-it-locally.md) | [How a request flows](explanation/how-a-request-flows.md) |

## Four kinds of page

The tree follows [Diataxis](https://diataxis.fr): four jobs, never mixed on one page.

| Kind | Answers | Index |
|---|---|---|
| Tutorials | "Walk me through it" | [tutorials/](tutorials/) |
| How-to guides | "How do I do X?" | [how-to/](how-to/) |
| Reference | "What is the exact syntax, value, default?" | [reference/](reference/) |
| Explanation | "Why does it work this way?" | [explanation/](explanation/) |

## Where the ground truth lives

[`reference/specs/`](reference/specs/README.md) is the contract: one file per feature, every criterion bound to a test or a procedure. When a page here disagrees with a spec, the spec is right.

[`README.md`](../README.md) is the front door; [`AGENTS.md`](../AGENTS.md) is for whoever changes Switchboard.
