---
title: Context keeps its original sources across conversations and child work
status: accepted
date: 2026-10-01
pattern: Information-flow control and immutable snapshots
---

# Context keeps its original sources across conversations and child work

## Context

The operator and execution already share durable storage, but a prose-only child seed, a per-agent conversation view or an unbound memory fact can lose evidence and the access conditions attached to it. Model interpretation should resolve intent; another phrase parser should not decide which repository the person meant. Source access still needs concrete, current proof.

## Decision

Use one typed `ContextDependencies` envelope alongside saved content through the existing storage seams. It retains original run identities, Slack receipts, MCP action references, repository access, memory scopes and committed unit status references. Merge is monotonic: missing legacy provenance stays unknown, revoked state cannot heal, and overflow is explicit. Immutable content snapshots bind their revision and digest. The envelope describes checks to perform; it grants no permission.

The current source reader composes `RunLedger`, `RunStore`, `MemoryStore` and artifact references. It captures saved bytes before their cumulative source metadata, resolves canonical original identities and asks the existing authorization and audience owners. Stored MCP actions are freshly inspected under their original owner, query and session. Repository reuse checks current access to the originally exposed repository names without requiring the README to remain byte-identical. A memory's storage scope remains an access dependency after its text is summarized or copied elsewhere.

Keep the actual admitted input envelope separate from cumulative retained/export context. Publication freshly validates a frozen snapshot of the seed and subsequent context admissions alongside existing live source checks. It retries once when a concurrent admission changes that snapshot, then withholds if proof remains unstable, unknown, missing or denied. Omitted old rows and live-only opaque results can leave retained context unknown without blocking a fresh answer whose actual inputs and live source checks pass. That retained unknown state still prevents later replay or export; omission never resets its obligations.

A context epoch under the thread's `@thread` session holds the shared conversation. Each row carries explicit metadata. Unproved rows can be omitted without hiding independently proved rows; role, author prose and a legacy empty receipt set do not manufacture that proof. Working execution logs keep their own indices, and coding and review keep their unit lanes. The run's `threadSession` marker connects these views without allowing connector appends to renumber an active model transcript.

A typed `ChildHandoff` freezes original source and consumer identities, acknowledged session window and digest, note snapshot, artifact cursors and ancestor dependencies. Completed tool exchanges and attachments survive; provider reasoning is removed and unfinished calls are labelled. Recall reloads original evidence through current source checks. A failed durable read cannot fall back to unproved prose.

An ordinary continuation may seal its acknowledged initial seed in the current canonical run. The receipt binds exact seed, actor, system, note and source revision, plus a hash and count of flattened ordinary membership in the existing retention index. Only origins with the same original authority are substituted. External leaves remain explicit; frozen rows and old handoffs are never rewritten. Readers validate this committed checkpoint directly rather than recursively following predecessor archives. Preparation alone grants no reuse, and a changed tail or source revision refuses normalization.

Frozen child and unit session ranges protect their tool results from byte trimming. The source store acknowledges that protection before canonical admission; holder removal releases it. Already trimmed bytes cannot be restored by a new pin.

Finish archives original source-action state and the latest complete session dependencies before removing the live row. Live and ordinarily retained holders keep existing referenced runs and sessions available. A pinned source does not become another retention root, and deleted sources are never recreated by a reference. Public run projections strip internal source bodies and raw context.

## Consequences

The model gets useful context without requiring the person to repeat repository syntax. Interpretation gates can be removed while the resolved actor, target, ownership, expected version and source audience remain checked by their existing owners. Compaction and restarts no longer decide which source obligations survive.

Fresh validation adds reads. Bounded envelopes and catalog windows can omit context, and legacy data cannot always be recovered safely. Omission is explicit and local to the affected context; it does not supply authority to a replacement source.

This decision does not create a second dependency database, replace the authorization table or unify every physical transcript into one mutable index. It does not claim deployment. Generic children, main-agent units and Ship share the frozen handoff. Queued units retain an immutable context capsule before workflow creation. Coordinator publication commits a report hash with the canonical unit outcome before freezing those bytes for delivery, and stores a separate allowlisted committed status row. Raw report prose remains unknown until complete producer proof exists. Repository briefs assist name inference; the main-DM configured-repository pilot authority remains unchanged.

## Alternatives

- **Pass a prose summary:** cheaper, but loses tool results, attachments and source obligations at the handoff.
- **Put every writer in one execution log:** shares context, but lets connector writes change indices owned by the running harness.
- **Reject every compacted or inherited context:** preserves isolation but discards context whose original sources can be checked.
- **Store permission booleans:** avoids fresh reads but becomes stale after a grant, source or destination changes.

The behavioral contracts are [saved operator context](../reference/specs/operator-context.md), [session log](../reference/specs/session-log.md), [run history](../reference/specs/run-history.md), [memory](../reference/specs/memory.md), and [child runs](../reference/specs/agent-conductor.md).
