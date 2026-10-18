---
title: New MCP Reviews use their own request context
status: superseded
superseded_by: durable-review-context.md
date: 2026-10-16
---

# New MCP Reviews use their own request context

A new login can authenticate a new request while old private history remains unavailable. That history can contain GitHub results whose authority belongs to one original execution. A successful read of their bytes does not permit a new execution to inherit their authority.

For a new human MCP SSO request that explicitly selects Review and names one complete current-authored PR, use the existing authoritative execution path with empty history. The server records `contextMode: request` in the canonical source reference. The request digest and source authority retain this choice. Preserve the existing authority bytes when the marker is absent. Old receivers that cannot preserve it must refuse the record.

The one-door agent still decides. A hard gate permits only one matching current-request Review bind under operator mode `on`. Other actions, private-context reads and shadow/off modes cannot execute this request. Normal actor, repository, head, model, effort and occupancy checks still apply.

Its prompt explains that the current request supplies the complete target. Its tool list excludes private conversation and repository-history lookups. An attempted lookup uses the existing bounded repair. Admission checks occupancy again after target resolution and refuses a late owner before either inbox path. The configured-model deployment preflight includes this route.

The initial seed and checked history IO both stay empty. The new request has its own session and cannot inherit summaries, notes, artifacts, memory, saved selections or parent lineage. Earlier run metadata can establish occupancy, but cannot select work or a parent. A same-PR live or unknown owner still prevents competing work. An unrelated retained history record does not supply context.

The request epoch rechecks the exact current credential, directory binding, source context and configured policy. It does not observe old source policies because it consumes none of their content. Original execution, reply and confirmation paths retain their original credentials and records. A new request never supplies a verifier for an old digest.

This avoids a wider retained-result protocol. Such a protocol would need a distinct reusable read dependency, current source access checks and support through dependency merge, hashing, normalization and retention. It is unnecessary for a fully specified new Review that can fetch current GitHub data.

The [MCP ingress spec](../reference/specs/mcp-ingress.md#request-only-review-admission) binds the local proof. A containing deployment and a fresh real MCP Review with a posted exact-head verdict remain separate acceptance steps.
