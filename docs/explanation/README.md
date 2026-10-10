# Explanation

Why Switchboard is shaped the way it is: constraints, rejected alternatives, and the decision record behind each choice.

The contract is elsewhere: [`docs/reference/specs/`](../reference/specs/README.md).

## The system

- [Architecture](architecture.md) — the request path and where the parts run.
- [How model calls use capacity](model-call-flow.md) — the queues, permit lifetimes, follow-ups and benchmark proof.
- [How a request flows](how-a-request-flows.md) — text, model turns and code checks.
- [Data model](what-holds-what.md) — threads, runs, pipelines and their durable records.
- [What an agent is](agents-and-toolsets.md) — the eight work profiles and when to add one.
- [Worker topology](worker-topology.md) — the bot plus three Workers.
- [One definition, every surface](one-command-many-surfaces.md) — one command becomes chat, CLI, HTTP and MCP.
- [Runs: live and recorded](runs-live-and-history.md) — live progress and finished history.
- [A thread outlives its runs](a-thread-continues.md) — the shared conversation and agent working logs.
- [Why config is layered](config-layers.md) — six layers, effort included.

## Trust

- [Security model](security-model.md) — what a compromise of each piece yields.
- [Execution and trust](execution-and-trust.md) — where `bash` runs.

## Running it

- [Capacity and sizing](capacity-and-sizing.md) — why the containers are the size they are.
- [Known limits](known-limits.md) — off, narrow, or not yet proven.

## The project

- [How Switchboard improves itself](how-switchboard-improves-itself.md) — friction → pattern → issue.
- [How we work](how-we-work.md) — spec, test, PR, agent review, release.
- [Design decisions](design-decisions.md) — the records.
