---
title: Capabilities are computed once at startup and every off-state is a Null Object
status: implemented
date: 2026-09-08
pattern: Feature toggles resolved once + Null Object
---

# Capabilities are computed once at startup and every off-state is a Null Object

## Context

Switchboard runs in three shapes: a laptop with nothing but a model key, a Cloudflare installation with every subsystem on, and everything between. Before this decision each surface asked for itself whether memory, run history, MCP tools, costs or residents were on, by reading `config.memory?.enabled` and its cousins wherever it needed to. The dispatcher was full of presence checks, the chat surface listed commands whose subsystem was off and answered "unavailable" when someone used one, and the reasons a subsystem was off lived in a different file from the rule that decided it.

## Decision

One `Capabilities` value, with an axis per optional subsystem (`execution`, `residents`, `memory`, `runHistory`, `runLedger`, `mcp`, `costs`, `schedules`, `github`, `ingress`, `dashboardAuth`, `docs`), is computed once at startup by `capabilitiesFrom(config, env)` and handed down as `CoreDeps.capabilities`. Every surface reads that value; no surface reads configuration for itself.

The value is pure, and its rules mirror the builders that select each subsystem's implementation. A test pins each axis to its builder so the two cannot drift, and a malformed block throws exactly where the builder would throw, never a capability silently read as off.

Every optional subsystem is wired as a real implementation or its Null Object: `NullMemoryStore`, `NullRunStore`, `NullRunHistoryWriter`, `NullLedgerWriteThrough`, `NullScheduleStore`, `NullFrictionLedger`, `NullMcpToolSource`, `NullCostsService`, `NullResidentAdminClient` (a Special Case whose every route answers `503` with the reason), `NullLlmCostSource`, `NullWebSearch`. Because of that, `CoreDeps.memory`, `mcp`, `runHistoryWriter`, `runLedger` and `threadsElsewhere` became required and the dispatcher's presence checks are gone.

Off is hidden, not refused. A command declares `enabledWhen` predicates over the capability axes; the surfaces derive what to list from those, so a hand-written list of "commands behind memory" cannot exist to drift. A handler's own `unavailable` answer remains as defense in depth for a dependency missing at call time, but it is never how a user learns a feature is off.

Dashboard authentication is one axis of the same value, `access | token | none`, as a Strategy behind one small interface.

## Consequences

- Adding a capability is one field plus the `enabledWhen` predicates that name it.
- The three installation shapes are three fixtures for the conformance suite, which runs every command against every shape.
- Callers never branch on presence, so a subsystem being off cannot produce an undefined-access crash somewhere the author forgot to check.
- Every new optional subsystem must ship its Null Object with it. That is more code up front and much less code everywhere else.

## Alternatives rejected

- **Scattered `if (config.x)` checks.** The smell this feature removed.
- **Listing off commands and answering `unavailable`.** Teaches users that features exist by refusing them.
- **Optional dependencies with presence checks in the dispatcher.** The bug class this design makes unrepresentable.

## Pattern

Feature toggles resolved once (Fowler); Null Object and Special Case (GoF; Fowler, *Introduce Special Case*); Strategy for dashboard auth; dependency inversion through `CoreDeps`; open-closed for adding an axis.
