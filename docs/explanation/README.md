# Explanation

**"Why does it work this way?"** Explanation is the discussion that builds a mental model: the design constraints, the alternatives that were rejected, the shape of the thing. It is the only kind of page here that is allowed an opinion, and the only one you can read without a keyboard in front of you. Each page links the decision record that settled what it explains.

It is still not the contract. The versioned behavioral contract is [`docs/reference/specs/`](../reference/specs/README.md).

## The system

- [Architecture](architecture.md) — the parts and how they fit, in one set of diagrams.
- [How a request flows](how-a-request-flows.md) — channel, dispatcher, provider, executor: the one pipeline everything shares.
- [The agents and their toolsets](agents-and-toolsets.md) — the five agents, what each may reach, and why the toolset is the boundary but not the wall.
- [Worker topology](worker-topology.md) — the bot plus three Cloudflare Workers, what each owns, how they call each other.
- [One definition, every surface](one-command-many-surfaces.md) — how one command definition becomes chat, CLI, HTTP and MCP with no per-surface code.
- [Runs: live, then remembered](runs-live-and-history.md) — why a run has two lives, and what a restart does and does not lose.
- [Why config is layered](config-layers.md) — six independent layers, and why effort is one of them.

## Trust

- [Security model](security-model.md) — what an attacker can reach from each place, and what stops them.
- [Execution and trust](execution-and-trust.md) — where `bash` actually runs, and why blast radius is the design constraint.

## Running it

- [Capacity and sizing](capacity-and-sizing.md) — one Node process per container, and why the resident is sized by disk.
- [Known limits](known-limits.md) — what is off by default, narrow on purpose, or not yet proven.

## The project

- [How Switchboard improves itself](how-switchboard-improves-itself.md) — the friction → pattern → issue loop, and where each piece runs.
- [How we work](how-we-work.md) — spec, failing test, implementation, a PR with a Tour, an agent review in the open, an automated release.
- [Design decisions](design-decisions.md) — the decision records: what was decided, why, what was rejected, and the pattern each one instantiates.
