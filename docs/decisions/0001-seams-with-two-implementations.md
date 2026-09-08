---
title: Every boundary is an interface with at least two implementations
status: implemented
date: 2026-09-08
pattern: Ports & Adapters
---

# Every boundary is an interface with at least two implementations

## Context

Switchboard started as a Slack bot that ran an agent. The first temptation in a system like that is to let the platform leak inward: Slack ids in the core, Slack markdown in the agent, Slack's threading model in the run store. Once that happens, the second channel, the second model provider, and the second place to execute commands each become a rewrite instead of an addition.

The core's job is to turn an incoming message into an agent run and a reply. Everything platform-specific about how the message arrived, which model answers, where tool commands execute, and where state lives is a detail the core should not know.

## Decision

The core never imports a platform SDK. Every place the core meets the outside world is an interface, and a boundary earns an interface only once it has two real implementations. Adding a capability means adding an implementation behind an existing seam, never a special case in the core.

The seams and their implementations today:

| Seam | Implementations |
|---|---|
| Channel (`ChannelIO`, `IncomingMessage`) | Slack, HTTP ingress, CLI, MCP |
| Provider | Anthropic, OpenAI-compatible |
| Executor | local, E2B, Cloudflare sandbox, resident |
| Agent | data: a registry of definitions, not classes |
| `MemoryStore` | null, in-memory, Worker-backed |
| `RunStore` / `RunLedger` | in-memory, file, Durable Object |
| `McpClient` / `McpToolSource` / `McpSecretStore` | streamable HTTP + in-memory; static, config, composite; in-memory, file, Worker |
| `OutputType` | markdown, json |
| `ChannelDirectory` | static, Slack |
| `GithubApi` | REST, fake |
| `SpanSink`, `Clock`, `SpanContext` | production and test doubles |
| Config source | path, `github://`, `op://` |

The rule has a counterweight: anything with one implementation and no second caller in sight loses its abstraction. An interface with one implementation is indirection, not a seam.

## Consequences

- A new channel or provider is one file plus configuration. The core does not change.
- Tests run the core against in-memory implementations of every seam, so the unit suite needs no network, no Slack, no model.
- Off-states are implementations too: a subsystem that is turned off is a Null Object behind the same interface, which is what lets the dispatcher stop checking for presence ([0018](0018-capabilities-computed-once-null-objects.md)).
- Contributors have to resist adding a third parameter to a core function when a platform needs something new; the answer is a richer interface, implemented on every side.
- The rule costs a small amount of ceremony per seam and forbids convenient shortcuts like importing the Slack client inside the dispatcher for one formatting call.

## Alternatives rejected

- **A Slack-shaped core with adapters bolted on later.** Every later adapter would have to emulate Slack's model. The HTTP ingress and MCP channels exist precisely because the core never assumed threads, reactions or blocks.
- **Abstract everything up front.** Interfaces with a single implementation rot into ceremony. The two-implementations rule is the test for whether a boundary is real.

## Pattern

Ports & Adapters (Hexagonal Architecture): the core owns the ports, the platform code owns the adapters. Strategy at the provider, executor and auth seams; Registry for agents, commands and schedules; Composite for tool sources; Null Object for off-states. Open-closed and interface segregation from SOLID.
