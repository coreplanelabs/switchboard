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

## Amended

Ordinary checkpoints retain the latest 128 sealed identity aliases. Alias edges do not pin predecessor archives or copy predecessor reference indexes. Each current seed retains its explicit external dependencies, while independent frozen child ranges keep their own pins. Normal archive expiry preserves an alias only while its checkpoint holder remains; explicit deletion invalidates dependent proof. Context beyond the retained window is omitted, and expired memory sources remain unavailable under the existing source-lifetime contract.

Current work observations and exact child-seed acknowledgements are private metadata on existing live and archived run rows. Simultaneous observations serialize their durable admission before model exposure. Current-state reads compare canonical state again before publication, with at most one tool-free revision in the same session and remaining budget. Restart checks bind original call/result bytes and do not reset that allowance. Historical committed status keeps its original meaning. A seed receipt binds the canonical brief, capsule, child, attempt and acknowledged seed bytes; it proves receipt of that seed, not that the provider executed it.

## Amended 2026-10-08

Re-evaluation: the original decision keeps source obligations with saved bytes and asks their existing owners for current authority. Review history lost its process-local validator state, while installation-only specialist results lacked requester-scoped receipts. Extending the existing versioned envelope and reconstructing acknowledged results preserves that reasoning; a second cache or stored permission boolean would not. Cross-run reuse and mixed-version readers are the regression boundaries below.

Review restart reconstructs original proven history from canonical source receipts and delivered session results. Native controller metadata binds the exact structured payload range and hash inside those results; model prose cannot create that binding. Restoration performs no external reads. A separate fresh GitHub read then checks current source authority, authoritative head and history fingerprint. Only matching complete delivery restores submission credit; partial delivery restores its original cursor. Missing, capped, changed or legacy evidence requires rereading. Fresh validation is recorded in existing run state and must repeat after another restart. The required-head target pin is acknowledged through the same state owner before model work. Accepted-verdict finish replay remains separate.

Version 2 of the existing dependency envelope and source receipt records installation-scoped results from an acknowledged read-only specialist run. The source binds normalized immutable admission, original tool input and exact delivered bytes. Execution validation loads the actual current live owner and rechecks its generation after native capability reads. It never derives execution scope from a message or handoff consumer. Every existing source and destination check remains in force. Each original repository must remain installed and its native read family must still succeed; empty global search results alone cannot establish current private access.

Version 1 behavior remains unchanged. Old readers reject version 2 rather than silently dropping its scope. Deploy readers/store support before producers; mixed-version execution may refuse reuse safely. No namespace, retention or stored-data migration is needed. Legacy missing provenance remains unproved. Main-agent, message, cross-run and changed-admission reuse stays denied. These checks preserve the original specialist read policy without broadening requester permissions, creating another store or turning an old receipt into a current grant.
