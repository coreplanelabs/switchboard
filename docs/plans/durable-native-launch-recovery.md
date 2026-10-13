---
title: Durable native launch and recovery - Plan
type: fix
date: 2026-10-12
status: proposed
---

# Durable native launch and recovery

## Decision

Keep native admission and settlement in `NativeOperationJournal`, execution in the existing executor, and runtime loss in the existing lifecycle. Close the avoidable launch and storage acknowledgement gaps there. A lost launch response cannot be retried safely until the runtime supports a caller-known launch key and an authoritative receipt lookup. No new manager or workflow service is needed.

This plan separates a working source slice from a provider prerequisite. It does not declare all native attempts recoverable, or permit removal of old unknown holds.

## Current contract and gap

| Boundary | Existing behavior | Required result |
|---|---|---|
| Admission | A random attempt ID is persisted before native submission. A failed transaction acknowledgement can hide a committed attempt from its caller. | Read back only the original key and locally retained attempt ID. A matching committed admission can proceed through the existing scope check. Missing, changed or unreadable evidence refuses submission. |
| Acknowledged launch | The public SDK descriptor has an ID and PID. Full identity requires a separate `status()` RPC. | Record the original full identity before unrelated storage work. If status or identity persistence fails, collect only the acknowledged original handle. A known terminal result may settle that exact attempt; an unknown result stays held. |
| Identity write | A transaction can commit before its caller receives an error. | Read back the exact full tuple after an uncertain write. Never overwrite it with another tuple or relaunch the command to recover storage. |
| Lost launch response | Native start can precede a lost response or the SDK's post-start runtime validation failure. | Keep the admitted attempt unknown. No automatic execution retry, guessed PID, process-list matching or current-runtime adoption. |
| Recovery | Exact native results can settle fully identified process attempts under record-hash and owner checks. Opaque effects and missing identity refuse. | Preserve these checks. Runtime retirement and process completion remain distinct results. |

The audited pin is `@cloudflare/sandbox@0.13.0-next.751.1`. Its public `ExecOptions` contains only `cwd`, `env` and `timeout`. `Sandbox.exec()` calls native `processes.start`, then returns a descriptor with `id`, `pid` and a capability. The runtime runner validates its lease after the start callback, so an error can hide a successful start. The full `startedAt` is not in that descriptor. Private SDK methods are not an integration seam.

The inspected `0.13.0-next.776.1` package has the same launch options. Stable `1.0.0` moves command execution to the Container API and is a separate architecture migration. Neither a version bump nor changing libraries alone proves deduplication. Keep the SDK and image pair pinned while this prerequisite is unresolved.

## Smallest supported runtime extension

The following is a proposed provider contract, not an API supported by the pinned SDK:

1. Establish and expose an immutable original runtime witness without submitting the command. Bind the journal attempt to that witness before launch. If waking selects a different runtime, refuse the old target; do not silently adopt it.
2. Accept the journal's caller-known attempt ID as the launch key, scoped to the exact resource and runtime witness. Bind it to the immutable launch payload, including argv, working directory, environment and timeout. The runtime compares the exact payload or a protected canonical digest; it must not expose commands or credentials in stored diagnostics.
3. Atomically reserve the key at the native start boundary. Concurrent and repeated identical requests return the same original launch/result receipt. Changed payloads under the same key refuse. A runtime crash between reservation and spawn stays explicit unknown unless the runtime can authoritatively reconcile it; it must not start again to hide that gap.
4. Provide a no-wake lookup by resource, original runtime and launch key. Distinguish never submitted, accepted with unknown result, started with full process identity, terminal with original result, and original runtime retired. An absent lookup row is not a no-start guarantee while an earlier launch remains in flight. A definitive no-start result must fence delayed submission of that key before it can authorize another attempt.
5. Return the original runtime witness and full process identity in the launch receipt. Keep terminal receipts and used-key tombstones for the whole journal recovery lifetime. Expired or lost retention returns unavailable and retains the hold; it never permits key reuse. State the retention and provider lineage guarantees explicitly.
6. Keep retries capability-gated. Only a runtime that proves this contract may accept the same launch key again. A logical ID in Worker storage alone cannot deduplicate native execution. Opaque external effects need their own service-enforced idempotency or reconciliation even after a process ends.

The SDK must expose the same contract publicly; extending only the TypeScript options cannot supply native atomicity. Returning full identity in the first response reduces one RPC but does not solve a lost response.

The proposed public seam has three operations: prepare an immutable runtime-bound launch request, submit it with its original key, and inspect that key without waking or submitting work. A launch receipt contains the original key, protected payload digest, original runtime witness, phase and, when known, full process identity or supervised-group terminal result. Lookup returns an explicit unavailable result when retention or original-runtime evidence is missing. Cancellation uses the original receipt and existing ownership fences, not a current PID probe. This is a contract sketch, not an invented callable API.

Implement deduplication in the native start service, before it creates any process. The SDK forwards the public key/runtime binding and returns the complete native receipt without stripping start identity. Its no-wake lookup reads that same service's retained receipt. Switchboard stores the request/receipt in its existing journal and keeps using the SDK's complete supervised-group status. Native reservation/spawn recovery must expose the unknown interval; the implementation must not erase it with another spawn.

## Two implementation paths

| Path | Scope and proof cost | Disposition |
|---|---|---|
| Public SDK/native keyed start and receipt lookup | Extend the native start service and public SDK together; prove atomic duplicate admission, immutable payload/runtime binding, crash boundaries, retained receipts and complete group endings. Then adapt the existing journal and Worker producers, with a fake provider boundary plus actual supported runtime tests. No executor architecture change. | Smallest complete seam. Requires upstream source/API support; it is not available in either inspected preview package. No upstream publication is implied by this plan. |
| Image-owned keyed receipt helper over supported exec | Add a protected runtime receipt tree, atomic claims/fsync, child start barrier, a distinct Linux identity type, no-wake reader, retention/custody and command/output/timeout compatibility. Each wrapper and probe also needs original native ending evidence. | Held after independent design review. A helper inside the SDK supervised group cannot certify that whole group has ended before it exits. Moving it outside or adding a reaper creates a new supervisor. Payload dedup alone also leaves duplicate wrappers unknown. Do not implement this candidate as a narrow launch fix. |

The provider extension is a prerequisite to complete reconciliation, not a reason to replace the existing executor or adopt another workflow engine. An upstream implementation must publish its supported API and matched image/SDK pair before Switchboard enables same-key submission. Keep the current pin and fail closed until then.

This follows [EC2 client-token semantics](https://docs.aws.amazon.com/ec2/latest/devguide/ec2-api-idempotency.html): repeated matching input is idempotent only in the documented scope, and changed input refuses. [Temporal's activity contract](https://docs.temporal.io/activity-definition) also requires the external service to enforce an idempotency key; durable orchestration alone does not prevent duplicate effects. These are reference contracts, not proposed dependencies. The pinned [Sandbox preview process API](https://81fab744.previews.developers.cloudflare.com/sandbox/1-0-preview/api/processes/) provides process lookup only after its ID is known.

## Bounded recovery with the current pin

Use exact durable readback for storage acknowledgement loss. For a fully identified original process, use the existing hash- and owner-checked native recovery route; terminal observation releases only the exact record. If the original result is unavailable, return a bounded refusal and keep the hold. Do not retry execution to produce a replacement result.

For missing launch identity, report the retained attempt as unknown and the unsupported lookup prerequisite. A future provider lookup may resolve it only if the original submission was already bound to that contract; new capabilities cannot backfill historical evidence.

An explicit runtime-retirement action uses the existing backup-preserving recreation boundary. It requires original runtime attribution or independently qualified provider lineage for every selected attempt, complete shared custody and loss scope, a durable immutable action/cohort identity, preserved original rows, and a persistent maintenance gate. Archive preparation keeps active holds. Persist physical request intent before one trigger. Lost destruction replies keep the gate and never resend against a successor. Only confirmed original-runtime destruction plus row/owner/hash CAS can move the exact closed process-only cohort to a distinct retirement receipt. Keep `originalOperationOutcome: unknown`; process ending cannot settle opaque remote effects. Old unbound rows refuse before destruction. Backup purge is not this recovery path.

## Proof and rollout

Use the existing Worker and journal tests with injected external and storage failures. Assert literal durable rows, returned results and exact refusals, with a neighboring successful path. Required cases:

- Admission rollback versus commit followed by lost acknowledgement; failed readback; scope closure while admission waits; unchanged unrelated attempts and ownership.
- Original launch acknowledgement followed by status failure, malformed status, unrelated bookkeeping failure, identity rollback or identity commit followed by lost acknowledgement. Collect only the original handle and preserve unknown outcomes.
- Lost launch acknowledgement after a synthetic native start. One execution, retained unknown admission, and exact recovery refusal; no invented full identity.
- Exact process recovery after restart, changed tuple/owner/hash refusal, and opaque-effect hold retention.
- For the future provider: concurrent same-key requests, changed payload, delayed requests after no-start fencing, runtime replacement, crash at each reservation/spawn/receipt boundary, retained tombstones and unavailable lookup. Synthetic adapter tests cannot establish native provider acceptance.
- For retirement: original/current runtime mismatch, incomplete custody, mixed opaque effects, changed cohort, archive failure, lost destruction reply, restart, post-destruction persistence failure, and backup preservation. Do not use production mutation to fill a proof gap.

The working launch/storage slice uses existing version-1 journal records and public routes. No historical ID or runtime backfill is allowed. Retirement schema and control integration are a separate qualified source slice. Land source and specs with targeted tests and scoped gates; CI owns full suites. Review must bind the exact PR head. Merge, containing release, deployment and authorized provider acceptance are separate stages. Rollback must keep journal data and holds; it cannot replay uncertain work or erase evidence.
