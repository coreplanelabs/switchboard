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
