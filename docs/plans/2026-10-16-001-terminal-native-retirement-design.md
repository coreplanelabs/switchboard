---
title: Retire native work after a run ends
type: design
date: 2026-10-16
status: proposed
surveyed_at: bddc955f0e2fc84fa90accbed14106806b652303
---

# Retire native work after a run ends

Adopt this extension before implementation. The reader is an engineer who knows run history but has not worked on native isolation.

A cleanup request must stop only the selected ended run's original native scope, retain its workspace and history, and keep unknown command outcomes unknown. It must leave other runs alone.

An ended run can retain a native operation whose result was not observed. The existing per-run isolation can close that work, but the public cancellation route requires a live run. Add a separate terminal-purpose request to the same native scope and journal code. The receiver freezes the exact target and original journal before control, then stores physical closure evidence. This requires receiver support; a Memory-only permit cannot make an old receiver safe.

## Today at the surveyed commit

| Fact | Evidence |
| --- | --- |
| Memory cancellation preparation and readback require a live row. | `deploy/cloudflare-memory/worker.ts`, `prepareCancellation` and `cancellationPrepared` |
| Native scope closure is per owner generation and validates its original boot. It has a monotonic view/close continuation. | `deploy/cloudflare-resident/nativeScope.ts`, `NativeRunScopes.close` |
| Native scope retirement retains original journal bytes and marks original effects unknown. | `deploy/cloudflare-resident/nativeOperation.ts`, `retirement` |
| A scoped pending operation can have no SDK process tuple. Legacy process recovery cannot qualify it. | `worker.ts`, `run`; `nativeOperation.ts`, `recoverable` |

This extends the [existing isolation design](2026-10-14-001-native-launch-fence-design.md). It adds no process launcher, containment boundary or lifecycle manager.

## The shape

Use the existing write-ahead cancellation shape, with a separate purpose for an ended run. The new admin-only request names one original operation key, its fingerprint, and its full native scope reference. Older receivers reject the new route. Memory atomically prepares a terminal-purpose permit only for a canonical sealed run with no live row or restart marker. That durable permit also fences future claims of the same run ID. Resident validates the current owner and scope and freezes the scope's journal fingerprints in its durable retirement row. It writes the existing run execution fence before calling the existing scope close. It then credits retirement only when the same frozen journal and exact closed scope still match.

```mermaid
sequenceDiagram
  participant A as Authorized cleanup requester
  participant R as Resident
  participant M as Memory
  participant N as Existing native scope
  A->>R: Exact operation key, hash and scope
  R->>M: Prepare exact terminal permit; live run wins
  M-->>R: Durable permit and run-ID fence, or refusal
  R->>R: Freeze purpose, owner, scope, journal and run fence
  R->>N: Close that exact scope
  N-->>R: Exact closed, unpopulated receipt
  R->>R: Store physical retirement; retain original bytes
  R-->>A: Retired, original outcome unknown; or unconfirmed
```

## The hard case

Run A has ended. Its original native scope still has one pending operation with no process tuple. Run B is active in another scope on the same boot. An administrator names A's original key, hash and scope. Memory refuses if A still has a live row, is provisional, is not sealed, or is marked for restart. Resident refuses if the original owner or exact scope changed. Resident freezes A's journal and execution fence before control; B remains admitted. A late callback cannot rewrite the frozen original journal. If the close reply is lost, the journal remains held. An identical request reads the same durable preparation and continues only the existing scope's monotonic close protocol. A completed receipt can be read again without another native request. A changed selector never becomes a fresh control.

This proves physical shutdown separately from the outcome of the original command.

## Where the difficulty is

1. Freeze before effect, including journal callbacks and lost replies.
2. Qualify the terminal source and reject a conflicting successor before control.
3. Preserve existing cancellation and process recovery compatibility.

## Freeze before effect

The selected operation hash is an optimistic concurrency check, not a process identity. Resident validates the full scope reference against its existing scope row. The new receiver policy accepts at most 64 journal rows per scope. The current production distribution is unknown; a 65-row local refusal test will prove that the limit never selects a partial scope. The encoded preparation is also limited to 64 KiB so one durable storage value remains bounded. At most 64 rows qualify; a larger or incomplete inventory refuses before control. In one storage transaction it captures all journal rows for that original scope, stores a terminal-purpose preparation, and writes the existing per-run execution fence. Journal begin, identity, settle and close paths recognize the preparation: no callback can change frozen evidence. New operations and scope births for that run are refused.

`NativeRunScopes.close` gains an optional expected scope reference. It compares that reference in its first storage transaction, before any native request. This prevents an owner key whose stored scope changed from selecting another scope. Existing cancellation callers retain their current behavior.

The retirement validator accepts a terminal-purpose receipt only with its matching durable preparation, exact original fingerprints and an independently stored closed scope. Prepared or ambiguous work still counts as unresolved. The state transitions are `Memory prepared -> Resident prepared -> Resident closed`. Memory preparation commits the global run-ID fence. Resident preparation commits its journal snapshot and execution fence. `open`, `bindScope`, `begin`, `launched`, `settle`, `close` and every recovery write all observe that preparation in their own journal transaction: new work and identity writes refuse, while late settlement/close callbacks retain the frozen bytes. A retry with the same permit continues prepared work; a closed receipt returns without native traffic. Changed selectors or a different permit cannot replace the preparation.

Resident compares `runId`, `ownerGen` and `ownerFence` on each present registration, run fence and binding's `lastRunOwner`; the registration and binding must also name the selected thread. An absent row is permitted because the immutable original scope and canonical terminal permit remain required. A present malformed or foreign row refuses. These comparisons and all journal snapshots occur in one storage transaction.

The original operation bytes stay available, and the original command outcome remains `unknown`.

## Terminal authority and compatibility

Memory prepares and retains a purpose-specific permit from a live-first canonical sealed run in one storage transaction. The same transaction excludes an existing live row; every direct claim, queued live-row insertion, promotion and reclaim checks the permit fence in its committing transaction. This orders a late claim against cleanup rather than relying on the time between two reads. Missing, provisional, restarting, live or malformed records do not qualify. Memory checks raw stored markers before normalization, terminal status, exact identity, and finite `sealedAt` as an additional finish prerequisite; the seal alone does not prove native completion. Resident binds the returned run, thread and repository to the original journal and its selected owner. In the same Resident transaction that freezes the journal, it compares the stored registration, run fence and binding owner to the selected owner. A different owner or an incomplete owner record refuses before control. A later successor cannot enter the old scope: the durable run fence and the existing kernel close gate prevent it, while other run IDs keep their own scopes. It never writes a live row, calls Stop/Kill, finishes a cancellation, changes a run verdict, deletes a run, or removes files.

The new route is admin-only. It does not fall back to legacy SDK process recovery or the old cancellation route. An older Memory lacks permit preparation and causes refusal; an older Resident lacks the route and causes refusal. Ship receiver support and Memory permit support before using the control. After the first permit, rollback keeps Memory's run-ID fence reader; disabling the new route is safe, removing permits or downgrading that reader is not. Source checks do not prove live acceptance.

## Why not use the existing public cancellation route?

That route requires a live run and changes its outcome. Its older receiver also selects scopes by run before recording journal hashes. A fake live row or extra fields on an old ticket cannot supply the exact terminal authority required here.

Why not discard the journal because the review ended? A terminal review does not prove that its commands ended. Why not reset the container? Other scopes can still contain valid work on the same boot. Why not require an SDK PID tuple? Scoped native launches deliberately use scope and attempt identities instead.

## Validation

The implementation must prove exact cleanup with an active neighboring scope, canonical-source refusal, changed owner/scope/hash refusal before native control, lost reply continuation, immutable original bytes across late callbacks, fresh launch refusal, and receipt replay without another native request. It must also prove that ordinary cancellation and legacy process recovery still work. Include a queued refusal observation followed by a level rise and reclaim, so a second live-row insertion path cannot bypass the permit. These are local contract proofs; deployed receiver compatibility and live physical closure remain acceptance gaps until a containing release is deployed and an authorized test succeeds.
