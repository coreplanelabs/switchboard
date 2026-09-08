---
title: Memory is off by default, byte-identical to absent when off, advisory when on, and gated on the way in
status: implemented
date: 2026-09-08
pattern: Null Object
---

# Memory is off by default, byte-identical to absent when off, advisory when on, and gated on the way in

## Context

Memory lets an agent recall distilled facts from earlier runs. It is also the easiest way to poison an agent: a fact written from one conversation shows up in another, and text a model wrote once becomes an instruction it follows later. Shipping it dark, provably inert, and with a narrow write path was the condition for shipping it at all.

## Decision

The whole memory path is flag-gated and off by default. When `memory.enabled` is false the dispatcher selects a `NullMemoryStore` and the request sent to the provider, its system prompt, messages, tools and budgets, is byte-identical to a build with no memory code at all. A test pins that guarantee.

When on, memory is context and never instructions. The injected block opens with `Background memory for <resource> (may be outdated — verify before acting):`, sits inside a `<background_memory>` fence folded onto the front of the system prompt and never into the conversation history, has every field stripped of control characters and newlines, and is costed against a hard budget at the rendered size.

Two gates guard writes:

1. **Reflection** only runs for runs that did real work: at least one tool call or four prior turns. A short toolless exchange is not distilled. A `review` run is never distilled however much it did, because its findings already land on the PR and describe one PR at one moment; distilling them floods the shared scope with per-PR ephemera.
2. **Authorization** asks the policy table ([0007](0007-authorization-policy-table.md)) `memory:write` for every candidate fact. A fact from a private channel or a direct message, or from a run whose origin visibility is unknown, is narrowed to the user's or channel's scope, never written at repository or organization scope. Denials log reason tokens, never fact text. Reads are never policy-gated.

Records are distilled facts, never raw transcripts. Retrieval matches whole tokens, and decay lives in the ranking score so stale records sink without a sweeper.

## Consequences

- An installation that never turns memory on runs exactly the code path it would run if the feature did not exist.
- Cross-scope leakage is prevented at write time, which is the only time the origin is known.
- Memory cannot be commanded ("remember this"); it is a reflection over work that happened. That is a deliberate limitation, recorded in the memory spec's rejected-alternatives list.

## Alternatives rejected

- **Always-on memory.** Every installation pays the poisoning risk from day one.
- **Raw transcripts as memory.** Unbounded, unsummarized and full of instructions.
- **Substring retrieval.** A one-letter token pollutes every lookup.
- **A sweeper for stale records.** Decay in the score does the same job with no scheduled job.

## Pattern

Null Object for the off-state, the pattern the rest of the codebase later generalized ([0018](0018-capabilities-computed-once-null-objects.md)). Feature toggles for the on/off axis.
