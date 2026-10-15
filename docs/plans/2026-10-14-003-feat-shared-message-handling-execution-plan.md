---
title: Shared message intake implementation plan
type: feat
date: 2026-10-14
status: proposed
---

# Shared message intake implementation plan

Implement the [shared intake design](2026-10-14-002-feat-github-activity-inbox-plan.md) in seven reviewable changes. Prove the shared front door before connecting more GitHub events.

The target is one orchestrator entry point for external agent messages. Adapters cannot address workers directly. A worker receives only an authorized internal handoff or steer, with the original source type and permissions intact.

## Estimate and assumptions

**Planning estimate: 14–24 engineer-days, roughly 3–5 working weeks for one engineer.** This includes review-head continuation. It is an effort range, not a delivery date or a measured benchmark.

Confidence is low to medium until Step 1 confirms the ownership and routing seam. The estimate assumes familiarity with this repository, reuse of the current state partition and runtimes, and no new broker or cross-account migration. Review, CI and live-validation wait time can extend elapsed time.

If operator and orchestrator context require a larger session migration, revise the estimate after Step 1. Do not hide that work inside the GitHub adapter.

| Step | Work | Engineer-days |
| --- | --- | --- |
| 1 | Converge the front door and establish orchestrator ownership | 2–3 |
| 2 | Add shared saved event jobs, keyed delivery and recovery | 3–5 |
| 3 | Carry typed evidence through internal delivery and both runtimes | 2–3 |
| 4 | Connect the thin GitHub adapter and missing source reads | 2–4 |
| 5 | Continue active reviews across permitted head changes | 2–4 |
| 6 | Add version gates and migrate existing contexts | 1–2 |
| 7 | Run failure tests and qualify the enabled source actions | 2–3 |
| **Total** | | **14–24** |

## What is reused, refactored and new

| Kind | Component | Change |
| --- | --- | --- |
| Reuse | Dispatcher, operator decisions and orchestrator tools | Keep their policy and execution contracts; converge their entry paths |
| Reuse | State worker, shared alarm, bot callback and heartbeat | Use these for persisted jobs and recovery |
| Reuse | Inboxes, unit events, sessions and checkpoints | Keep internal delivery, consumption and continuation mechanisms |
| Reuse | GitHub App access and publication journals | Keep credentials on the trusted side and preserve uncertain-write rules |
| Refactor | Source adapters | Keep protocol checks, field mapping, source reads and acknowledgments at the edge |
| Refactor | Slack intake and dispatcher/operator paths | Share relevance, context lookup and route/fold decisions across sources |
| Extend | Existing task/source context | Save native source IDs, orchestrator links and context versions |
| Extend | Existing inbox and unit-event schemas | Preserve typed evidence and require a recorded internal decision |
| Extend | Existing store transactions | Add keyed delivery receipts, exact consumption proof and source-dependent output checks |
| New | Common external event record | Represent requests, source evidence and typed facts without source-specific fields in core decisions |
| New | Persisted source jobs and retry records | Retain work before acknowledgment, claim it safely and record exhaustion |
| New | Missing GitHub normalization and readers | Cover inline/review/thread/commit activity, history overlap and failed deliveries |

“New” here means new records or behavior inside existing components. It does not mean another service, agent, queue product or per-task listener.

## Step 1: converge the front door

**Current source:** [dispatcher](../../src/core/dispatcher.ts), [operator](../../src/core/dispatch/operator.ts), [orchestrator preset](../../src/agents/registry.ts), and [admission](../../src/core/dispatch/admission.ts).

Trace Slack, CLI, HTTP and MCP message entry. Record where code chooses the operator, main orchestrator, live-run fold or registered command. Make the orchestrator conversation own the decision. Reuse operator projections, typed bindings and the existing executor inside that path. Retire the separate model-routing pass; do not just rename both paths or chain their model calls.

Include `answerUnitOwnedThread`, direct unit-event appends, explicit steer commands and their fallback branches in this inventory. Unit input must have the same recorded orchestrator decision. If lookup or storage fails, hold source evidence; do not treat the thread as unowned. A trusted requester request may route fresh only through an explicit orchestrator decision and existing policy. Evidence never gains that right merely because its author is the requester.

Persist the original orchestrator/conversation link before delegated work starts. Define how an existing direct-specialist thread maps to that context. Keep ambiguous legacy input held rather than inventing an owner or sending it directly to a worker.

Keep current requester, repository and command permissions. An orchestrator is a routing owner, not a grant source. Typed commands and already-approved folds can use code paths without another model call; they still need the same recorded decision and policy checks.

**Done when `[gap]`:** every message path, including unit-owned threads and store-unavailable/gone-instance fallbacks, reaches this entry point once. Evidence holds rather than routing fresh. Legitimate requester requests retain their authorized route-fresh behavior. No source can supply a trusted worker target, and no second model router precedes the orchestrator.

### Implementation progress, 2026-10-14

Step 1 is in progress. The first structural cut extracts `prepareActionContext` from the operator model loop. It prepares the existing authorized action projection, source context and requester-target checkpoint without a model call. The operator still uses this function; the orchestrator runtime is the next consumer. This cut does not switch message routing or establish the final front-door guarantee.

The source trace identifies these entry paths and remaining changes:

| Entry or internal path | Current behavior | Remaining Step 1 work |
| --- | --- | --- |
| Slack, CLI `ask`, HTTP dispatch and MCP dispatch | Call the shared dispatcher with a resolved actor and message | Keep adapter identity checks; send the message into its orchestrator context |
| Dispatcher operator path | The operator binds a typed action before a specialist starts | Move the action tools into the orchestrator loop; remove the preceding model call |
| Main orchestrator conversation | Plain messages use the agent runtime; command tools use the registry executor | Reuse the action context and typed bindings in this loop |
| Live thread reply | Admission writes to the live run inbox | Record the orchestrator fold before internal delivery |
| Unit-owned thread | `answerUnitOwnedThread` appends a unit event and nudges the workflow; some failures route fresh | Record the decision first; hold evidence on failed lookup or storage; require an explicit decision before any fresh request |
| Explicit steer command | The registry sender calls the common steer function across command surfaces | Preserve its exact-target authorization and record the orchestrator decision |
| Recovery and unconsumed replies | Restart or settlement can append unit events or dispatch a fresh turn | Preserve the original decision and context; do not interpret evidence as a new request |

Context links, recorded internal decisions and removal of routing bypasses remain pending. The complete Step 1 acceptance condition above remains a gap.

### Delegated conversation link, 2026-10-15

A new handoff from a known orchestrator root now names its original run, requester, channel and thread. The existing handoff record carries this link into the saved unit capsule and child admission. Nested workers preserve the original link instead of making themselves the routing owner. Canonical source validation checks the source agent and all four owner fields. It refuses changed links and loss of an inherited link.

This is a context reference, not an execution grant or a delivery decision. Older unlinked handoffs remain readable. A standalone specialist and a delegated orchestrator with unlinked source context remain unlinked; neither is guessed to be the original front door. The remaining routing migration must establish a verified context for those paths before source evidence can use them. Shared fold decisions and removal of the separate operator model pass remain pending.

### Command binding cut, 2026-10-14

The context extraction is merged in [the first cut](https://github.com/coreplanelabs/switchboard/pull/3130). The next cut connects requester-bound orchestrator commands to that preparation and the existing typed registry binder. It records the original conversation and source in the run's existing state before a command or confirmation offer can proceed. The command's existing history carries the same link after completion.

This is a saved selection, not a completed action or a job queue. The existing registry still checks permissions and confirmations. Missing or failed decision storage stops the command. The writer retains at most 256 selections and 256 KiB of metadata in one run; full input and source bodies have hashes; the existing redacted command line remains display metadata. Native output still goes directly to the requester.

The main conversation's private audience and latest-delivered-source checks remain in force. This cut adds no specialist delegation, external evidence delivery, source listener or second model loop. Unit-thread, live-run and explicit external steer paths still need the recorded ownership boundary. Step 1 remains in progress.

### Private worker controls, 2026-10-15

The command binding cut is merged in [PR #3134](https://github.com/coreplanelabs/switchboard/pull/3134). The next cut extends its existing decision writer to the orchestrator's private `work_start`, `work_steer` and `work_stop` tools. Commands and worker controls share one owned history and its count and byte limits. Before a worker can start or receive a change, the writer must acknowledge the conversation, requester, latest delivered source message and selected tool. It retains hashes of the target, input and context. Private target names and request bodies do not enter this metadata.

The existing starter and linked-work executor still check permissions and exact task bindings. The call keeps a check against its original source after the decision save and through later asynchronous lookups. A newer delivered requester turn or withdrawn authority stops the older call. Acknowledged selections also enter the finished run record, including terminal recovery from retained live state. A selection remains separate from permission, action completion and replay safety.

This cut uses the existing orchestrator loop. It adds no model router or new delivery queue. External live replies, unit-thread replies, explicit steer commands and the remaining operator model path still need migration. Step 1 remains in progress.

### Live reply delivery boundary, 2026-10-15

The private worker controls are merged in [PR #3139](https://github.com/coreplanelabs/switchboard/pull/3139). Tracing the next live-reply path exposed a prerequisite: the shared inbox client used the same result for storage failure and target absence. A reply could then enter memory without its durable copy or start fresh work while its original target still existed.

The next cut separates those outcomes in the existing inbox protocol. Only an explicit `not-live` response permits the caller's existing target-absence behavior. Storage errors, invalid messages, unclear replies and older servers' unqualified rejections stop delivery. The CLI and bot use the same sequence reader. This change adds no delivery queue, automatic retry or listener. Live-reply decision records and unit-event migration remain pending; Step 1 remains in progress.

### Unit reply delivery boundary, 2026-10-15

The live inbox outcome boundary is merged in [PR #3140](https://github.com/coreplanelabs/switchboard/pull/3140). The unit-event path had the same failure: a failed append acknowledgment could start fresh work even if the original event had committed. A failed or rejected unit append now retains the original owner and returns a system refusal. It starts no replacement and does not claim that delivery succeeded or retry the write.

This closes another failure branch before shared decision records are added. Confirmed Workflow absence still follows its existing termination and requester routing policy. Conversation links, live and unit fold decisions, and removal of the separate operator model pass remain pending. Step 1 is in progress.

## Step 2: save input and recover shared work

**Current source:** [state worker](../../deploy/cloudflare-memory/worker.ts), [run-ledger contract](../../src/core/runLedger/types.ts), and [write-through client](../../src/core/runLedger/writeThrough.ts).

Add common event, pending-job and delivery-result records. Keep provider delivery identity, source object/change identity and internal destination keys separate.

Save input and its scheduled wake atomically before acknowledgment. Use the supported async storage transaction for alarm operations. Pre-arm the next wake before external I/O, preserving earlier deadlines for other work.

Implement bounded claims, claim tokens, expiry, retry delay, fair service and visible terminal failure. A retry resumes the saved stage. It must not rerun a completed orchestrator decision or repeat an external effect.

**Done when `[gap]`:** failure before/after every save and notification leaves either a recoverable job or an explicit failed result. A repeated delivery returns the original result. Recovery continues with no active agent heartbeat.

### Shared wake prerequisite, 2026-10-15

The state alarm now acknowledges its next wake before Workflow discovery or maintenance starts. It uses the same scheduling path after the pass to refresh changed deadlines and preserve earlier deadlines for other work. A failed wake write prevents the external lookup. The existing later alarm can retry the pass. SQLite tests cover no live runs, paused maintenance, an earlier deadline and a failed wake acknowledgment.

This prepares the existing recovery path for shared intake jobs. It adds no event job, source writer, listener or new timer interval. Atomic event/job/wake reception, bounded job claims and keyed internal delivery still remain pending. Local Worker proof remains separate from production acceptance.

## Step 3: preserve evidence through internal handoffs

**Current source:** [intake](../../src/core/intake.ts), [inbox schema](../../src/core/runLedger/inboxMessage.ts), [thread admission](../../src/core/threadAdmission.ts), [unit events](../../src/core/coordinator/instanceStore.ts), and both runtime implementations.

Extract the shared relevance mechanics from Slack-specific prompt context. Keep the PR fallback policy explicit. Add `source-evidence` to orchestrator input and internal worker/unit input.

The internal entry must retain the source actor and orchestrator decision identity. Extend the existing steer and ownership checks; do not impersonate a requester or manufacture parent-run identity to bypass a gate.

Include `instanceStore.appendEvent` and the current unit-fold `coding` permission gate. A source author supplies evidence, not a request to run coding. Check the recorded internal decision and destination authority without granting execution rights to that author.

Prevent evidence from answering privileged questions, renewing or interrupting work, widening permissions, or becoming a fresh request through `settleThread`. Preserve it through redaction, checkpoints and both runtime resumes.

**Done when `[gap]`:** external evidence cannot enter a worker without a recorded authorized decision. It remains evidence after delegation. Parent/child changes cannot double-deliver it. Exact row acknowledgment proves consumption.

## Step 4: connect GitHub as a thin adapter

**Current source:** [webhook receiver](../../src/channels/githubWebhook.ts), [current GitHub handlers](../../src/core/coordinator/checksIntake.ts), [GitHub API](../../src/execution/githubApi.ts), and [history tools](../../src/tools/github.ts).

Retain raw-signature, configured-source and size checks. Map all supported human/bot and top-level/inline/review/commit updates into the common event. The adapter supplies source facts; shared core selects the orchestrator context and relevance policy.

Save stable native repository/object IDs into existing context. Cover forks, renames, transfers and older name-only context. Use one merge path for webhook and API results, including edits, deletions, conflicts and late-bound targets.

Add the GitHub failed-delivery reader to the shared recovery scheduler. Keep its scan active while the integration is enabled. Keep native-source echo matching in the existing publication journal; an echo match cannot settle or repeat an uncertain write.

**Done when `[gap]`:** every enabled action reaches the common front door. No adapter code chooses or writes a specialist inbox. Lost or oversized deliveries and unrecoverable history produce explicit coverage gaps.

## Step 5: continue a review when its head changes

**Current source:** [head classification](../../src/core/headMoved.ts), [review settlement](../../src/core/reviewRound.ts), [run loop](../../src/core/dispatch/runLoop.ts), [history](../../src/core/reviewHistory.ts), and existing workspace/runtime contracts.

Make review continuation a consumer of an internal head-update entry. Preserve the same logical run and conversation. Keep prior notes and progress, but clear head-specific verdict/history/diff-coverage proof before reviewing a new permitted head.

The run's execution lease limits task time. A job lease only limits a worker's temporary claim on queued work. These limits must not be confused.

At a safe boundary, checkpoint, advance the controller-owned checkout and verify its actual HEAD. Reuse the existing session when possible. If the existing lifecycle requires process replacement, use a verified successor that retains the same logical work and remaining budget.

Review the delta and affected code. Coalesce later permitted updates toward the newest head within the original lease. Retain earlier source events and their superseded status. Do not grant approval because subjects, commit counts or filenames match.

Retire `classifyHeadMove`'s metadata-only rebase carry branch and the path that pins an old verdict to a new head. Do not add a new equivalence shortcut in this implementation. Every changed permitted head requires the verified transition and refreshed review evidence above. Existing stored carry receipts remain readable; they cannot authorize a new carry.

Preserve immutable user pins and original publication authority. An update outside that authority remains held. Hard stop or exhausted time cannot start another continuation. Missing proof ends incomplete.

**Done when `[gap]`:** identical full commit messages, count and file set with changed contents cannot carry an old verdict. Include conflict-resolution changes. Verify stale checkout repair, repeated heads, checkpoint loss, process replacement, pin refusal and lease exhaustion. No new top-level run or budget reset occurs.

## Step 6: migrate without losing owed input

Deploy readers before evidence or publication-matching writers. Gate new records on the current consumer's schema capability. Backfill native IDs and orchestrator owner links, or record a held gap.

The state worker must preserve unacknowledged evidence across numeric cursor changes and older consumer reclaim. Rollback to an incapable reader pauses consumption; it cannot erase or downgrade an entry.

Connect source paths to the common core in controlled cuts. Each event must have one active routing path. Remove the old source-specific routing/folding logic after equivalent behavior is proved.

**Done when `[gap]`:** mixed-generation tests preserve queued input and original publication uncertainty. Existing commands, requester permissions and child ownership still work.

## Step 7: prove the enabled path

Use targeted tests for each changed contract. Leave full suites to CI. Update the living specs in the same implementation PRs.

Run a disposable end-to-end procedure for every enabled GitHub action. Correlate source delivery, orchestrator handling, internal decision, worker delivery and consumption. Include both authors and comment locations, forks, access changes and concurrent task ending.

Measure input latency, state-write latency before acknowledgment, candidate rate, bytes, recipients per source event and API/model capacity. Select finite limits before enablement. Validate alarm failure, retention expiry, replay and body-hash round trips.

**Done when `[gap]`:** receipts identify the tested revisions and actual limits. Local tests, fresh CI and live acceptance are reported separately. Deployment still needs its own authority.

## Dependencies and scope limits

Steps 1–3 establish the shared contract. Step 4 uses it. Step 5 integrates head continuation. Step 6 depends on the schema work; Step 7 verifies the complete enabled path. Test design begins with each step rather than waiting until the end.

Optional deployment/security/linked-issue sources, another broker, cross-partition routing, and the separate GitHub CLI compatibility repair are outside this first implementation. Any later source must use the same front door and prove its own read scope and coverage.
