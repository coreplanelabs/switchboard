# Explanation

Why OpenSwitchboard is shaped the way it is: constraints, rejected alternatives, and the decision record behind each choice.

The contract is elsewhere: [`docs/reference/specs/`](../reference/specs/README.md).

## The system

- [Architecture](architecture.md) — the parts, in three diagrams.
- [How a request flows](how-a-request-flows.md) — one pipeline for every entry point.
- [The agents and their toolsets](agents-and-toolsets.md) — five agents and what each may reach.
- [Worker topology](worker-topology.md) — the bot plus three Workers.
- [One definition, every surface](one-command-many-surfaces.md) — one command becomes chat, CLI, HTTP and MCP.
- [Runs: live, then remembered](runs-live-and-history.md) — a run's two lives.
- [Why config is layered](config-layers.md) — six layers, effort included.

## Trust

- [Security model](security-model.md) — what a compromise of each piece yields.
- [Execution and trust](execution-and-trust.md) — where `bash` runs.

## Running it

- [Capacity and sizing](capacity-and-sizing.md) — why the containers are the size they are.
- [Known limits](known-limits.md) — off, narrow, or not yet proven.

## The project

- [How OpenSwitchboard improves itself](how-switchboard-improves-itself.md) — friction → pattern → issue.
- [How we work](how-we-work.md) — spec, test, PR, agent review, release.
- [Design decisions](design-decisions.md) — the records.
