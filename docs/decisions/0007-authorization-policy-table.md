---
title: Authorization is one policy table over a closed condition vocabulary, asked once per request
status: implemented
date: 2026-09-08
pattern: Rules table
---

# Authorization is one policy table over a closed condition vocabulary, asked once per request

## Context

Before this decision, permission lived in several unrelated places: a gate on each chat command, a scope list on each machine token, a channel pin for machine callers, and a handful of helpers (`canRunAgent`, `canUseRepo`, `isOperator` and their siblings) called from wherever someone remembered to. Each surface answered "may this caller do this?" in its own words. The predictable results were that the HTTP surface and Slack disagreed, that adding a command meant remembering four checks, and that nobody could read the whole policy in one place.

## Decision

There is one decision function, `authorize(actor, action, resource) → allow | deny(reason)`, evaluated over a policy table of data rows. Each surface resolves identity once into a typed `Actor`; every gate is a row; channel visibility is the relation `member-of(actor, channel)` and holds identically on every surface.

Rules of the table:

- Rows for the same `(action, resource)` are ORed; the `when` conditions inside a row are ANDed; no matching row is a deny. The default is closed.
- The condition vocabulary is closed: `has-grant`, `member-of`, `is-self`, `owner-of`, `all-channels`. `validatePolicy` runs on import, so a rule with an unknown condition kind, resource type, actor kind or visibility, or a condition on an attribute its resource cannot carry, fails at module load rather than at request time.
- Channel and repo sets are literal ids, never wildcarded, so a `channels-in` predicate is always a plain `IN (...)` a store can execute.
- List reads compile the same rows into a `Predicate` (`none`, `all`, `channels-in`, `repos-in`, `user-is`, `visibility-in`, `and`, `or`) that is pushed into the store, so a listing and a single read cannot disagree. `predicateFor` is callable only from store adapters.
- Deny reasons are short machine-readable tokens carrying no resource id or attribute. They go to the audit line, never to a reply.
- `write` never implies `exec`, and no action authorizes an agent run ([0002](0002-dispatcher-is-the-only-orchestrator.md)).

Configuration is one `grants` shape (actor id → actions, channels, repos, with `all` explicit and an absent axis meaning empty) plus a `restrict` block that closes agents and repos unless granted. The predecessors, per-command gates, token scopes and the `permissions` block, were translated for one release and then removed.

## Consequences

- The whole policy is readable in one file, and a test enumerates every action against a fixed actor set on every surface.
- A denied read of a run is `not_found`, so a caller learns nothing about what exists.
- New requirements must be expressible as a row with the existing conditions. That is a feature: the stop condition for this design is a requirement that needs an external policy engine to express, and reaching it would be the signal to adopt one rather than to grow the vocabulary ad hoc.
- Channel membership must be knowable within a request budget. If a platform ever made that impossible, `member-of` would need a cache with a staleness policy.

## Alternatives rejected

- **Keeping per-command gates and token scopes.** The form the table replaced. Their intent (machines get their own gated identities; a token must not read another team's runs) is preserved as rows.
- **An external policy engine (Cedar, OPA).** More power than any current rule needs, a second language to learn, and a second process to run.
- **Wildcards in channel and repo sets.** Would turn store predicates into pattern matches the stores cannot push down.

## Pattern

A rules table for authorization, evaluated by one function. Strategy at the identity-resolution seam per surface. Fail-closed by construction.
