---
title: Return delegated work to its original conversation
status: proposed
date: 2026-10-01
---

# Return delegated work to its original conversation

A person asks a question, receives an answer, and asks for a change in the same
conversation. The main agent stays responsive. It delegates work it cannot do,
and reports the verified outcome in that conversation. A restart must not lose
the request or create another worker; a lost acknowledgment must not repeat a
write.

The main agent remains a control-plane reader. Its work tools propose actions
to trusted code; they do not give its model a shell, provider credential, or
arbitrary write-capable MCP tools. Delegation only narrows the requester's
authority. A denied action remains denied when another agent is selected.

## Existing contracts and observed gaps

These boundaries motivate the migration. Each delivery slice updates the
owning behavioral spec with its proof; this proposal does not certify live
acceptance.

| Boundary | Reuse | Gap |
| --- | --- | --- |
| Request identity | `RequesterTurn`, `MainTaskKey`, atomic `claimMainTask`, immutable `WorkBrief` | The private work claim is specific to Ship. A provider question has no corresponding admitted action and return address. |
| Authorization | The policy table, resolved actors, delegated-grant intersection, current requester and audience checks | An MCP configuration grant is not provider operation authority. Neither a tool hint nor a model promise enforces a read scope. |
| MCP | Source resolution, per-agent filtering, client and catalog revisions | The orchestrator receives only tools explicitly bridged as `sideEffectFree`. Broad generic executors remain excluded. Current source stamps are process-local, unsuitable as durable authorization receipts. |
| Dispatch | The dispatcher is the only agent admission path. Operator binds and command registry keep their existing guards. | Routing to another preset alone does not retain a private delegated result contract. A new public or user-scoped general run is not a substitute. |
| Work execution | Existing Ship unit, branch, budgets, private worker log and step idempotency key | Stored coding input and admitted child are separate facts. Brief completeness does not prove transfer into the original child. |
| Effects | Plane offers, generation fences, acknowledgments and domain publication receipts | `done` acknowledges an effect offer; it does not prove an arbitrary provider result or its delivery to a person. |
| Work reads | `thread_work`, `work_status`, `work_progress` | Joined ownership checks and projections are repeated. Worker completion, result validation and return delivery do not share one typed reference. |
| Return | Private worker IO cannot post to Slack; current main tools reread bounded progress | Automatic worker-ending wake is an explicit spec gap. Saved or compacted private results cannot generally be replayed with proven provenance. |
| Review and recovery | Exact PR/head, posted review and same-unit recovery fences | Review intent still has text-derived consumers. A terminal run, posted review and permission to repair are separate facts. |

These are related boundary problems, not evidence that every current refusal is
a bug. Source-denial diagnostics and test-execution receipts have separate
owners and should land without taking on this migration.

## One action reference, domain-owned facts

Implement the request-envelope direction of decision 0078 and the effect
receipts of decision 0074 through the existing stores. Do not add a second
permission table, general workflow database, or planner. `WorkBrief` remains
the coding payload; it must not become a provider credential or generic grant.

An admitted action has this semantic shape:

```text
ActionBinding
  version, actionId
  requester: resolved principal and delegation identity
  source: original conversation, message identity, requester revision
  destination: original conversation and audience kind
  operation: closed domain variant with canonical target and input reference
  authority: references to existing admission and policy facts
  execution: existing owner, attempt, budget and domain record reference
```

Only trusted admission creates the binding. Model input contains the proposed
operation and its arguments, never requester, destination, grants, worker
identity or success. The action ID is stable under delivery retry. Several
operations in one person turn need distinct admitted operation IDs; do not
reuse today's one-Ship-action-per-message key for a batch.

The operation variants are initially an existing Ship task and a private
source task; a fenced command uses its registered argument and result schema.
Each variant supplies its validator and existing domain record reference. Do
not make an unbounded `{agent, tool, args}` escape hatch. Repository, provider
resource and publication destination are separate fields selected by operation
semantics. Evidence can inform them but cannot overwrite them.

The store owns immutable input identity. A repeated request returns the same
binding; different input under the same identity conflicts. A model retry of
an already admitted request reads its saved payload rather than replacing it
with a newly generated brief. An explicit person amendment is a new revision
on that action under its existing owner, subject to its current state.

## Separate execution, outcome, and delivery

Expose a closed union from producer facts, not a generic success Boolean:

```text
Admission = admitted(binding) | refused(reason) | unavailable
Execution = queued | running(owner, attempt) | settled(domainOutcome)
          | unresolved(reason, reconciliationReference)
Delivery  = pending | delivered(messageReference, outcomeRevision)
          | withheld(reason) | unresolved
```

Domain outcomes remain domain types. Ship reports the original unit ending
and verified PR/head; a source task reports a bounded result plus source,
query/window, freshness, completeness and access provenance; a command returns
its validated result or refusal; a review separates verdict, posting intent,
remote review receipt and remediation obligation. A worker's answer is
untrusted evidence, not proof that an external effect happened.

Persist operation identity before dispatch. Persist settlement before offering
its return. Neither settlement nor delivery is reconstructed from prose,
`replyOk`, `status=completed`, HTTP 200, or a tool's `isError=false` alone.
Legacy records keep an explicit unverified outcome; do not infer permission
or manufacture a successful receipt when fields are absent.

## Execution and return sequence

1. Bind the proposal to the current verified person turn. Resolve the operation
   target using that domain's schema. Check the existing policy and the selected
   agent or command before durably claiming the action.
2. Schedule the existing executor under the action reference. Agent execution
   enters `dispatch()`; commands enter the command registry. Keep current
   ownership, budgets, stop, review and publication gates.
3. Before each effect, validate current grants, connection incarnation,
   resource scope, expected version and owner fence. The original request
   revision proves which request was admitted; a later unrelated person
   question must not cancel legitimate running work. Explicit stop/revoke or
   scope amendment changes the action through a typed transition.
4. The domain producer records a validated outcome under its current fence.
   A private worker records no Slack destination and cannot publish to Slack.
5. A durable pending-return reference wakes the original main conversation.
   It contains only the action identity and outcome revision, never the
   private result. It is a control event, not a new person request or an
   app-authored grant. It neither revokes a legitimate requester merely for
   arriving nor acquires authority to start unrelated work.
6. On a fresh main turn, load the action by the original requester and thread,
   resolve current permissions, and read the authorized outcome. Recheck the
   audience and relevant source permissions immediately before delivery.
   Save a delivery receipt independently of the domain outcome.

After restart or compaction, resume from durable action references and reread
authorized results. A summary may retain a reference; it cannot retain a
grant or make unknown private source text safe. Until all relevant provenance
is durable, keep the existing fail-closed behavior for old private sessions.

## Provider scope is enforced, not inferred

Source selection preserves exact registry tier, requester, server identity,
credential incarnation and allowed agent. Conflicting scopes do not union
permissions or fall back to a broader credential after denial. Rekey/removal
invalidates the prior capability. Store nonsecret stable incarnation IDs,
not credentials, endpoint secrets or process-local HMAC stamps.

A source operation's allowed effects and its retry semantics are different
facts. A read request may use a generic executor only when the provider or a
trusted typed adapter enforces that read scope over every reachable nested
operation. Generic code is not inspected with phrases or regular expressions
to decide whether it can write. Explicit writes require a registered typed
effect, the requester's current authority, and provider-enforced limits.

An arbitrary writable MCP session cannot supply the narrow capability merely
by being assigned to `general`. The valid outcome is a named missing
capability until its provider or adapter can enforce the requested operation.
Connection success, catalog discovery and an offered tool are separate facts.

## Retries and exactly-once limits

Atomic local claims and generation fences provide one logical action and one
current writer. They cannot alone guarantee one external effect. Each effect
adapter must declare and implement one of:

- Provider idempotency with the persisted operation key.
- Authoritative reconciliation by exact resource/version and operation marker.
- No safe replay after an ambiguous attempt.

A timeout, process death, or lost response after a possible write records
`unresolved`. Reconcile using the same action and attempt; a new tool call ID
does not authorize another write. An incomplete read, eventual-consistency
miss, lease expiry, or missing response is not proof that nothing happened.
The same rule applies to Slack publication. Claim exactly-once only where the
adapter can prove it; otherwise retain delivery uncertainty and avoid a blind
second post. Stop/revocation can prevent future effects without undoing an
already committed external effect, whose receipt must remain readable within
current access policy.

## Delivery slices and proof

The first slice retains bounded Ship outcome facts beside the existing unit
ending. The driver projects producer facts before rendering the report; the
settlement route validates their kind and PR binding and stores them with a
full-row compare-and-swap. The store refuses ordinary whole-row changes over
a typed ending, including wake writes and instance replacement; an exact
checked replacement can advance recovery. Conflicting batches commit nothing.
A private settlement saves its original report delivery ID before append, so
conflicting retries cannot replace the outcome or append a second report.
The private progress reader returns it through the existing requester/thread
checks. Missing projections remain unverified. Merge readiness requires final
PR/check facts and is deliberately unprojected until those facts have a bound
representation. See [delegated outcomes](../reference/specs/delegated-outcomes.md).

The next slice factors the joined requester/thread binding reader for status
and private progress and adds the original coding admission/seed receipt.
Persist transfer facts at durable claim promotion, joining the original
brief identity and digest, composed request digest, child run, coordinator
step, requester and repository/ref. A saved private input or attaching run
reservation proves preparation, not admission. Do not search rendered prompt
text for expected fields. Existing truncated or legacy inputs remain
unverified. This proves transfer, not model comprehension or the truth of an
analysis.

A subsequent slice adds one constrained private source-task implementation and
the durable return event. It must prove the same requester, source scope,
original destination, worker silence and restart recovery end to end before
the tool is exposed. Keep unavailable providers explicit. The command and
review migrations consume this binding vocabulary through their existing
owners; do not couple their rollout to all providers supporting writes.

Write failing behavioral tests before each source slice:

| Case | Required result |
| --- | --- |
| Replay before dispatch and after acknowledgment loss | Same action and execution identity; no replacement writer. |
| Changed target, input, scope or destination under one key | Conflict before any effect. |
| Foreign actor/thread, impersonation, revoked audience or source | No private existence, result or effect leakage. |
| Revocation during an asynchronous read or effect preparation | Fence prevents the next effect or delivery. |
| New unrelated person turn during work | Existing work retains its authority and owner; a new claim uses the new revision. |
| Restart at claim, admission, settlement and return boundaries | Reconcile durable state, preserve budgets and one pending return. |
| Compaction omits the original prose | Typed identity and safe revalidation work; prose cannot restore grants. |
| Provider accepted a write but response was lost | Same-key reconciliation or unresolved; never blind replay. |
| Worker says success without a producer receipt | No verified effect outcome. |
| Stored input has no admitted child, or wrong child identity | No coding-transfer proof. |
| Private source contains instructions to change destination | Content stays data; original destination is unchanged. |
| Review approved, post withheld, or PR already merged | Distinct typed facts; no inferred posting or repair permission. |

Run common persistence cases against the existing in-memory and Worker-backed
implementations. Then validate each containing production build in the
original acceptance lane with an actual requester/action/outcome/delivery
readback. A passing unit test, merged PR, or deployed version is not that
receipt.
