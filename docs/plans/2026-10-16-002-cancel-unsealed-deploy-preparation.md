---
title: Cancel deployment checks before upload is allowed
type: design
date: 2026-10-16
status: proposed
surveyed_at: a7a60a92d5dfa2c66597878220ba82f479a7f98c
---

# Cancel deployment checks before upload is allowed

This record defines the source repair and its acceptance boundary. The reader is an engineer who knows deployment but has not worked on the Registry fence. The maintainer owns the source decision; this record grants no live delivery or recovery authority.

A deployment check can persist its fleet fence and then lose its request before it finishes reading activity. The client stops waiting after 15 seconds, but the original fence remains. Add one durable acquisition identity and a one-way readiness seal to the existing Registry for ordinary deployment checks. Cancellation can withdraw only that unsealed acquisition; a lost sealed reply stays unknown. This costs one capability read, a retained preparation record and up to 15 seconds of failure cleanup, while keeping native work, upload guards and existing staging/force/bootstrap protocols intact.

## Today at the surveyed commit

| Fact | Evidence |
| --- | --- |
| `handleDeployFence` awaits `setDeployFence` before its `try`, then reads every Resident. A stalled read can outlive the client. | `deploy/cloudflare-resident/worker.ts`, `handleDeployFence` |
| The ordinary client uses one 15-second timeout and sends no production acquisition identity. | `deploy/cloudflare-resident/preflight.mjs`, `fetchResidents` |
| The Registry installs and verifies a fence in transactions. Its old clear and verify calls select only drain times and Worker version. | `worker.ts`, `setDeployFence`, `clearDeployFence`, `verifyDeployFence` |
| Upload readiness still needs the existing obligation and maintenance calculation and at least 20 minutes of drain reserve. | `worker.ts`, `verifyDeployFence`; `src/core/budgets.ts`, `DRAIN` |
| The Worker advertises native capability through `/healthz`. Its template has no incoming request-signal flag, and its handler neither consumes `request.signal` nor forwards the incoming Request to `fetch`. | `worker.ts`, default `fetch`; `deploy/cloudflare-resident/wrangler.template.jsonc` |

This extends [the existing deployment fence](../decisions/0086-deploy-fence-separates-execution-from-workspace-retention.md). It does not create a second deployment controller.

## The shape

Use a two-phase preparation in the Registry that already owns the fence. Unlike a deployment transaction, its final commit only seals readiness; it never starts an upload. The client creates one UUID for its preflight invocation and prints that ID before its first mutation. The existing drain bearer remains the authority. The ID selects the exact original acquisition; it is not a credential or a proof that a request ended.

The new authenticated prepare route records `preparing` together with its fence. After all existing activity reads finish, a Registry transaction verifies the same acquisition, current producer and ordinary readiness predicates, then records `sealed`. A cancellation transaction changes only `preparing` to `abandoned`, keeps an immutable disposition, and removes only that acquisition's fence fields. It retains the ordinary drain and every work record. An abandonment that arrives before preparation records a tombstone, so the delayed preparation cannot install a fence afterward.

```mermaid
sequenceDiagram
  participant C as Original preflight client
  participant W as Resident Worker
  participant R as Existing Registry
  C->>W: Prepare acquisition A
  W->>R: Install A and preparing fence atomically
  R-->>W: Original fence, or lost acknowledgment
  W->>W: Read existing activity and obligations
  C--xW: Client disconnects before readiness
  W->>R: Abandon A through waitUntil
  R->>R: preparing to abandoned; retain ordinary drain
  W->>R: Late attempt to seal A
  R-->>W: Refuse abandoned identity; no upload permission
```

## The hard case

Acquisition A commits its fence, but the Registry reply is lost. The Worker cannot name the returned fence tuple. After 15 seconds, the client stops waiting. The Worker already registered the incoming abort listener, so it submits abandonment by A's identity through `waitUntil`. The Registry finds A without that lost reply, compares A's full stored fence and producer, and removes only A's fence fields. A later attempt to seal A refuses.

The opposite ordering is also safe. If a different cancelled request B reaches the Registry before its delayed prepare transaction, abandonment first stores B's tombstone. B's prepare transaction then refuses instead of installing a fence.

If sealing wins the transaction race instead, abandonment refuses. Even if the client never receives the ready reply, A stays sealed and the result stays unknown. This boundary does not infer that upload never started.

## Where the difficulty is

1. Order cancellation against preparation, sealing and older tuple-only controls in the same Registry.
2. Keep uncertain sealed replies and client retries from granting upload permission.
3. Keep request cancellation local to this protocol during mixed-version delivery.

## Exact acquisition ownership

The new drain-scoped HTTP surface is `POST /prepare-deploy-fence`, `POST /abandon-deploy-fence-acquisition`, and `GET /deploy-fence-acquisition?id=<uuid>`. Preparation and abandonment accept only `{id}`. The new preparation refuses held staging maintenance. Registry methods are `prepareDeployFenceAcquisition`, `sealDeployFenceAcquisition`, `abandonDeployFenceAcquisition`, and `readDeployFenceAcquisition`.

The durable row `deploy:fence-acquisition:<id>` contains `schema: 1`, `purpose: deploy-fence-acquisition`, `id`, receiving Worker version and build, phase, and the original drain and installed fence when preparation occurred. A recorded abandonment retains those snapshots and its disposition. The new drain field is `swapAcquisitionId`. The 8-KiB encoded-record limit is a new conservative policy: ordinary preparation has no image holds, its existing reason/by bounds are 200/80 characters, and two small snapshots plus identity fit within that cap. Oversized or malformed authority refuses before installation, sealing or removal; it is never truncated.

Preparation uses a new Registry RPC name. An older Registry must refuse that method before mutation; adding an ignored argument to the old RPC would let old code install an untracked fence. The new method and existing `setDeployFence` share the current installation transaction logic. The new method does not consume a staging window. No caller-supplied version substitutes for the Registry's own version metadata.

### Exact comparison contract

`originalDrain` is the raw stored object before installation. Its allowed fields are `since`, `until`, `by`, `reason`, and optional `holds`, `holdsUntil`, `liftAsked`. The four base fields are required; time fields must be finite ISO timestamps, holds must be an array of strings, and liftAsked must be boolean when present. Unknown keys and any existing fence-field presence refuse. The current live-drain and upload-reserve predicates still decide eligibility.

`fencedRecord` is the complete raw object actually written by the shared installation logic, including `swapFence: true`, `swapBuild`, `swapVersion`, `swapAt`, and `swapAcquisitionId`. It records the presence or absence of every optional ordinary field. Seal and abandonment compare the complete allowed key set and values, including hold-array contents; absent, malformed and contradictory fields are different states. They never compare normalized `liveDrain` projections.

The record's ID must equal both its storage-key suffix and `fencedRecord.swapAcquisitionId`. Its receiving version must equal current Registry `CF_VERSION_METADATA.id` and `fencedRecord.swapVersion`. Its build must equal current `BUILD_ID` and `fencedRecord.swapBuild`. The selected HTTP Worker must report that same producer. These checks and the phase read occur inside the committing Registry transaction. A changed producer or raw fence refuses without changing the acquisition or drain; the caller keeps UNKNOWN.

`liveDrain` must preserve selector presence through projections. It keeps strings and uses a non-authorizing `null` marker for other malformed values; it never drops the property. Code that credits an acquisition validates the raw stored value strictly. Code that refuses legacy control checks presence, not validity. This keeps image/hold rewrites and their RPC results serializable without turning corrupt data into authority.

### Closed transition table

| Original state and action | Required result |
| --- | --- |
| No acquisition row; prepare with an eligible ordinary drain | In one transaction, save the original drain and exact installed fence and write `preparing`. No ready response yet. |
| No row; abandonment wins before preparation | Save an `abandoned` tombstone for that ID and producer. Touch no drain. A delayed prepare refuses. |
| Any retained ID; fresh prepare | Refuse reuse. Reading its history never supplies another deployment's readiness. |
| `preparing`; seal | Require exact raw ownership and unchanged existing readiness predicates in the same transaction; write `sealed`. A changed, missing or unreadable fence refuses. |
| `preparing`; request cancellation, ordinary activity refusal, or activity-read error | Use the same exact abandonment transaction. Restore the saved original drain only when the current raw fence matches; retain snapshots and write `abandoned`. Changed ownership or an uncertain write stays UNKNOWN. |
| `sealed`; abandonment | Refuse. A lost sealed reply stays UNKNOWN even if the caller believes upload did not start. |
| `abandoned`; repeated abandonment or read | Return the original immutable disposition without a drain write, even if a newer drain now exists. Never clear that newer drain. |
| Missing or malformed acquisition on read | Return unverified, never ready or abandoned by inference. |

The Worker must acknowledge exact abandonment before returning a retryable busy/refusal response. A positive observed admission count withdraws preparation before sealing, even if the last admission ends before the seal transaction could verify zero; a ready reply must not carry that stale refusal count. This includes known activity refusal, failed readiness validation and pre-seal read exceptions, not only client disconnects. A cleanup write whose reply is lost can be qualified by the stored disposition. If that read is unavailable, the response is unverified and non-retryable. Sealing and abandonment compete through the same transaction boundary, so only one can win.

### Existing writers and consumers

The surveyed Worker has nine Registry drain writers/removers and eleven direct write/delete sites. This table also covers the tuple-only consumers that could otherwise mistake a newer fence for the old one.

| Existing entry | Required treatment of an acquisition fence |
| --- | --- |
| `setDrain` | Keep its current maintenance/fence/deadline guards. It cannot replace a live acquisition through lossy projection. Existing expiry remains independent. |
| `setDeployFence` | Keep the legacy protocol, including its selected staging transitions. It cannot install or reuse a new acquisition ID. |
| `clearDeployFence`, `verifyDeployFence` | Refuse raw selector presence, even when malformed. A delayed tuple-only call cannot clear or validate a newer acquisition. |
| `recoverQuotedDeployAdmission`, `abandonStagingAdmission`, `sealStagingWindow` | Refuse acquisition-fence selector presence before their legacy tuple can authorize a mutation. Their existing independent evidence and policy remain required on legacy fences. |
| `holdDrainFor` | Preserve selector presence when adding holds. The changed raw snapshot makes a later acquisition seal/abandon refuse. |
| `reportContainerImageCurrent` | Preserve selector on retained-record writes. Keep its existing last-hold/liftAsked and maintenance checks for whole-drain deletion. Deletion gives no acquisition receipt. |
| `clearDrain` | Preserve selector when keeping image holds. Keep existing later-upload-version, effective-obligation and maintenance guards for lifting the drain. A missing/changed drain invalidates later acquisition seal/abandon. |
| `beginDeployReconcileAdmission` | Keep its independent later-upload-version and selected-maintenance checks. Reconcile admission does not seal or abandon an acquisition. |
| `releaseDeployFence`, its quote and receipt reader | Add the selector to the closed raw shape only for a validated sealed acquisition. Keep the existing 4096-character quote bound, current-version comparison, full-record/membership hashes and independent Admin/idle attestations. Retain the selector in the audited original; remove it with the other fence fields from the retained drain. |
| `releaseStagingMaintenance` | Keep its independent fresh decision, selected maintenance and original-request quote. Its whole-drain deletion cannot create an acquisition disposition or allow a late seal. Cancellation never calls it. |
| `alarm` | Keep existing deadline/hold-expiry behavior and held-maintenance refusal. Expiry leaves acquisition history intact and does not fabricate abandonment, no-upload or native ending. Later seal/abandon refuses missing or changed ownership. |

Abandonment never removes native operations, fleet admissions, maintenance, image holds, history or workspace data. It does not claim request ending or native completion. The new protocol excludes selected staging attempts entirely; those retain their existing `authorized -> claimed -> fenced` window and one-shot retry policy through the legacy path. No attempt deadline is renewed and no window reset is added.

Retain acquisition identities and dispositions as Registry audit data. Their production rate is unknown. The release owner measures checks per deployment from existing preflight logs before live acceptance; no rate is claimed here. Garbage collection is outside this repair because removing the identity could admit a delayed request without an additional generation contract. After first use, rollback must keep the acquisition reader, selector-preserving projections and old-control refusal guards; disabling the new route is safe, downgrading those readers is not.

## Client outcome and the seal

The response's `acquisition` object has `schema: 1`, `purpose: deploy-fence-acquisition`, `id`, `phase`, `workerVersion` and `build` from the parsed original row. Its phases are `preparing`, `sealed`, `abandoned`; unreadable authority is reported as unverified instead of receiving one of those phases. Only the original prepare response can carry a verified `sealed` result with the existing valid `fenceReady` payload that lets this client exit successfully. A later status read of a sealed row is historical, not upload permission. Missing or contradictory receipts never qualify.

On timeout or transport failure, the original client makes one exact abandonment request. It gives that request and any disposition readback one shared cleanup budget of at most the existing 15-second client timeout. This adds at most 15 seconds of failure cleanup; it does not extend the original preparation wait or renew the outer drain deadline. If the abandonment acknowledgment is lost, the client reads the saved disposition instead of starting another preparation. An acknowledged abandonment can use the existing fresh-attempt retry policy, with a new ID and the unchanged outer drain deadline. A sealed or unreadable result stops the deployment as unverified; it must not print the retryable `preflight REFUSED` marker or automatically reuse the old fence. The incoming abort listener and explicit client request can select the same abandonment; the transaction retains one original disposition and does not repeat a completed effect.

Selected staging attempts, explicit force and qualified bootstrap modes retain their existing legacy protocol and authority. They do not gain the new cancellation guarantee. The new ordinary path never lets cancellation supply force permission. No force or bootstrap is exercised by this repair.

## Request lifetime and other routes

Cloudflare requires `enable_request_signal` to observe an incoming disconnect. Request-signal passthrough to forwarded subrequests is a [separate compatibility flag](https://developers.cloudflare.com/workers/configuration/compatibility-flags/#passthrough-abortsignal-of-incoming-request-to-subrequests). Enable incoming observation and explicitly keep `no_request_signal_passthrough`. Only the versioned prepare handler registers an abort listener, before its first Registry call. Existing routes do not read the signal or forward the incoming Request.

The pinned Sandbox SDK does consume `request.signal` in its direct container and WebSocket forwarding methods. The Resident Worker exposes RPC/native-control adapters instead of forwarding its incoming Request to those methods. The SDK's internal WebSocket upgrade creates its own `AbortController`. Preserve that call shape and its explicit cancellation controls; the incoming compatibility flag must not add a signal to any ordinary route's native call. These facts are from `@cloudflare/sandbox@0.13.0-next.751.1`, pinned by the surveyed source, and the receiving handler's complete route switch.

The handler passes its exact abandonment promise to `ctx.waitUntil`. [Cloudflare allows at most 30 seconds after disconnect](https://developers.cloudflare.com/workers/runtime-apis/context/#waituntil); this is a cleanup opportunity, not durable liveness. The Registry phase guarantee does not depend on receiving an abort event. If the event or its cleanup write is lost, the exact client abandonment or retained-state read can still reconcile an unsealed acquisition; otherwise it stays unknown. No timer manufactures an abandonment or native ending. The preparation timeout and outer drain deadline do not increase.

The source audit above narrows the signal change to the new handler. Existing-harness checks must confirm that an aborted ordinary request still calls the same adapter without a new native signal. The source writer owns that check before source completion. The release owner separately qualifies a disposable Worker check for actual incoming-abort delivery before live acceptance. Source tests with an `AbortController` prove state transitions, not Cloudflare's delivery guarantee; the durable refusal rules remain safe if that delivery fails.

## Mixed-version delivery

Advertise `features.deployFenceAcquisition: v1` through the existing read-only health response. The ordinary client reads capability within its same 15-second preparation budget. A known-old response must have `ok: true`, `features.nativeRunScopes: native-v1`, a 40-character hexadecimal `build.commit`, and no acquisition-capability field. That response selects the existing legacy preflight for the first receiver delivery. The exact `v1` capability selects the versioned prepare address; an unknown value refuses, and failure at the new address never falls back to legacy mutation. A malformed or unavailable capability read refuses before installing a fence. This avoids requiring the new route from a receiver that has not been deployed yet, while keeping the first old-protocol deployment's existing limitations explicit. Selected staging, qualified bootstrap and force selections remain explicit legacy modes.

Delivery needs the receiving Worker protocol before ordinary checks can gain the new cancellation guarantee. A source merge does not prove that uptake. This design cannot safely abandon a legacy fence that predates its acquisition record.

## Why not use finally, a longer timeout or the old owned fence?

An invocation can end before `finally` runs, and the first mutation can commit without its reply. A longer client wait changes neither fact. Reusing or clearing a fence after readiness was sealed can race an upload. The durable identity and phase provide the missing discriminator; the existing drain, readiness predicate and recovery authority remain the owners of the rest.

## Verification boundary

Update the deployment-preflight row in `docs/reference/specs/resident-repos.md` with the same implementation PR. The existing `drain.test.ts` HTTP/Registry harness must reproduce a stalled read, a lost preparation acknowledgment, cancellation before the prepare transaction, cancellation racing seal, and a delayed legacy clear. It must assert exact abandonment or refusal, retained ordinary drain and work rows, a valid neighboring acquisition, and no upload-ready answer from abandoned work.

The living spec links behavior proofs for every entry in the existing-writers table: selector-preserving hold/image rewrites, refused legacy tuple controls, independently qualified post-upload/staging removals, original expiry without fabricated receipts, and sealed-only guarded recovery. Existing positive legacy cases remain as contrasts. `preflight.test.mjs` drives capability selection with one shared preparation deadline, cancellation with one shared cleanup deadline, lost-ack readback, sealed/unknown refusal and unchanged legacy modes through the public client. Runtime abort delivery, measured retained-record volume and a live next ordinary deployment remain separately qualified acceptance owned by the release owner; no live action is authorized here.
