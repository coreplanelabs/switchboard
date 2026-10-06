---
title: Consumers read configuration owned by their immutable image identity
status: proposed
date: 2026-10-05
pattern: Immutable identity, explicit input witnesses and conditional publication
---

# Consumers read configuration owned by their immutable image identity

## Context

Publishing a new base document before changing the application image leaves an old-binary restart window. Validating with the publishing CLI does not prove that every image eligible to start accepts that document. A version read immediately before publication also permits a slow deployment to replace newer settings.

## Decision

A new state-backed consumer derives its configuration document from its own exact clean full build commit. The build artifact lives at a fixed root-owned, read-only location outside the writable application directory. Runtime variables and the permissive health build display cannot select that identity. The existing named ConfigDO documents and `state://` loader hold the consumer slots; no controller, image map, table or backend authority is introduced.

Legacy consumers keep reading the legacy base. New publishers stage and positively acknowledge the exact target consumer slot before activating its image. New state consumers never fall back to the legacy base. File-mode consumers retain their configured file path.

Input-source observations and target eligibility are separate facts. A legacy document, its full request witness and an unchanged native application pair can identify input data without declaring a legacy display commit to be an owned consumer identity. The publishing parser must identify its own source exactly. Direct configuration changes and restarts require an installed owned-slot receipt and the actual application and instance target to agree with that parser.

The existing document transaction compares both the frozen input-source version and the target version. Its response identifies the source predicate actually applied by the transaction. A missing or mismatched acknowledgement is unknown, including when an older server ignores a new request field. No retry or success fallback follows an unknown effect.

Before effects, immutable private input snapshots retain both full input-source and target request witnesses. These are data, not restoration authority. Final acceptance verifies the exact loaded target slot and re-reads the frozen input source. A source write during image activation requires the sole configuration writer to reconcile current settings; independent image and document services are not declared atomic.

Unknown prior consumers, file/environment source observations and unproved cold application absence decline before effects. A missing-slot boot may report its own immutable identity as diagnostic data while remaining refusal-only; it does not establish loaded configuration, readiness or recovery authority.

## Consequences

- Each image patch gets a distinct configuration slot through ordinary publication.
- Old images can restart during a partial rollout without reading the new format.
- Source drift refuses publication; target drift refuses activation or acceptance.
- The original configuration writer owns the cutover and any forward recovery.
- Private snapshots remain retained and bounded by the existing document size limit.

## Alternatives rejected

- A shared mutable base across incompatible images: retains the restart window.
- Desired Worker variables as image identity: the executing image can differ from the desired target.
- A declared compatibility class: does not prove parser, policy or model-registry compatibility.
- Automatic copying or restoration after an unknown effect: can erase successor settings and loses original-operation attribution.
