---
title: Resolve run ownership without discarding retained work
status: proposed
date: 2026-10-07
---

# Resolve run ownership without discarding retained work

Execution permission, source custody, workspace retention and deployment safety
are separate facts. Keep their existing owners and use typed evidence at each
boundary. A stop request cannot supply a missing source confirmation. A
workspace ACK cannot prove that a process ended or authorize disk loss.

The implemented compatibility repair shares one exact-owner ACK validator
between Memory's receipt contract and Resident consumers. Deployment activity
recognizes acknowledged terminal retention. The cancellation capability below
is proposed; it does not change the current stop or physical loss rules.

## Current state machine

| Stage | Owner and durable evidence | Permission |
| --- | --- | --- |
| Reserve and attach | Runs stores the original run, requester, thread, start, allowance and allocation or canonical null. Resident registers the exact run, generation, fence and physical binding. | Provision the admitted workspace; no model turn yet. |
| Prepare and commit | Runs retains the complete immutable original claim body and expected-seed hashes. Commit moves its row to LIVE and records an unconfirmed receipt. | A LIVE row alone grants neither execution nor cleanup. |
| Verify, confirm and release | SessionLog verifies its actual guarded source. Runs confirms its own system, budget and single seed step. SessionLog reads that confirmation and releases its temporary write hold. Each owner rechecks its snapshot after awaits. | The producer admits execution only after all exact readbacks. Immutable receipts and source custody pins remain. |
| Stop and ending | Stop writes intent. The owning execution or a qualified existing closure path writes a final record. Paused hard-stop sealing requires its same generation and durable retry pause. | Stop intent does not prove process ending. Unconfirmed promotion remains protected from finish, abandon and reclaim. |
| Workspace settlement | The terminal Runs transaction retains an exact owner, binding and revision. Resident saves the facts before ACK. Memory drops the acknowledged payload while retaining its owner-key revision. | ACK proves terminal retention. Deletion still needs saved binding, exact revision, publication and current private-tree proof. |
| Worker upload | Registry closes admission under its drain-scoped swap fence. Resident checks execution activity and canonical ownership. | Executing or unknown activity refuses; verified retained ownership can permit upload. |
| Image cutover and readiness | Resident keeps image reconciliation and its pending report under the existing resource owner. Protected registrations and workspace custody can defer container replacement. A replacement's completed hydration or verified inactivity supplies the image report. | Worker upload is not container replacement or readiness. Undrain cannot invent a pending image report. |

The authoritative paths are `promotion.ts`, `seedVerification.ts`, both ledger
implementations, `workspaceSettlement.ts`, Resident's `runRegistration.ts`,
`workspaceRemovalDecision`, `registeredRunsBeyondOps` and `reconcileImage`.
Decision [0090](../decisions/0090-one-unit-lifetime-keeps-effects-and-settlement-under-existing-owners.md)
keeps these facts under existing owners rather than adding a second lifecycle
controller.

## Proven contradiction and designed refusals

Memory's `preservationOwner` checks a live row first. After an exact terminal
settlement ACK it can return `acknowledged` with the original owner tuple and a
positive retained revision. The former deploy reader understood only `live`
and `terminal`; it rejected that valid third result. Activity classification,
UID-ledger classification and owner reconciliation reproduced the mismatch.
All ACK consumers now share the same exact-owner validator. Retained activity
still needs the current registration, thread, fence, UID spend and sole
claimant. Consumers that remove files still need their original saved revision
and full custody checks.

A foreign-generation hard-stopped LIVE row with unconfirmed promotion does
not qualify for paused sealing or reclaim. That matches the current source
custody contract. The exception that first prevented confirmation cannot be
recovered from a later protection refusal. An unknown retained registration
cannot be selected from a terminal history listing. Neither case establishes
another source bug.

Image reconciliation also keeps owned registrations protected after an upload,
including an upload that bypassed preflight. Its `force` argument selects the
image-check path; it does not waive execution or private-workspace custody.
Fixing activity observation does not clear those independent guards or prove
the cause of a particular pending image report.

## Proposed negative admission resolution

Add this capability only as one coherent protocol through the existing Runs,
SessionLog, Executor and resource-owner seams. Use one immutable cancellation
reference on the original admission and one exact cutover operation on the
existing physical owner. Do not add a planner, timer, owner cache or cleanup
table.

1. Trusted admission resolves the operator and existing policy once. Bind the
   request to the original run, requester, thread, start, generation, private
   revision, original body and manifest hashes, allocation/null and attachment
   fence. Require durable hard stop. Changed or successor evidence refuses.
2. Runs atomically records negative admission resolution against that exact
   original. Confirmation and cancellation compare the same saved state, so
   they cannot both win. Preserve the original body, commit receipt, source,
   allocation ACK, allowance, history and unresolved effects. This is no
   promotion confirmation, source release or execution-success receipt.
3. SessionLog retains the unconfirmed source under its original guarded
   custody. The cancelled admission cannot release, transfer or reuse it for
   execution. An uncertain write reconciles only through exact readback;
   observation never repeats the original claim or private work.
4. The physical owner records a separate disposition: `ending-confirmed`,
   `retained-unknown`, or `loss-authorized`. A loss authorization states what
   may be discarded and who authorized it. It never reports idle, preserved
   bytes or a confirmed process ending. Whole-container loss binds every
   affected owner, resource, physical target and image target; one thread's
   authorization cannot cover another owner.
5. Record physical operation admission before the native call. Keep exact
   pending, accepted, refused and unknown outcomes under that operation.
   Preserve uncertainty across restarts and reread the complete owner set
   before effect. Update cancellation projections, preservation reads,
   deployment activity and image readiness from their respective receipts.
   Normal preflight must not treat `loss-authorized` as idle.

## Technical gates before implementing cancellation

Resident attach and detach carry run/generation/fence; exec/read/write currently
select only a thread. `threadPreflight` verifies the UID claimant but cannot
distinguish a cancelled caller from a later owner of that same thread. Fence
every operation through the Executor seam before permitting thread reuse.
Cover both harnesses, local execution and remote execution; old or incomplete
callers must remain refused at the cancellation boundary.

The recreate admission mark is a Boolean, and thread-operation exclusion is
isolate-local. Native destruction takes no expected physical-incarnation
argument. A cutover journal must therefore retain exact operation and owner
bindings, close all supported admissions durably, and refuse uncertain
successor targets. A sampled empty process list, SDK process kill, bot restart,
logical container ID or successful upload cannot fill that gap. If the backend
cannot enforce the chosen loss scope, leave the operation held instead of
claiming conditional physical retirement.

The pending image report remains an independent obligation. A cutover receipt
does not certify the replacement's image or hydration. The existing deploy
controller retains that responsibility, including its exact build and drain
binding. Deployment is separate from source validation and review.

## Proof and rollout gates

The ACK repair has three meaningful failing assertions against the old reader:
retained activity, UID-ledger classification and already-current owner
reconciliation. Foreign/malformed owner and live-owner controls remain active.
Actual Memory HTTP/SQLite ACK readback is consumed by the shipped classifier;
claiming the same run again proves live-first precedence over its earlier ACK.
Removal tests still require the saved exact revision and private-tree proof.

Before the proposed cancellation protocol ships, both ledgers and the actual
RPC path must prove a fresh committed, verified, unconfirmed original can
receive exact negative resolution without source release or fabricated ending.
Tests must compare original private bytes, ACK/null, allowance and history;
race confirmation against cancellation; reject changed actors, owners,
revisions, hashes and successors; and reconcile lost replies without replay.
Executor tests must reject stale calls after successor attachment. Physical
tests must cover restart and unknown native outcomes under a complete owner
set, including loss authorization without ending proof. Image tests must keep
the report pending until its own replacement proof arrives.

Review and release matching producers and consumers together. Existing live
records gain no inferred receipt. Qualify natural exact-binding evidence before
attributing a live hold or claiming recovery. Keep parent-owned deployment,
unrelated paused work and multi-provider/harness support intact.
