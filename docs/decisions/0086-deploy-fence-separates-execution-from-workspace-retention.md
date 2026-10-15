---
title: A deploy fence separates execution from workspace retention
status: accepted
date: 2026-10-02
pattern: Durable run fence and exact owner read
---

# A deploy fence separates execution from workspace retention

## Context

The resident keeps a run registration while its workspace needs preservation, even after the run is terminal. The operator's `runsInFlight` count includes those registrations so cleanup and container replacement keep protecting the files. A deploy preflight that treats that count as execution can wait forever on a terminal workspace. A drain normally exempts the registered owner so a running run can reattach; a deploy cannot safely read activity and then swap isolates while that exception remains open.

## Decision

Keep the retention count and the workspaces intact. During a normal deploy, require the drain bearer to close registered reattach in the registry's durable drain record before reading every resident. Ask the run ledger for each registration's exact owner. Count a matching live owner and resident operations as executing, a matching non-provisional terminal owner as retained, and every missing or mismatched answer as unknown. The deploy proceeds only with a live fence that has at least 20 minutes remaining for upload and readiness, zero executing and unknown owners, and safe lifecycle states. The runner asks for a 90-minute drain around its 60-minute wait so that budget remains at the last retry. A refused read clears only its own reattach fence; the runner keeps the drain until it completes or explicitly lifts it.

## Consequences

- A Worker without the fence endpoint refuses the new preflight. Installing the endpoint on an older Worker needs a separately reviewed bootstrap; the normal release cannot prove this first swap safe.
- The owner read needs the state Worker. An unavailable answer delays a release, but never authorizes removing a workspace or interrupting an unverified run.
- The fence expires with the drain if a runner dies. A successful deploy holds it through image reconciliation and the ordinary undrain.

## Alternatives

- Delete terminal workspaces based on their checked-out commit: that SHA does not prove private files or commits were saved remotely.
- Ignore retained registrations in the old count: that would weaken container and cleanup protection.
- Use the ordinary drain alone: its registered reattach exception leaves an admission race during the isolate swap.

## Amended 2026-10-14

**Re-evaluation.** The fence was accepted because a quiet snapshot must exclude every admitted request while protecting terminal workspaces. A durable permit still represents that request obligation. Caller-side `finally` cannot settle it after a crash, and a lost admission reply previously left the caller without the Registry-created ID.

New callers create the permit UUID and a hash of normalized original provenance before the first RPC. An uncertain reply permits one exact stored read, never another admission or native submission. Only the original living stack can continue after positively matching its admitted record. Caller death and unknown legacy debt remain held for separately verified recovery.

The Registry atomically writes an exact release receipt and deletes the permit. An uncertain end reply qualifies only through that receipt; absence alone stays unknown. The latest 128 identity-bearing receipts bound storage. Eviction narrows acknowledgement recovery without granting work or retiring active debt. Request cleanup is not native completion.

The original fence predicates and recovery authority remain intact. Legacy callers reaching the upgraded Registry can release only legacy records; keyed releases require the exact hash. Old Registry code cannot enforce this boundary, so rollback with keyed debt requires separate migration/recovery qualification. Producer identity and withdrawn-fence/readback status keep consumer diagnostics honest during rollout.

## Amended 2026-10-14: recovery audit quotes

**Re-evaluation.** The fence protects the request obligation and independent retained workspaces. Manual recovery was accepted only with an operator-verified original request-end receipt and idle owner/lifecycle/process views. Comparing only the permit key after those reads could delete a changed record; a lost commit reply also left no exact original-record receipt to qualify. Preserve the accepted ending requirement and the independent guards while binding recovery to the record the operator selected.

An admin obtains the original start and full flat-record hash through the existing inventory route's exact-ID query. Recovery compares both again in the deletion transaction, retains the complete original record and the receipt URL hash, and records request ending as operator-attested. The hash identifies the stored record; neither the hash nor URL syntax authenticates the ending fact. Native outcome remains unverified and independent obligations remain unchanged. Existing audit keys cannot be overwritten or reused by a new admission. An uncertain mutation reply allows one matching audit read in the original living handler, never another deletion; missing, altered or unreadable evidence stays unknown.

Quoted recovery uses a separate HTTP address and Registry RPC. Older code rejects the new address or method. The upgraded service refuses legacy recovery requests without deleting a row. A return to an older version therefore keeps the record protected. Neither interface can fall back to the old unchecked mutation.

**Recovery interface.** Replace `POST /recover-admission` with `POST /recover-quoted-admission`. The new request also requires `expectedStartedAt` and `expectedRecordSha256` from `GET /deploy-admissions?id=<id>`. The compact inventory without the query remains unchanged. Operators must verify the external original request-end association against that quoted record before submitting recovery. An old producer needs a separately qualified bootstrap; merge does not establish uptake or cleanup of an existing permit.

**Open abandonment dependency.** Operator abandonment is a distinct disposition with an unobserved original request end. No trusted containment/retirement producer for an unidentified legacy global caller exists in this contract. The endpoint therefore refuses abandonment and does not convert upload/version changes, process-zero observations or caller booleans into a witness. A future audited abandonment or bounded staging risk contract needs its own qualified effect scope, exact original-row/fence comparison and independent native/private obligation records. This amendment supplies request-ended recovery hardening, not an executable abandonment path or proof that a legacy request ended.


## Amended 2026-10-14: explicit staging risk and maintenance

**Re-evaluation.** A request record is accounting, not a privilege grant. An unknown original caller has no request-end witness. A staging operator can accept a separate, finite fixture risk without inventing an ending. Default profiles disable this action. A trusted staging policy binds the account, Worker, fixture evidence, selected controller, source, profile and configuration. The digests identify the operator's retained evidence; they do not certify deployed bindings or remaining credential scope. The operator must qualify future old authority before bootstrap. Historical remote outcomes can remain unknown.

The Registry retains the original record and an immutable abandonment audit. One common calculation excludes only the matching record from one selected upload window. Other global requests and native, owner, process and private retention guards remain. A changed or absent original record invalidates the exception. The window lasts at most the existing 90-minute drain limit. A separate durable maintenance record blocks new admission through ordinary drain expiry, image reports and restarts. A recorded released generation cannot reinstall itself. Old producers cannot enforce this new hold, so bootstrap and unsupported rollback need the operator's qualified fixture boundary.

The selected normal controller claims the window through an atomic fence transfer. It uses force zero, verifies the exact source/profile/configuration, keeps ordinary image checks, and reports image readiness while maintenance remains held. It does not call undrain. The existing staging wrapper waits within the selected deadline for one explicit Admin release before validation. Expiry, unreadable state or a changed identity fails that wait without a mutation or replay.

A release after upload-window expiry requires a fresh separately recorded operator decision, the unchanged original audit and record, and idle member owner/lifecycle/process views. Other global requests still refuse release. This release preserves the unknown original outcome and cannot renew upload eligibility. An uncertain mutation permits one exact receipt read, never another mutation. Source tests and review qualify the code; merge does not establish bootstrap, live capability scope or staging acceptance.
