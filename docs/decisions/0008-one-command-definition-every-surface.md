---
title: A command is defined once and every surface is derived from it
status: implemented
date: 2026-09-08
pattern: Registry
---

# A command is defined once and every surface is derived from it

## Context

Switchboard exposes the same operations over chat, a CLI, an HTTP API and MCP tools. The naive implementation is four things per command: a chat parser branch, an argv parser, an HTTP handler and an MCP tool schema. They drift the moment someone edits one and forgets the other three, and each one hand-writes its own copy of "runId is required".

## Decision

A command is one typed TypeScript definition, `defineCommand({ id, args, options, action, resource, effect, surfaces, describe, handler })`, with zod-typed positional arguments and camelCase options. Every surface is derived: the chat grammar, the CLI subcommand and its `--help`, the HTTP route `/api/<group>.<verb>`, and the MCP tool `<group>_<verb>` with its `inputSchema` generated from the same zod schema. Adapters carry transport and case mapping only, and all surface naming lives in one file.

`invoke` runs one fixed order on every surface: authorize (403) → parse (400) → handle → map. Authorization comes before parsing so an unauthorized caller learns nothing about the schema.

Since the registry landed there is no legacy chat parser and no standalone CLI script. The registry is every command there is. The two things that start an agent run are channel built-ins, not registrations ([0002](0002-dispatcher-is-the-only-orchestrator.md)).

## Consequences

- One schema is the single source of truth for validity, help text, the MCP input schema and the validation error on every surface.
- A conformance test enumerates the registry without naming any command. From each command's zod declarations it derives the cases (required-only, all options, each enum value, boolean true and false, a type mismatch per field, embedded quotes, an unknown option, a missing required argument), spells each the way each surface does, drives the real adapters, and asserts the same parsed `{args, options}` everywhere. A new command that lacks fixtures fails loudly. The same suite carries a capability axis and an authorization axis over a fixed actor set.
- Surfaces cannot have bespoke commands. A behavior that only makes sense on one surface still has to be a registry command with a `surfaces` list, which keeps the registry honest about what exists.

## Alternatives rejected

- **Per-surface implementations.** The drift described above, already observed before the registry existed.
- **A code generator emitting four artifacts.** Generated files to keep in sync and a build step, where a runtime derivation from one object needs neither.

## Pattern

Registry. The open-closed seam: register once, available everywhere, with the adapters closed to change.
