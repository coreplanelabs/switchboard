---
title: UUID-owned mount-free Resident restore
type: design
date: 2026-10-17
status: proposed
surveyed_at: edc98699e57f429266e16b6d51db16f14789824b
---

# UUID-owned mount-free Resident restore

Adopt this source design before the next PR review. The decision is within the existing PR writer's repair scope. The reader is an engineer who knows process isolation but has not read the Resident restore code. Merge, deployment and live acceptance remain separate gates.

A restore must have an operation UUID before effects, an enforceable original runtime boundary, and an original cleanup receipt before release. It must run automatically. Process names and a new operation UUID cannot establish ownership of old work.

The existing operation journal and native scope will own one archive download, extraction and installation. A fixed restore operation will download R2 bytes inside the original attempt cgroup without creating FUSE mounts. The controller will retain that attempt's cleanup receipt, and the journal will retain its verified copy before removing the pending effect. This costs a fixed native operation and a bounded receipt per restore; it removes host mount cleanup and process discovery from recurring restores. It does not adopt old SDK mounts or clear legacy debt.

## Today at the surveyed revision

| Fact | Source |
|---|---|
| The DO journal reserves an operation owner and private scope before effects. The controller binds a scope to its boot and places each attempt in a child cgroup. | `nativeOperation.ts::open`, `nativeScope.ts::ensureOperator`, `native-scope.py::launch` |
| The SDK restores a SquashFS archive with host FUSE mounts in presigned mode. Scoped trusted payloads have a read-only system filesystem and no mount authority. | pinned SDK `sandbox-Bk7fzLpy.js::doRestoreBackup`; `native-scope.py::prepare_view` and `launch` |
| Backup objects already use `backups/<id>/meta.json` and `data.sqsh`; local and presigned creation write the same format. Existing Worker cleanup owns this prefix. | pinned SDK `doCreateBackupLocal` and presigned creator; `worker.ts::deleteBackupObjects` |
| The pinned SDK already stores a restore UUID and runtime identity. Its public restore result exposes only success, backup ID and directory. Its local restore still runs host preparation and ignores archive cleanup errors. | SDK 0.13.0-next.751.1 public types and restore lifecycle implementation |
| The application already signs object GET URLs with `aws4fetch`. | `src/artifacts/store.ts::presign` |

The SDK source is the exact installed package, not an inferred private API contract. This design calls public R2 object APIs and the existing application-owned native controller. It calls no private SDK restore endpoint and changes no SDK version.

## The shape

This follows a write-ahead log: the DO records intent, the original runtime executes one attempt, and a durable receipt permits settlement. Unlike a generic job manager, it extends the existing native operation journal and cgroup attempt protocol. The DO remains the authority ledger. The controller's attempt record is the physical handle and original result readback, not another scheduler.

```mermaid
sequenceDiagram
  participant W as Resident Worker
  participant J as Existing operation journal
  participant C as Existing native controller
  W->>W: Validate metadata, expiry, archive size and ETag
  W->>J: Reserve restore UUID, original scope and archive descriptor
  W->>C: Launch fixed restore under that scope and UUID
  C->>C: Reserve physical attempt before effects
  C->>C: Isolated child downloads and extracts; parent installs without replacement
  C->>C: Retain original cleanup receipt
  C-->>W: Return receipt
  W->>J: Verify and retain receipt, then settle the same UUID
```

## Lost response during installation

A dependency restore first records its full UUID and original boot-bound operator scope. Its private archive and extraction directory derive from that UUID. A conditional R2 GET binds the download to the selected object's ETag and byte count. The fixed native operation extracts the archive, removes its archive bytes, and installs the tree without replacing an unexpected target.

If the controller stores the completed receipt but the reply is lost, the Worker reads that same original scope and attempt. Readback cannot launch work. It can settle only after it obtains the matching retained receipt. A controller restart, changed boot, missing receipt or changed descriptor leaves the outcome unknown and the original producer held. No new UUID repeats the restore.

There is a deliberate uncertain window after no-replacement installation and before the retained receipt write. If the parent fails there, no later scan guesses whether installation happened. The producer and deployment hold remain until original evidence is available or a separately qualified risk decision exists. This cost preserves the original unknown result; it is not a request to repeat installation.

If Hard Stop closes the attempt before receipt storage, the normal cgroup boundary kills its descendants and excludes late launches. A closed cgroup is physical ending evidence, not proof that installation or cleanup completed. The restore remains unknown without its original receipt.

## Where the design can be wrong

1. **The installation/receipt race.** The next section defines exactly when settlement is allowed.
2. **Archive identity and confined installation.** The descriptor and path rules below prevent a different archive or target from borrowing the UUID.
3. **Fallback and legacy compatibility.** Known pre-effect refusals must stay distinct from submitted unknown work.

## Original result and cleanup

The controller reserves the attempt descriptor before launching the fixed code. It uses the existing scope owner, boot validation, attempt cgroup and launch/close lock. The descriptor contains the backup UUID, target, size and ETag. Signed URLs are short-lived input; they are not retained in the journal or receipt.

The fixed operation receives no caller-supplied executable or shell command. Before effects, the controller creates `/workspace/.native-restore-<scope UUID>-<attempt UUID>` with exclusive creation and mode 0700. It records that directory's original handle with the existing scope and attempt. Occupied identity or a changed handle refuses; a pathname alone never grants cleanup authority.

The isolated child runs fixed `curl` and `unsquashfs` commands. Its filesystem is read-only, including `/workspace`, except the one admitted directory and its existing private scratch mount. The existing capability drop removes mount authority. Thus an extraction bug, path traversal or archive symlink cannot make the child write a neighboring workspace or system path. Normal archive symlinks remain data in the new tree; the child cannot use them to write outside its writable mount. It deletes its downloaded archive before reporting extraction complete.

The original controller parent performs installation after the child exits. It accepts only `/workspace/mirror`, `/workspace/checkout` and `/workspace/deps/.scratch-<full UUID>`. The image establishes `/workspace` as root-owned mode 0755. Before effects, the controller verifies root UID, no group/other write and no extended POSIX ACL on `/workspace` and the selected `/workspace/deps` parent. It refuses incompatible state without changing permissions. It opens that fixed parent with `O_NOFOLLOW` and retains the directory descriptor. Guest UIDs therefore cannot move the parent or select another parent through pathname substitution. It removes only an expected empty scratch target with `rmdir`, which refuses non-empty data. It uses `renameat2(RENAME_NOREPLACE)` to install the extracted directory; an unexpected target wins and is preserved. This is a fixed filesystem operation, not a privileged caller command.

The parent removes the original private directory only after it has no remaining archive or extraction data. Success requires that cleanup and installation both complete. A known failed result requires completed cleanup and an unchanged target. An interrupted cleanup or an uncertain installation produces no successful receipt.

The controller retains the receipt under the original scope and attempt in its existing protected state. The parent stores the receipt with exclusive temporary creation, file `fsync`, atomic rename into the existing controller state and directory `fsync` before it replies. This provides original same-boot readback after a lost transport reply. It does not promise persistence across destruction of the VM: a different boot or absent original state cannot supply a receipt. Readback validates the original owner, boot, attempt and descriptor and performs no effects. A receipt contains a schema version, the original reference, attempt UUID, backup UUID, selected target, size, ETag and closed result/cleanup facts. Its serialized size is at most 1 KiB.

The DO stores the verified receipt in the existing operation record and removes that pending attempt in one transaction. The ending archive retains that record. The existing 64 pending-attempt limit continues to apply; it is not a lifetime receipt count. The aggregate original record plus ending envelope must remain below the existing 64 KiB limit. Restore admission reserves space for its maximum 1 KiB receipt before effects. Every later attempt admission includes all pending receipt reservations in the same byte calculation. Capacity exhaustion refuses before launch; settlement never discards prior evidence. A lost storage acknowledgement requires exact original readback. A completed native process alone never settles the restore's pending effect.

## Archive and target identity

The Worker validates metadata from the backup UUID's existing prefix, including matching ID, positive byte count and valid expiry. It reads the archive head and signs a conditional GET for that exact ETag. The native operation verifies the downloaded byte count before extraction. A changed object refuses the transfer.

The temporary path contains the original scope UUID and admitted attempt UUID under `/workspace`, on the Resident disk rather than an assumed RAM-backed `/tmp`. The kernel mount restrictions above enforce extraction confinement. `unsquashfs` receives an absent output directory under that mount and uses no overwrite mode. The controller accepts no target path with `..`, a symlinked parent or a path outside `/workspace`.

The maximum expanded archive size is not known from the compressed metadata. This is an explicit remaining resource limit, not proof that every stored archive fits. The current code also extracts the full archive without an expanded-size limit. This design does not assume a compression ratio or claim a new disk quota. A pre-launch free-space check reserves the known compressed byte count plus the existing 128 MiB disk-full reserve (`src/execution/residentDisk.ts::DISK_FULL_FREE_KIB`). That check does not prove that expansion will fit. The disposable harness must prove that extraction failure, including ENOSPC, removes only the original private data or retains the original attempt as unknown if cleanup cannot finish. Existing disk admission and timeout limits remain in force. Measuring expanded size and peak free space is a rollout prerequisite, not a fabricated bound.

The normal full-workspace clean stops using broad SDK unmount/archive globs. If a selected cleanup target contains an inherited mount, it refuses instead of deleting through that mount. Original legacy SDK mounts require the separate original-owner recovery path. A new restore never claims to clean them.

## Serialize cleanup with restore intent

A producer claim alone does not protect an admitted target from existing service cleanup after an isolate reset. The existing operation journal must arbitrate these mutations before native effects. A pending restore stores its target and private UUID directory; a process that can delete or move those paths stores its mutation paths on its existing pending process attempt. The existing `beginThreadNativeOperation` and `NativeOperationJournal.begin` carry this footprint into the same pre-effect admission. Admission checks and insertion occur in the same DO storage transaction. Intersecting restore and mutation footprints refuse each other, including ancestor or descendant paths. No second lock table, manager or TTL is added.

An unattributed pending opaque effect cannot supply a safe target and therefore vetoes destructive workspace cleanup. A positively ended process releases only its physical mutation reservation; its original command result remains as known or unknown as the existing ending protocol states. An unresolved restore reservation releases only from its matching original cleanup receipt.

Apply this protocol to dead dependency lease cleanup, spare eviction and leftover sweep, restore/installer error cleanup, hydration/provisioning clean, and checkout swap. Those paths currently include cleanup before producer admission and volatile-map guards. Their new mutation reservations must commit before command submission so a concurrent restore cannot enter between a read-only veto and the delete. Normal user commands do not gain such service mutation authority.

Explicit reset remains a separate destructive boundary. It must refuse retained unknown work or use separately authorized destructive recovery; VM destruction is never converted into an original restore receipt, and ordinary source work does not authorize deleting retained journals.

## Why not the SDK handle or local mode

The SDK's backup UUID identifies stored bytes. Its internal restore UUID does not expose a public original cleanup receipt or enforced attempt handle. `localBucket: true` avoids new FUSE mounts but still calls host preparation and suppresses archive-cleanup failures. Neither public result satisfies the receipt contract. Calling private backend methods would also leave SDK lifecycle ownership uncertain.

A parent process scanner retains the same ownership-discovery problem. Recurring work instead creates the handle before effects. The existing experimental scan-based WIP stays preserved as evidence and is not a required part of this implementation.

## Fallback, proof and rollout

Missing metadata, expired metadata and an absent archive head are read-only refusals before native submission. The existing dependency installer can follow them. After submission, a lost response, invalid receipt or failed cleanup stays unknown. No exception name alone grants fallback.

Before review, isolated tests must prove conditional identity, expected bytes, target preservation, known no-start fallback, lost reply/readback, changed boot/owner/descriptor, cleanup failure and Hard Stop with a preserved neighbor. The disposable packaged Linux harness must exercise the real fixed restore operation and cgroup boundary. Cloudflare acceptance remains a live rollout gate; local tests do not establish it. The living Resident spec must replace its SDK mount-cleanup promise with these UUID and receipt criteria in the same PR.

## Source qualification amendment, 2026-10-17

The private directory includes both scope and attempt UUIDs. Binding transfer records each bounded append ID, offset and digest; a lost reply reads that original append instead of resending it. The fixed child uses the supported mount API to make every existing workspace mount read-only in its private view before making only its archive directory writable. This avoids a dependency on `mount_setattr` while preserving the recursive boundary. Source and target directory handles must be opened before the launcher changes its mount view; mixing handles from different views returns `EXDEV` even on the same backing disk. Installation still requires `renameat2(RENAME_NOREPLACE)`. No weaker replacement fallback is provided.

Explicit original-owner recovery reads a completed physical receipt or cleans the ended original attempt. It checks the journal hash before each settlement and retains the initiating recovery hash in the final ending receipt for readback. Read-only recovery never authorizes cleanup. A crash after native install but before its original receipt remains unknown. The initial local reproduction failed when scoped legacy extraction tried to remove the read-only SDK archive. The replacement is qualified with actual SquashFS and local HTTPS bytes in a disposable packaged Linux container. This does not qualify Cloudflare, expanded disk requirements, or legacy mount recovery.
