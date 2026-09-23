---
title: Request context, operation target, publication destination, and evidence references are independent facts
status: proposed
date: 2026-09-23
pattern: Immutable typed request envelope — request acceptance preserves context and initiator, operation semantics select each target and publication destination, and authorized evidence can inform but never retarget an effect
---

# Request context, operation target, publication destination, and evidence references are independent facts

**The ask.** Decide how a request that names several repositories or pull requests reaches an effect without turning a citation, thread fact, channel default, publication address, or token position into authority over what runs. Issue #2238 supplies the concrete failure: a request addressed to one repository cited a pull request in another, the accepted operator bind named the addressed repository, and the run was created in the cited repository. Written for an engineer who knows [record 0057](0057-the-operator-is-the-one-door-a-model-binds-every-chat-input-and-deterministic-code-authorizes-fences-and-executes.md), the repository resolver, the unit machine, the effect seam and pinned plans. Success criteria:

1. Admission produces one immutable typed envelope that preserves the request context and initiating identity and contains one or more typed operations. Each operation independently names its target, publication destination, evidence references, expected versions and budget.
2. Operation semantics assign those roles. A review targets the pull request being reviewed; implementation targets the repository being changed; a plan may publish its parent in a planning repository while its unit issues and pull requests publish in unit repositories. Token order and one global repository ranking assign none of them.
3. Evidence is non-authoritative for target selection. An issue, pull request, file, image, thread or run supplied as evidence can inform an operation only after its reader is authorized; it cannot rewrite the target, destination, initiator, grant, plan identity or effect fence.
4. The envelope survives admission, dispatch, resume, child creation and effect execution by identity and digest. A later stage may refine a field only by producing a new validated envelope or a typed operation transition; it never reparses rendered prose to recover authority.
5. Existing authorization and grants, leases and budgets, expected-head and expected-version fences, durable plan pins, single-owner unit rules and the merge door keep their authority. The envelope carries facts to those guards; it does not replace or relax them.
6. A mixed request that asks for two acts becomes two typed operations with separate targets and destinations. It is never made representable by choosing one repository that all later stages inherit.

## TL;DR

Switchboard currently compresses several independent repository roles into `RepoContext.repo`, then tries to recover intent by ranking message tokens, operator output, thread history and config. That is why a foreign pull-request citation can outrank an accepted bind, and why reversing two ranking rungs would merely choose a different wrong answer for a valid cross-repository request.

The bet is one immutable admitted envelope. It preserves request context and initiator, carries a non-empty list of typed operations, and gives each operation an explicit target, publication destination, authorized evidence references, fences and budget. The operation kind determines which source fills each role. Dispatch and effects consume those typed fields without reparsing prose. Evidence may inform an act but can never retarget it. Doing nothing leaves write identity, review publication and plan projection dependent on a reader remembering the current global precedence chain.

## Today at surveyed `6237ab3f13358f401d0c5280705fa894a9a6431e`

This matrix is the source-backed survey from explore run `0600fd56-3267-4242-a338-df648f4c0d81`, checked against source receipt `4404220e-40d8-4bf9-b48a-03a7d8f78617`. The rows deliberately describe that SHA, not an inferred production state or a later implementation.

| Fact at `6237ab3f13358f401d0c5280705fa894a9a6431e` | Source | Consequence |
| --- | --- | --- |
| The channel adapter already supplies `channelId`, `threadKey`, `userId`, source URL and authentication facts, and provision writes the channel, thread, user and resolved repository on the run. | `src/core/types.ts`, `src/core/dispatch/provision.ts`, `src/core/runRecord.ts` | Request context and initiator exist as typed facts, but they are not carried beside target, destination and evidence in one admitted object. |
| The dispatcher computes one `inheritedRepo` from `operatorRepo ?? newestFinishedRun.repo ?? channel.repo` and passes all three provenances under the `operatorRepo` parameter name. | `src/core/dispatcher.ts:703-706,912-915,1087-1091,1218-1222` | An imperative operator bind, a thread execution fact and a configuration default become indistinguishable before repository resolution. |
| The current-message `strongNow` chooses the first pull-request repository, then another strong repository token, then an addressed repository; only after that does it consider the typed repository supplied by the dispatcher. | `src/core/repoContext.ts:391-395,600-611` | A cited `owner/name#N` can outrank the accepted bind. The first matching token has behavioral authority even when it appears inside a fixture or counterexample. |
| `RepoContext` has one `repo`, one optional `ref` and one optional `pr`; flags such as `prFromMessage`, `prIsThreadOwn`, `prFromRecord` and `refFromPr` recover provenance after the values have shared the same aggregate. | `src/core/repoContext.ts:98-175` | The type cannot simultaneously express “operate in A, cite B#5, publish in A” or “context A, review and publish to B#5” without one role displacing another. |
| Provision uses `repoCtx.repo` for the run label, run row and executor selection. | `src/core/dispatch/provision.ts:430-480,857-905` | A resolver mistake crosses into workspace identity and therefore into the repository where a write-capable child can act. |
| Review publication derives its target from the same `repoCtx.repo` and `repoCtx.pr` used to prepare the review, with expected-head guards around the post. | `src/core/reviewRound.ts:780-850`, `src/core/reviewPost.ts` | The head fence is valuable and remains, but execution repository and publication destination are not independently representable. |
| Coding pull-request publication uses the resolved repository or, when absent, the workspace origin; the target repository is not a separately admitted publication fact. | `src/core/codingPrPostStep.ts:660-735` | A post-step can reconstruct where to publish from execution residue instead of consuming an immutable destination selected at admission. |
| The coordinator contract still represents a seeded plan by repository path and a generated task by the absence of that path, while accepted record 0077 requires canonical `(planId, digest)` pins and a provider URL. | `src/core/coordinator/contract.ts:345-398,462-511`; [record 0077](0077-a-plan-becomes-a-durable-work-record-before-code-starts.md) | The envelope must preserve record 0077's destination split as that migration lands: canonical plan bytes, parent publication and each unit's repository are different facts. This row does not claim the pin-only design is implemented at the surveyed SHA. |

The comments on issue #2238 correct two tempting readings of this matrix. The accepted bind was neither absent nor ignored; it was passed, read and outranked. Refusing every mismatch would therefore have refused the recorded requests instead of honoring their correct typed bind. The fresh occurrence in comment `5789983230` is the minimal reproducer: a counterexample quoted inside a read-only design request became the run's repository and pull request even though the operator had accepted a different repository.

The earlier “seven instances” table in comment `5784803390` is useful provenance for the broader design smell, not a claim that seven unresolved defects share this decision's scope. At the surveyed SHA, some rows already have local corrections—for example the provider recovery cursor work is typed and durably checkpointed, and review attachment carries separate expected and observed head facts. Silence at the door and duplicate automatic-review ownership are adjacent lifecycle defects: they need explicit outcomes and ownership respectively, but neither becomes clearer by pretending it is a request-target-publication role. This record owns the envelope boundary only.

## The decision

### One admitted envelope, one role for every field

Admission validates and persists this semantic shape before a repository workspace, child or effect is selected:

```text
AdmittedRequestEnvelope
  envelopeId
  schemaVersion
  requestContext
    surface and source address
    channel / conversation / thread identity when present
    contextual repository and plan references when present
  initiator
    resolved actor identity
    authenticated-as / on-behalf-of identity when present
    client surface and request identity
  operations[]  // non-empty, stable operation ids
    kind
    target
    publicationDestination
    evidenceReferences[]
    fences
    budget
  sourceDigest
```

`requestContext` answers where the request arrived and which conversation or work record it continues. It can carry a contextual repository because a thread or channel may be about repository A, but that repository is not thereby the target of every operation.

`initiator` answers whose request this is. It preserves the resolved identity and delegation chain, not a snapshot of permission. Existing policy checks continue to resolve current grants at their established boundaries. A later revocation remains effective, and a child, plan issue, label, repository mention or publication destination cannot lend authority to the initiator.

Each `operation` is a discriminated union. Its `kind` defines the legal target and destination shapes and the rule that fills them:

```text
review
  target: PullRequestTarget(repository, number, expectedHead)
  publication: ReviewDestination(repository, number) | ChannelOnly

code
  target: RepositoryTarget(repository, base, expectedBase?)
  publication: PullRequestDestination(repository, base, head) | NoPublication

plan
  target: NewPlanTarget(planIdReservation, sourceDigest)
        | PinnedPlanTarget(planId, digest)
  publication: PlanProjection(parentRepository, unitRepositories[])

issue/comment/connector/effect
  target and publication variants named by that operation's contract
```

The examples are semantic commitments, not the final TypeScript schema. A destination may equal a target, as a review posted to the reviewed pull request usually does, but equality is validated by that operation's rule rather than achieved by storing one value twice or recovering one from the other. A product may deliberately support a distinct destination—for example a cross-repository plan projection—only through a variant whose policy and adapter define it.

`evidenceReferences` are typed locators with source kind, canonical resource identity, observed version or digest when available, authorized reader and completeness state. They may name repositories and pull requests different from the target. Reading them is subject to existing access rules and untrusted-content handling. Their content is never parsed into an initiator, grant, operation target, destination, plan identity or fence. Unreadable or incomplete required evidence becomes a named question or refusal for that operation, never an invitation to substitute another repository.

The envelope is immutable after admission. Storage and transport carry `envelopeId`, schema version and digest; child requests and effects carry the envelope reference plus their stable operation id. Human-readable labels, branch names, rendered directives and prompts are projections. A component that receives only prose is not allowed to reconstruct an authoritative field from it. A legitimate amendment re-enters admission and produces a new validated envelope linked to the prior one; it does not mutate the bytes an in-flight operation was admitted against.

Planning is the staged case. A new-plan operation is admitted against the source digest, reserved plan identity and parent publication destination. Its validated pin is a typed result. Unit operations derived from that immutable pin are admitted in a successor envelope linked to the initiating envelope; their targets and unit destinations come from the validated artifact, never from reparsing the parent issue. Thus each admitted operation has one immutable envelope through its effects without pretending a not-yet-produced plan digest was known at the first request.

### Operation semantics, not precedence, bind the roles

The admission interpreter may use the request's language to propose operations, but deterministic validation decides whether each proposed operation has the fields its kind requires. The resolution algorithm is therefore per operation:

1. Identify the requested operation kind or split the request into several kinds.
2. Resolve the target using only target-bearing syntax and typed continuation facts valid for that kind.
3. Resolve the publication destination under that kind's contract.
4. Collect remaining authorized references as evidence without letting them compete for the target or destination slots.
5. Validate initiator, fences and budget; persist the envelope before dispatch.

There is no cross-kind list saying address beats pull request, pull request beats bind, newest token beats thread, or any reverse ordering. For a review, a pull request can be the explicit target while `in repository A` describes the request's context. For code, `in repository A` can be the target while a pull request in B is evidence. Those are opposite precedence outcomes only if both operations are forced through one `repo` slot; in the typed model they are ordinary consequences of different operation kinds.

Ambiguity is handled at the role, not by globally refusing every mismatch. If a review names two plausible target pull requests, admission asks which target. If code names repository A and cites B#5, there is no mismatch: A is the target and B#5 is evidence. If a destination is not legal for the chosen target, validation refuses that operation before dispatch and names the two typed fields. A refusal never silently substitutes one for the other.

### The envelope reaches the effect seam intact

Dispatch selects a workspace from `operation.target`, never from request context or evidence. Resume and re-issue reload the stored envelope and current durable operation state; they do not rescan the original prose. A spawned child inherits the same envelope identity, initiator and operation id. It may receive rendered context for understanding, but the runner passes target and destination through typed execution context.

[Record 0074](0074-a-side-effect-crosses-one-typed-seam.md)'s effect command adds the operation reference to its existing `effectId`, expected versions and payload. The runner checks that the requested effect is legal for that operation, resolves fresh target and destination facts, applies existing ownership and authorization, performs the existing expected-head or expected-version fence and records the receipt. An evidence reference can be present in the receipt as provenance; it cannot select the endpoint.

This preserves rather than replaces the existing guards:

- **Authorization and grants:** the policy table continues to decide for the resolved actor and operation. The immutable initiator identifies whose current authority to ask about; it does not freeze a grant or let a service, issue author or plan projection stand in for the person.
- **Budgets and leases:** each operation carries its admitted cap and the unit machine still carves bounded child leases. Splitting a mixed request does not duplicate or reset the parent budget.
- **Expected-head and effect fencing:** review, push, pull-request publication and connector writes retain their fresh-head/version checks and idempotent effect identities. A correct target does not waive a stale-head refusal.
- **Durable plan pins:** execution still loads the canonical `(planId, digest)` from the coordinator store. A planning issue, unit issue, pull request or Project item is a destination or evidence reference, never a substitute pin.
- **Merge door:** publication of a pull request grants no merge authority. The door still re-reads the initiator's effective grant, exact head, approval, checks, queue and repository rules immediately before any merge attempt.

### Four hard-case traces

#### Review in repository B from context A

1. A request arrives in a thread whose context is repository A: `in owner/a: review owner/b#5`.
2. Admission creates one `review` operation. `requestContext.contextualRepository = owner/a`; the operation target is `PullRequestTarget(owner/b, 5, headB)` because review semantics make the reviewed pull request the target.
3. The publication destination is `ReviewDestination(owner/b, 5)`. The channel thread in A remains the conversational reply surface; it does not become the GitHub publication target.
4. Dispatch attaches repository B at `headB`. The reviewed-head guard re-reads B#5 before publication. The verdict posts to B#5 and the receipt links back to the request context in A.
5. No rule says “pull requests always win”. The pull request wins this target slot because the operation is review.

#### Implement in A with a pull request in B only as evidence

1. A request says `in owner/a: implement the cache fix using owner/b#5 as the example`.
2. Admission creates one `code` operation targeting repository A and a pull-request destination in A. `owner/b#5` becomes an evidence reference with its observed head and authorized reader.
3. Dispatch attaches A. The evidence reader may fetch B#5 into the model's untrusted context, but neither its repository nor head enters executor selection, branch ownership or publication.
4. The runner fences and publishes the implementation branch and pull request in A. Its receipt may cite B#5 as provenance.
5. No rule says “addresses always win”. The address fills the code target because code semantics say it does; a future explicit review operation over B#5 would bind differently.

#### One mixed request becomes two operations

1. A request says `implement the cache fix in owner/a using owner/b#5, then review owner/b#5`.
2. Admission creates `op-code`: target A, pull-request destination A, evidence B#5; and `op-review`: target B#5, review destination B#5. Both retain the same request context and initiator but have distinct ids, fences and budget slices.
3. The orchestrator may order the operations as requested, but no shared mutable `repo` changes from A to B. Each dispatch reloads its own operation.
4. If `op-code` fails, policy determines whether `op-review` still runs; changing that sequencing decision never changes either operation's target.
5. Receipts name the operation id, so evidence from one cannot be mistaken for authority over the other.

#### Cross-repository plan publication and implementation

1. A new-plan operation is admitted against its source digest, reserved plan identity and parent destination. Planning validates and pins plan `(P, digest)` in the coordinator store. The request context and human parent publication are in planning repository P-views; neither is the canonical plan.
2. The plan operation's publication destination creates or adopts one parent issue in P-views. Its stable URL attaches to the pin under record 0077's expected-version rule. The pin admits a linked successor envelope for the unit operations; no mutable field is filled in behind the first envelope's digest.
3. Unit U-A targets repository A. Its unit issue and implementation pull request publish in A. Unit U-B targets B and publishes its issue and pull request in B. The parent links to both as provider projections.
4. Every unit operation carries the same plan ref as evidence/context and its own target, destination, initiator and effect fences. A unit issue cannot retarget the unit; the planning parent cannot confer write or merge authority in A or B; a pull request cannot become the plan pin.
5. Partial failure creating a unit issue, relation, label or Project item is retried as publication reconciliation. It cannot invalidate the canonical pin or move another unit's operation into the planning repository.

The property across all four traces is not that one repository always wins. It is that every repository is carried under the role it actually plays, and only the operation's contract may use that role to select an effect.

## Immediate containment is smaller than the architecture

Issue #2238 needs a bounded correction before the full envelope exists. Preserve the operator's accepted repository bind separately from thread inheritance and channel default. When that bind has already selected the current run repository, honor it before scanning free-text references; a foreign repository or pull-request reference contributes prose evidence unless it matches the bind. Refuse if the selected repository cannot be honored. Do not silently substitute.

That containment closes the recorded wrong-repository write exposure and the fresh quoted-counterexample occurrence. It is intentionally incomplete. It cannot faithfully represent the review-in-B/context-A trace, split a mixed request, or publish a cross-repository plan. Until typed operations exist, those cases need an explicit unambiguous operation bind or a named refusal rather than another ranking rule. The containment must not be advertised as implementation of this decision.

The external issue remains the implementation tracker for both containment and architectural work. This proposal creates no implementation plan under `docs/plans/`, changes no config and authorizes no production probe.

## Why not X

**Why not one global ranking?** Review in B from context A and implementation in A using B only as evidence require opposite results over the same two repository tokens. Any global order fixes one by breaking the other. Adding more rungs makes the rule harder to audit without adding a missing role.

**Why not address-always-wins?** It makes the implementation trace work and misroutes the review trace to A or strips its B publication target. An address can be context or target; the operation decides which.

**Why not pull-request-always-wins?** That is the mechanism behind issue #2238. A pull request is often evidence in coding, planning and incident analysis. Its existence cannot grant its repository executor identity.

**Why not add only `boundRepo` beside `inheritedRepo`?** That is the right bounded containment because it preserves the accepted bind's provenance. It still leaves context, target, destination and evidence compressed once the request needs more than one repository role, and it cannot represent two operations in one request.

**Why not refuse every bind/reference mismatch?** The recorded issue would have become a refusal even though the accepted bind was correct. The code-in-A/evidence-B trace is not contradictory, and the review-in-B/context-A trace is not contradictory. Refuse only when two candidates compete for the same typed role or a role violates its operation contract.

**Why not sanitize the prompt or remove examples before repository resolution?** The fresh occurrence proves a quoted counterexample can trigger the resolver, but there is no complete sanitizer for examples, tables, links and attached sources. Sanitization also destroys legitimate evidence. Typed evidence keeps the content and removes its authority.

**Why not infer the roles from the preset?** A `review` preset strongly constrains one operation kind but does not identify the reviewed pull request, distinguish channel-only publication, split a mixed request or assign plan projections. Preset inference is useful input to admission; it is not the durable wire format.

**Why not put this solely in record 0074?** Record 0074 begins after an operation has already been selected and defines how one effect is fenced, performed and receipted. Issue #2238 happens earlier: evidence has already rewritten executor identity before an effect command exists. This record supplies the facts the effect seam must consume and does not alter its execution model.

**Why not put this solely in record 0077?** Record 0077 decides canonical plan bytes, human projection and plan/code/review composition. The same target confusion exists for standalone reviews, code requests and comments with no plan. This record generalizes the roles while preserving record 0077's pin and publication split.

**Why not classify every overloaded value as one program of work?** “Make independent facts distinct” is a design test, not a useful ownership boundary by itself. The seven-instance comment joined repository roles, head comparisons, absence states, provider cursors, salvage intent and door silence. Some have already been corrected locally; silence and duplicate-review ownership have different lifecycle invariants. This record is intentionally narrower: authority-bearing request and repository roles from admission through effect.

## Relations and boundaries

[Record 0057](0057-the-operator-is-the-one-door-a-model-binds-every-chat-input-and-deterministic-code-authorizes-fences-and-executes.md) remains the interpreting door: it proposes the typed operations and deterministic admission validates them. [Record 0069](0069-the-one-door-has-one-execution-path-a-bind-runs-clicks-or-routes-a-violation-is-re-asked-a-disagreement-floors-and-no-chat-surface-hands-back-a-line-to-retype.md) keeps one execution path; this record makes that path carry an envelope rather than a rendered line whose repositories are rescanned.

[Record 0073](0073-the-ship-pipeline-dissolves-into-the-orchestrator-the-unit-machine-is-the-deterministic-atom-and-judgement-composes-units.md) still lets the orchestrator choose bounded acts from evidence, while each chosen act remains a typed operation with deterministic guards. [Record 0074](0074-a-side-effect-crosses-one-typed-seam.md) still owns effect execution and receipts. [Record 0076](0076-a-verdict-and-its-approval-belong-to-the-head-they-reviewed.md) still owns current-head review lifecycle and its single automatic owner; this record only ensures the review target and publication destination reach that lifecycle without evidence retargeting them. [Record 0077](0077-a-plan-becomes-a-durable-work-record-before-code-starts.md) still owns canonical plan pins and provider projections.

The routing, resident-repository, review, ship, authorization, run-history, pull-request and PR-description specs remain the behavior surfaces an implementation must update. This proposal changes none of their rows because it ships no behavior. The external issue carries implementation decomposition and receipts; no repository plan ledger is created.

Not decided here: the final TypeScript field names, wire encoding, storage table, migration sequence, compatibility window, operation-planning model, or implementation units. Those belong to the external tracker after acceptance. Also not decided: silence at the door, provider-recovery cursors, salvage intent, duplicate-review ownership or a universal “split every overloaded value” program.

## Acceptance

This record stays `status: proposed`. The maintainer who opened issue #2238 owns acceptance; an agent, merge, issue label or implementation commit cannot accept it. Acceptance must separately judge the architectural bet, not merely the bounded containment.

A cold reader passes the decision when, given only this record, they can explain all four hard cases without inventing a repository ranking; state why evidence cannot retarget an operation; name the initiator and current-grant rule; and explain why a plan parent, unit issue, implementation pull request and canonical pin may live in different repositories or stores without lending authority to one another.

## Sources

- Issue #2238 and comments `5784803390`, `5785531969` and `5789983230` — the seven-instance hypothesis, the source correction that the accepted bind was heard but outranked, and the fresh quoted-counterexample occurrence.
- Explore run `0600fd56-3267-4242-a338-df648f4c0d81` and source receipt `4404220e-40d8-4bf9-b48a-03a7d8f78617` — the source-backed role matrix surveyed at `6237ab3f13358f401d0c5280705fa894a9a6431e`.
- `src/core/repoContext.ts`, `src/core/dispatcher.ts`, `src/core/dispatch/provision.ts`, `src/core/reviewRound.ts`, `src/core/reviewPost.ts`, `src/core/codingPrPostStep.ts` and `src/core/coordinator/contract.ts` at that SHA — the ranked resolver, collapsed inherited repository, executor binding and reconstructed publication paths described by the matrix.
- Records [0057](0057-the-operator-is-the-one-door-a-model-binds-every-chat-input-and-deterministic-code-authorizes-fences-and-executes.md), [0069](0069-the-one-door-has-one-execution-path-a-bind-runs-clicks-or-routes-a-violation-is-re-asked-a-disagreement-floors-and-no-chat-surface-hands-back-a-line-to-retype.md), [0073](0073-the-ship-pipeline-dissolves-into-the-orchestrator-the-unit-machine-is-the-deterministic-atom-and-judgement-composes-units.md), [0074](0074-a-side-effect-crosses-one-typed-seam.md), [0076](0076-a-verdict-and-its-approval-belong-to-the-head-they-reviewed.md) and [0077](0077-a-plan-becomes-a-durable-work-record-before-code-starts.md) — the boundaries this proposal preserves rather than absorbs.

## Public hygiene

This record carries public repository paths, public issue and record numbers, one surveyed public-tree SHA and opaque survey receipt ids needed to audit its claims. It identifies the acceptance owner by their public issue role rather than by personal name. It contains no Slack channel, user or message id, private URL, credential, customer, sibling repository name or unpublished commercial fact.
