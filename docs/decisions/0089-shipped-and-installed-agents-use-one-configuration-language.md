---
title: Shipped and installed agents use one configuration language
status: accepted
date: 2026-10-03
pattern: Declarative profiles with layered configuration
---

# Shipped and installed agents use one configuration language

## Context

Agent metadata lived in a TypeScript registry, installation model and effort maps lived in YAML, and operator, intake and reflection each read separate keys. Model fallback and effort fallback differed. A general-model change could silently move the front door, while an unlisted agent inherited no effort. The example configuration was not the production policy.

## Decision

Keep one shipped data document using the same schema as installation extensions. Installations declare `extends: builtin`, reusable named `profiles`, `agentDefaults` and `agents`. Model refs are provider-qualified; reasoning effort lives under `modelSettings.reasoning`. Maps extend recursively, scalars and arrays replace, and explicit null clears effort. Profile references are acyclic and checked at load.

Compile the installation document once and resolve all model callers through one seam. Internal callers are named operator, intake and memory. The operator has its own selected profile. Existing request, thread, user and channel settings remain above installation defaults. Machine placement, identity and routing eligibility stay registered capabilities. Instructions, named toolsets, limits and harness selection can extend registered model-loop agents; Ship remains a deterministic workflow with its own caps.

Keep builtin instructions and provider/tool implementations in code, referenced by the data document. Generate the editor schema from the runtime validator. Keep deployment policy in the installation repository and push the source document through the existing durable config path.

## Consequences

- Model and effort selection have one authoring format and one resolver; product defaults and installation policy use the same fields.
- Old installation documents retain their original fallbacks through a compatibility reader. Mixed legacy and DSL keys fail at load. A migrated document requires the supporting consumer release before rollout.
- Runtime projections retain legacy maps for existing interfaces without accepting them as a second authoring source in a DSL document.
- A new agent still needs a reviewed capability registration. Arbitrary prompt configuration cannot grant a machine, credential identity or routing eligibility.
- A future front-door implementation can consume the same operator settings without changing installation policy. That implementation change is separate.

## Alternatives

Independent maps for each caller preserve accidental coupling and inconsistent inheritance. A second DSL for installation overrides requires translation and allows the shipped schema to drift. Arbitrary file or network imports complicate a self-contained durable config document; this version supports only the shipped base and named profile inheritance.
