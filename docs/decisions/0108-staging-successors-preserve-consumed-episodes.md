---
title: Staging successors preserve consumed episodes
status: proposed
date: 2026-10-15
pattern: Compare-and-swap episode pointer and immutable receipts
---

# Staging successors preserve consumed episodes

Decide before source merge: adopt this successor contract for an engineer who maintains staging deployment. The source reviewer accepts the contract; the operator separately selects each physical operation.

Staging can need another update after a deployment completes and a later acceptance check fails. The released maintenance record, consumed window and unfinished original request must remain evidence. Install a separately selected successor with one Registry transaction, then require a fresh explicit risk decision before its normal CI update. This adds per-episode records and one current pointer; it does not renew the old episode. Without this change, another candidate cannot pass the existing guards.

## Today at `78b9384d50f52a8bbc7ecafd6744ff88665786d8`

| Fact | Source |
| --- | --- |
| Startup accepts only the exact stored policy, even after release. | `deploy/cloudflare-resident/worker.ts::initializeStagingMaintenance` |
| An existing request audit or singleton window refuses another risk decision. | `worker.ts::abandonStagingAdmission` |
| Release retains the request and window and deletes only the drain. | `worker.ts::releaseStagingMaintenance` |
| The exclusion calculation requires held maintenance and exact audit, policy and window agreement. | `deploy/cloudflare-resident/admissionRisk.ts::deployObligations` |
| Bootstrap refuses any existing maintenance; normal CI uses force zero. | `src/deploy/stagingHeldBootstrap.ts`, `scripts/staging-deploy.ts` |

## Shape

This is a compare-and-swap state transition. The rendered trusted policy names the exact released predecessor and the new finite operation. Request data cannot supply or replace that policy. One transaction validates the predecessor, retains its records, creates the successor and its installation receipt, then advances the current pointer. Evidence digests use SHA-256 of compact JSON with recursively sorted object keys. A later risk decision creates a new window for the same unchanged original request. The original audit continues to say that request ending is unobserved and native outcome is unverified.

```mermaid
sequenceDiagram
  participant CI as Selected manual CI
  participant Old as Qualified released producer
  participant New as New source and trusted policy
  participant Store as Registry transaction
  CI->>Old: Read exact old source, version, release and idle members
  CI->>Old: Read withdrawn legacy fence; one selected upload
  New->>Store: Compare predecessor and original request
  Store->>Store: Create successor records and receipt; advance pointer
  CI->>New: Read exact hold, source, image and null window
  Note over CI,New: Lost upload or readback is observed, never replayed
  New->>Store: Later explicit risk decision, once for this episode
  Note over New,Store: Only later normal force-zero CI consumes the new window
```

## Hard case: the upload reply is lost

1. The operator has retained a released predecessor, its completed window, release receipt, immutable request audit and exact unfinished-request quote.
2. The operator separately selects a new source, immutable inputs, hold ID, next generation, operation ID and fixed deadline. This is a new decision, not an extension of the old deadline.
3. The original manual CI run validates its identity and full preserved workflow history. It matches the released predecessor projection, old Worker source and version, selected resource set and complete idle member views. The existing 20-minute reserve and shared staging lock still apply.
4. The Resident-only installer submits once. Its reply is lost.
5. On startup the new Registry compares the full stored predecessor policy digest, release receipt, completed window, original audit and unchanged original request. It requires the next generation and unused successor identity. The transaction either installs all new records and the pointer or changes nothing.
6. The original job stops with an unverified outcome. A rerun cannot upload again. A reconciliation GET can finish initialization of the original already-uploaded trusted policy on first Durable Object construction. It selects no new operation and does not repeat upload or risk acceptance. After installation, the exact receipt and retained predecessor are read without another installation. Exact source, native image and member proof remain required before adoption.
7. A new window does not exist until the separate explicit risk decision. No original request or native completion has been inferred.

This trace preserves the old evidence and prevents a lost acknowledgement from granting a second upload or renewed authority.

## Where correctness is difficult

1. The legacy producer cannot reserve a successor before it has the new code. Keep that one-shot installation boundary explicit.
2. The current pointer and all successor records must commit together while the predecessor remains unchanged.
3. Every existing gate must read the same episode; a new audit must not overwrite or borrow the original audit.

## The legacy installation boundary

The first old producer has no successor-reservation endpoint. Do not claim a durable old-side acknowledgement that it cannot return. The original manual CI workflow remains the installer. Physical admission requires all of these operator-owned facts before dispatch:

1. The exact old installed policy, released receipt, account/storage bindings, Worker source/version and immutable original request quote are retained and agree.
2. There are zero competing upload/control paths. Reconcile each prior CI/local uploader against its original process/request receipt and deployment-credential boundary. An empty list, old age or stopped caller is insufficient. No lifetime bound is assumed. Unknown remaining upload or fixture-control authority stops admission.
3. Original request ending can remain unknown only with retained evidence that its remaining effects cannot violate the selected fixture. Native/member/owner/private guards still need their own positive proof. This source cannot certify external containment.
4. The operator selects one original-actor, same-repository current-head CI run, immutable inputs, complete GitHub history, shared staging lock and one invocation. The authenticated predecessor projection, old source/version and complete member set must still match at preflight. The released producer reports blocking=1 and withdraws its swap fence; this guarded installer accepts that exact withdrawn projection, not a retained-fence claim. Drift invalidates qualification.
5. The operator accepts that a refused Registry installation can leave staging unavailable after upload. There is no automatic rollback or time-based restoration promise. The job stops with the original evidence; any recovery needs separate qualification and authority. The acceptable outage is an open physical-admission decision owned by the operator, not a value supplied by this source change.

The coarse registry counters include retained owned workspaces and need not be zero for a successor. Final fenced activity must positively report zero executing and unknown runs with complete valid retention counts. An exact acknowledged terminal owner may remain retained with its original registration, fence, UID and private files. This does not prove native scope ending or satisfy independent image/recreation guards. Cleanup, kill or owner reconciliation is not required merely to zero a display counter. A generic force command remains ineligible. These are admission prerequisites, not claims that a source merge supplies the facts.

The new policy contains a bounded predecessor quote: exact old hold/generation/operation fields, policy digest, release decision/time and original request ID/start/hash. The old projection supplies the fields it already reports; it does not certify an unavailable full-policy digest. The operator's retained immutable old policy supplies that qualification. The new Registry verifies the full stored digest and complete old records atomically before enabling the successor. A mismatch can leave an uploaded Worker unavailable; it cannot create a new hold or authorize another upload. This cost is explicit and preserves the existing unknown-outcome rule.

## Durable episode storage

Keep `deploy:staging-maintenance`, `deploy:staging-window`, `deploy:staging-release:<hold>` and `deploy:abandoned:<request>` in place. A current pointer is absent for that legacy episode. When the pointer is absent, bounded one-key prefix reads must also prove that no successor maintenance or installation record exists; otherwise legacy fallback refuses. Each successor uses `deploy:staging-maintenance:<hold>`, `deploy:staging-window:<hold>` and `deploy:abandoned:<request>:<hold>`. `deploy:staging-active` selects the current hold/generation/policy digest. `deploy:staging-installation:<hold>` binds that tuple, installedAt, the exact predecessor quote and digests of its retained maintenance/window/audit/release records. The same transaction writes all new records and advances the pointer. Existing successor keys refuse another installation; exact same-policy startup is receipt reconciliation only. Advancing the pointer never deletes or rewrites a consumed predecessor. Lookup validates the pointer, selected record and installation receipt, including the retained predecessor evidence and immutable original audit; corrupt or partial state refuses rather than falling back to legacy state. Work per current lookup stays bounded and does not scan the complete history.

Installation requires a released predecessor, a matching release receipt, a completed consumed window, exact old audit policy and original row hash, no other global request, the same staging account/script/origin/resource/fixture scope, generation plus one and distinct unused hold and operation IDs. A restart with the same policy preserves the existing held or released state and original deadline. A stale or competing policy cannot replace a newer current episode. The installer records a receipt for read-only reconciliation. If startup restarts after commit, it reads that exact receipt and unchanged current record; it does not install again or change installedAt/deadline. An uncertain physical upload is never resubmitted.

The risk endpoint uses the current episode's audit key. For a successor it must match the original request quote selected in the predecessor declaration. It creates that episode's audit and window once. Current lookup, obligation counts, risk commit/readback, drain claim, deploy fence, seal, release/readback and maintenance history reads all use these same per-episode keys. Original request ending and admission-identity reuse still consult the immutable original audit. The shared obligation calculation still requires the original row hash, exact current policy, current hold/window and live deadline/fence. All other global debt, native operations, owners, private retention and image checks remain independent. Normal CI continues to use force zero, seal its own window, wait for explicit release and run its own acceptance checks.

## Why the smaller alternatives fail

Changing the old policy or deadline destroys its source and release witness. Reusing its completed window grants authority already consumed. Deleting the old audit or request invents ending and removes unknown debt. Merely allowing a different generation at startup leaves the old singleton window and audit attached to the wrong policy. Another namespace or a direct unguarded force update would evade the retained history and qualification boundary. Per-episode storage changes the selection point while keeping those records intact.

## Proof and rollout boundary

The owning staging rows in `resident-repos.md` and `release-and-deploy.md` must prove: released-predecessor installation; exact restart and no renewal; preserved predecessor bytes; new explicit risk/window and force-zero claim; stale, repeated, foreign and concurrent refusal; original-row drift; incomplete or lost transaction acknowledgement; read-only receipt recovery; and both legacy and successor bootstrap refusal paths. Existing drain and bootstrap fixtures provide the local entry points. Native filesystem and harness behavior have a separate owner and proof.

Source merge does not choose a policy, publish a profile, set a deadline, dispatch CI, accept risk or release maintenance. The operator must first qualify the exact containing source and all physical prerequisites. An idle snapshot, absent controller, merged source or successful image report does not prove any original request or native ending.
