---
title: The dispatcher is the only place an agent run starts
status: implemented
date: 2026-09-08
pattern: Registry with orchestration outside it
---

# The dispatcher is the only place an agent run starts

## Context

Once commands became a registry that every surface derives from ([0008](0008-one-command-definition-every-surface.md)), it was tempting to register "run the agent" as just another command. A `run` command with an `exec` action would have been symmetrical and short.

But the permission gate that decides whether an actor may run a given agent lives in one function, `dispatch()`. It resolves directives, the layered configuration, thread stickiness and admission, assembles history, and only then starts the run. A second entry point that reaches the runner is a second authorization surface, and the two drift the first time one of them changes.

## Decision

`dispatch()` in `src/core/dispatcher.ts` is the only orchestrator. Channels are transports: they turn a platform event into an `IncomingMessage`, call `dispatch()`, and render what comes back. No registry command starts an agent run, and the action vocabulary deliberately has no class that authorizes one. A handler that reaches for the runner is a bug.

The two places a surface does start a run on purpose, the CLI's `ask` and the MCP `dispatch` tool, are channel built-ins that sit beside the derived commands and call `dispatch()` themselves. They are not registrations.

## Consequences

- The resolved-agent permission gate is asked in exactly one place, so it cannot be bypassed by adding a command.
- Everything a run needs to be consistent across surfaces, from directive parsing to thread admission, is written once.
- The dispatcher is the largest module in the core, and its layered resolution and gating are candidates for a split into a pipeline of stages; that split keeps one entry point and is tracked separately.
- A contributor who wants a new way to start work must express it as a new channel or a new directive, never as a command handler.

## Alternatives rejected

- **A `run` command in the registry.** Symmetrical, but it makes the authorization check a property of a handler instead of the one gate every run passes.
- **Letting channels orchestrate.** Each adapter would carry its own copy of directive parsing and gating; the Slack adapter and the HTTP ingress would disagree within a week.

## Pattern

Registry for commands, with orchestration deliberately kept outside the registry. The future split of `dispatch()` is a Pipeline (Chain of Responsibility) behind the same single entry point.
