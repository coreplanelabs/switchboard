---
title: Model and effort resolve through the same configuration layers
status: implemented
date: 2026-09-08
pattern: Layered configuration resolution
---

# Model and effort resolve through the same configuration layers

## Context

Which model answers a request, and how much of its time budget goes to thinking, are decisions people want to make at different granularities: this one message, this thread, me, this channel, this installation, this agent. Early versions hardcoded a model per agent and treated reasoning effort as a detail of the model call. Both were wrong. An agent's real budget is wall-clock time, and effort decides how much of that goes to thinking rather than to work, so it is a routing decision of the same rank as the model.

## Decision

Model references are `<provider>/<model>` strings and effort is a named tier. Both resolve through one ladder, highest wins:

1. a directive on the request (`model:…`, `effort:…`)
2. the thread's sticky choice, derived from the thread's history and never stored
3. the user's configuration
4. the channel's configuration
5. the installation defaults in `config/config.yaml`
6. the agent definition
7. the provider default

An agent's registry `effort` is a floor every layer above can override, never a hardcoded tier. Runtime overrides set from chat persist to the state Worker's `ConfigDO` so they survive container restarts. Custom instructions ride the same scopes but are prompt content only; they never change resolution or gates.

## Consequences

- Nothing in an agent or the core names a model or an effort.
- A thread keeps the model it started with because the choice is re-derived from history on every turn; there is no per-thread record to lose or clean up.
- The same ladder later carried per-scope custom instructions and per-scope memory without a new mechanism.
- Seven layers is a lot to explain. The `config show` command prints the resolved value with the layer it came from, and the explanation doc on config layers walks the ladder.

## Alternatives rejected

- **Effort as a model detail.** A `claude-…-high` style name conflates two independent choices and doubles the model list.
- **Config in Worker environment variables.** A five-kilobyte cap per variable against a config that is already larger than that.
- **Baking config into a per-installation image.** Every edit becomes an image build and a rollout.

## Pattern

Layered configuration resolution. The off-state half of the same design is Null Object and feature toggles resolved once ([0018](0018-capabilities-computed-once-null-objects.md)).
