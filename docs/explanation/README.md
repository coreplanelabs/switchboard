# Explanation

**"Why does it work this way?"** Explanation is the discussion that builds a mental model: the design constraints, the alternatives that were rejected, the shape of the thing. It is the only kind of page here that is allowed to have an opinion — and the only one you can read without a keyboard in front of you.

It is still not the contract: the versioned behavioral contract is [`features/`](https://github.com/coreplanelabs/switchboard/tree/main/features).

- [How a request flows](how-a-request-flows.md) — channel → dispatcher → provider/executor, the one pipeline everything shares.
- [Why config is layered](config-layers.md) — six independent layers, and why effort is one of them.
- [Execution and trust](execution-and-trust.md) — where `bash` actually runs, and why blast radius is the design constraint.
- [Worker topology](worker-topology.md) — the bot plus three Cloudflare Workers, what each owns, how they call each other.
- [One definition, every surface](one-command-many-surfaces.md) — how one command definition becomes chat, CLI, HTTP, and MCP with no per-surface code.
- [Runs: live, then remembered](runs-live-and-history.md) — why a run has two lives, and what a restart does and doesn't lose.
- [How Switchboard improves itself](how-switchboard-improves-itself.md) — the friction → pattern → GitHub-issue loop, and where each piece runs.
- [Design decisions](design-decisions.md) — the architecture decision records: what was decided, why, what was rejected, and the pattern each one instantiates.
- [How we work](how-we-work.md) — spec, failing test, implementation, a PR with a Tour, an agent review in the open, an automated release.
- [Capacity and sizing](capacity-and-sizing.md) — one Node process per container, and why the resident is sized by disk.
- [Known limits](known-limits.md) — what is off by default, unproven, or mid-transition, and who owns each item.
