---
title: Owned background native operations
type: fix
date: 2026-10-17
status: proposed
surveyed_at: 991f65feed92fb013da7625e49379092e7fc0e8d
---

# Owned background native operations

Adopt the existing native controller for non-run work before enabling its new operator owner variant. The reader is an engineer who knows the execution boundary but has not read the native journal.

A lost command reply must retain the original outcome as unknown. A positive ending can release execution debt only for the original owned scope. An external backup effect needs its own original acknowledgement. Neither result proves that an old HTTP request ended.

## Decision

Use a separate `kind: operation` reference with an actual `opOwner`. Reserve the producer, resource, call identity and operator scope in one Resident storage transaction before effects. Reuse the current controller's boot binding, launch group and close exclusion. Keep run references and terminal-run authority unchanged.

This is an extension of the existing original-owner journal, not a new execution service. It adds durable operator identity and ending receipts. It also adds retained metadata for each operation. Old identityless records remain held.

## Current behavior at the surveyed revision

| Constraint | Source |
|---|---|
| Five shared producers and the deterministic test/build entry use random operator owners without a native scope. | `deploy/cloudflare-resident/worker.ts`: `withSharedNativeOperation`, `withOpNativeOperation`, `runOp` |
| The run scope is reserved before bootstrap. Its controller compares the original boot and serializes launch with close. | `deploy/cloudflare-resident/nativeScope.ts`: `NativeRunScopes`; `native-scope.py`: `reference`, `launch`, `close` |
| Operator journals contain an owner and pending attempts. An empty ordinary close deletes the journal. | `deploy/cloudflare-resident/nativeOperation.ts`: `recordSchema`, `open`, `close` |
| A request permit spans its callback, but the test/build permit is inside the operator finalizer. | `worker.ts`: `withDeployAdmission`, `runOpTraced` |
| Backup creation and restore call the SDK without an opaque attempt. A restore failure can enter cleanup and replacement installation. | `worker.ts`: `takeSnapshot`, `backupDepsEntry`, `restoreWithProgress`, `restoreDepsEntry`, `materializeDeps` |
| System Git configuration is written during runtime setup. Native payloads see the system filesystem read-only. | `worker.ts`: `ensureGitSetup`; `native-scope.py`: `prepare_view` |

## The hard case

A dependency backup reserves an operator UUID and the stable cache source. The Resident commits that origin and an unstarted scope together. Before a process payload, it requests the controller's operator capability and binds the original kernel boot. An old controller returns no capability; the callback refuses before payload submission and closes its unstarted reservation. The normal run probe response stays unchanged.

A supported controller admits the caller-known process attempt into that exact scope. If its launch reply is lost, the caller does not submit the command again. Finalization closes the original scope. Its lock and frozen state exclude a delayed launch, including detached descendants. The Resident then archives the original journal hash, owner, reference and ending in one transaction before removing execution debt. A lost write reply qualifies only through that exact retained evidence. Unavailable or changed evidence stays held.

The backup SDK call has a separate opaque attempt before submission. Only its original positive acknowledgement settles it. Closing a process scope cannot settle an upload or restore. An uncertain restore does not authorize directory cleanup or replacement installation. Another automatic consumer of the same producer, resource and source is refused while original execution or an external effect is unconfirmed. A stable producer claim also survives an exact scope ending if any original payload result remains unknown. Known original settlement removes only the matching claim. Admission compares the claim in the existing Resident transaction; a new owner UUID cannot bypass it. A refused consumer closes only its own unstarted reservation.

## Where the difficulty is

1. Process ending and external effects have different proof. Preserve the opaque attempt even after the process scope ends.
2. The ending must precede release of the enclosing request permit. Keep test/build, refresh and independent background operations under that order.
3. Mixed Worker/image versions must refuse before payload work without creating new unresolved payload debt.

## Owner and request contracts

The operator reference has its own private storage namespace. It has no thread key, run ID, generation or run fence. A hybrid reference fails validation. The controller's only new input is this explicit owner variant; it gains no generic maintenance role or writable system filesystem.

Producer names are closed. Cache operations use the existing cache key as their stable source. Hydration and Git setup use their named maintenance source. A request records its generated call ID, actual known service role, parsed trace ID, resource and parent source. These fields are attribution, not authority. A service credential does not identify a human; no human identity is invented. The HTTP adapter creates trusted request context after its existing role check. Body fields cannot supply that context.

Unowned Resident callbacks receive an operator owner. Modern run callbacks still use their real run owner and existing run protocol. Shared work keeps an independent lifetime so cancellation of one consumer cannot stop maintenance needed by another. A detached dependency backup has its own request permit and scope, rather than borrowing an ended parent's permit.

Test/build now places its request permit outside operator finalization. A caller's original result or error survives failed cleanup, as the existing outcome-preservation contract requires. A retained permit stays held until exact operator ending evidence is readable. Its release receipt retains the original request origin and record hash. The recent release ring remains bounded by 128 receipts and 64 KiB. Eviction means unavailable evidence, never permission to replay.

## Ordinary ending and later recovery

An ordinary ending receipt retains the original journal and its SHA-256, scope identity, owner, callback disposition and `originalOperationOutcome: unknown`. An empty journal that never reached payload admission can use its atomically born reservation after a lost bootstrap reply. A pending attempt cannot use that exemption. The closed scope remains a used identity. No automatic expiry or pruning is added. Each native ending archive is at most 64 KiB; the closed reference adds a bounded row. A background producer also has one small claim row until all original payload results are known. Unknown claims have no automatic release path. An ending archive is limited to 64 KiB of serialized value. The closed scope and optional producer claim each use less than 512 serialized value bytes under their bounded fields. Keys and storage-engine overhead are additional; there is no pruning framework.

The existing Admin recovery method can reconcile a future attributed operator after a crash. It checks the original record hash, current resource and owner, and current request activity. Native closure requires the existing explicit termination option. Recovery uses only the original reservation and reference, or their exact retained ending. It cannot reserve a replacement scope, borrow a run owner, repeat a payload or settle an opaque effect. Its result says `operator-scope-ended`, keeps the original result unknown and says request ending is unobserved.

A legacy operator without the new before-effect origin and reservation continues through the old process-identity contract. Missing SDK identity remains unsupported. New metadata is never added to old rows to qualify recovery. Different-kernel handling follows the existing owned-scope epoch contract; it does not retire unbound SDK work.

## Alternatives

**Metadata alone** identifies a producer but cannot exclude a delayed SDK launch or identify the process group to close after a lost reply.

**A synthetic run owner** would borrow cancellation and terminal-run authority that maintenance does not have. A separate owner variant keeps those contracts strict.

**Retrying the payload or deleting old holds** cannot establish the original outcome. Neither is a recovery mechanism.

**A new writable-root maintenance role** is unnecessary. The fixed mirror `safe.directory` setting belongs in the existing image Git configuration. Runtime setup then writes only the already permitted workspace paths.

## Open compatibility boundary

The proposed adoption is not ready to release for SDK-mounted restores. The SDK creates FUSE mounts in the host mount namespace. Native payloads use a private mount namespace without mount authority and see `/var/backups` read-only. The existing extraction script therefore cannot remove original host mounts or archives from that payload. Its best-effort unmounts do not prove host cleanup.

The inspected SDK exposes no public backup-mount cleanup acknowledgement. `cleanupMountDirectory` refuses mounted paths; `unmountBucket` requires its separate bucket registry. Neither proves cleanup of a backup restore. Do not fall back to an unscoped SDK process, add a generic privileged role or claim the current local controller proof covers this boundary. This boundary needs a narrowly validated original restore cleanup contract before release.

## Validation and rollout

The living [Resident spec](../reference/specs/resident-repos.md#native-operation-recovery) binds the producer, mixed-version, ending, opaque-effect and refusal cases to named tests. The existing disposable Linux qualification runs the packaged controller and checks physical group exclusion, neighboring scopes, late launch refusal, owner separation and read-only system configuration. Local Linux proof does not establish Cloudflare acceptance.

Ship the matching Worker and image through the normal guarded release. An old image refuses operator payloads; it does not fall back to the SDK. Preserve existing lifecycle and deployment owners during image reconciliation. Rollback keeps new rows and receipts intact and must not reinterpret them as legacy authority. Deployment, current-image capability and live acceptance remain separate gates.

## Restore boundary amendment, 2026-10-17

The [mount-free restore design](2026-10-17-002-uuid-owned-mount-free-resident-restore.md) replaces recurring SDK restore adoption with the existing UUID journal and controller. This preserves the decision above: unknown effects stay held, physical scope closure alone cannot settle an archive, and request ending remains separate. It removes the need for host FUSE cleanup in new restores. Existing SDK mounts and identityless historical work remain separate recovery obligations. The proposed source repair and local qualification do not grant release or live acceptance.

## Scheduled work amendment, 2026-10-17

Scheduled provisioning uses the same durable shared-operation wrapper as hydration and cache work before cleanup or cloning. Its stable `provisioning` producer claim prevents a new schedule delivery from replaying unknown original work. The callback checks its saved resource and rechecks onboarding after admission. Builds select the existing native user role directly, so the build account can write its home caches while system paths remain read-only. These changes extend coverage of the original ownership decision; they add no manager or privileged cleanup path.
