---
title: A cold publication controller is a fresh sandbox, not an inspector
status: accepted
date: 2026-10-02
pattern: One-use isolated effect domain
---

# A cold publication controller is a fresh sandbox, not an inspector

## Context

The cold model owns root inside its sandbox. A different process or UID in that container cannot defend a credential from the model, and an inspection program or its output there can be replaced. Yet a typed runner-owned Git publication needs an effect bearer that the model cannot read. The existing Git Door binding and durable settlement already authorize and record the effect; the cold executor only lacks a transport outside the model container.

## Decision

Allocate a fresh controller identity in the Worker under a reserved Sandbox Durable Object name. Before obtaining any model sandbox, reject the entire reserved namespace on every model route, including the effect route's source selection. Never adopt the model thread's container as the controller. Export a capped Git pack from the model workspace without the effect credential; treat the pack, its claimed tip and the model's Git installation as untrusted. In the fresh image's repository, cap transfer and processing, validate the pack's objects and reachable graph, then push only the typed full tip and exact leased ref through the existing Git Door. The effect bearer lives only in the controller command environment; its own Git config ignores system and global config, disables hooks, and names the one Door origin. The Worker sends no command output or raw exception back, destroys the controller after one attempt, and never retries a possibly executed push. Lost answers remain for the existing durable settlement to reconcile.

This is a publication controller, **not** an inspection controller. It cannot attest the model sandbox's original process environment or birth. Cold credential inspection remains incomplete. Publication acceptance, inspection, revocation and adoption are distinct receipts.

## Consequences

- A cold publication temporarily needs one additional sandbox instance from the same capped fleet; if the platform refuses it, the effect refuses or remains uncertain instead of falling back to model exec.
- The capped pack limits the size of a single cold publication. An oversized graph is an explicit refusal, not an invitation to stream without bounds.
- The Worker and controller cannot manufacture owner/ref authority: the runner-owned effect and Door enforce it; the controller checks syntax, graph integrity and the exact lease.
- A source container with a corrupt or nonstandard checkout may be unable to export a pack. No bearer crosses back to repair it from within that container.

## Alternatives

- Run an inspector or Git push in the model sandbox as another UID: root can replace the process, config and its observations.
- Restore the model's filesystem in a trusted VM: hostile helpers, alternates and hooks would ride along with it.
- Infer publication from a matching remote head or resend on response loss: neither establishes the durable effect outcome.

## Amended

An established repository cannot export its entire ancestry under the pack cap for an ordinary next commit. For an existing ref with an ancestor old tip, the source packs each new commit with its complete tree and the old tip with its tree; the controller validates that bounded graph with the typed old tip as a shallow parent. For initial refs and rebased updates, the fresh controller obtains one shallow HEAD through the existing repository-bound Git Door read path using the effect bearer in its own environment, then supplies that verified immutable SHA as the export exclusion. The imported graph must join the fetched base before push; the Door's exact old-head lease (or empty-ref creation) still fences the write. No read grants extra writes. The existing Worker /publish RPC, controller fetchPublicationBase and publishControlled methods, and source exportPublicationPack are the only added transport seams: no new resource, credential or policy.

The source pack is capped at 16 MiB compressed, the controller at 128 MiB inflated and 50,000 objects, the controller process at 512 MiB memory and 32 MiB per file (16 MiB during fetch); fetch, export, import and push each have command deadlines. An oversized, missing or malformed graph refuses before the push command; response loss after push remains unknown. No shell fallback or model-visible effect bearer is permitted.

An existing branch can also have an unchanged tree larger than the transfer cap. If the complete-tree export fails, the controller now fetches that exact branch tip with `blob:none` and verifies it against the typed old SHA before using it as the export boundary. All base trees come from the trusted Door, so their omitted blobs are known remote objects; new source objects remain in a separate non-promisor pack. Import checks object integrity, and full strict fsck validates the combined graph before push, with network protocols disabled during validation and the fetch remote URL removed to prevent on-demand reads. A rebased update can still fall back to a verified default HEAD. This changes neither the transfer limits nor the exact old-head condition on the write.

The controller pushes a non-thin pack. Thin packing can read an omitted old blob to use it as a delta base, even when the receiver already has that blob. Keeping delta bases inside the outgoing pack allows publication without materializing unchanged base content or enabling lazy fetch. The real-Git regression checks that the old blob remains absent before and after a successful push; the transfer limits, strict graph validation and exact old-head condition remain unchanged.
