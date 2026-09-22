---
title: A plan becomes a durable work record before code starts
status: proposed
date: 2026-09-22
pattern: Store-canonical plan — one source-neutral front door pins a validated artifact; a provider URL addresses its human projection; execution composes plan, code and review from the pinned copy
---

# A plan becomes a durable work record before code starts

**The ask.** Decide how a plan becomes executable work without first becoming a file or branch in the repository. The front door may receive plain text, files, images, an issue, a thread or any mixture of them. It must turn that material into the same full plan shape, validate it, pin it durably and hand one stable reference to execution. A handed-off plan may contain one or many units and must keep the same resume, re-issue and work-preservation behavior as today's checked-in plan. This record also decides where the plan lives, where merge authority comes from, how `ship` composes its agents, and whether a general agent-to-outcome abstraction is needed now.

Written for an engineer who knows [record 0057](0057-the-operator-is-the-one-door-a-model-binds-every-chat-input-and-deterministic-code-authorizes-fences-and-executes.md)'s front door, [record 0073](0073-the-ship-pipeline-dissolves-into-the-orchestrator-the-unit-machine-is-the-deterministic-atom-and-judgement-composes-units.md)'s unit-machine boundary and the current coordinator store. Success criteria:

1. Planning creates no repository branch, commit or pull request. The first push to origin contains implementation work produced after a validated plan was handed to execution.
2. Text, files, images, issues and threads all enter one planning path and leave it as one validated, source-neutral `PlanArtifact` plus a stable `PlanRef`. A repository file is an ordinary file input, never an execution address.
3. Execution has one input path for every plan. One or many units get the same stable identities, unit machine, resume, re-issue and durable-work adoption rules; no generated-plan or repository-path special case remains.
4. `ship` composes `plan → code → review`. `plan` has its own exit criteria and durable artifact, and the `coding` agent is renamed `code` without changing the deterministic code/review/fix/checks/merge boundary.
5. Merge policy is requested by the initiating client but can never exceed the initiating actor's effective authority. The first cut proves the boundary with one global automerge setting; later client-specific policy changes do not redesign identity or execution.
6. The coordinator store is canonical for the exact validated artifact execution uses. A published provider URL gives people the stable address, discussion and editable view; replacing GitHub with Linear does not change the schema or execution.

## TL;DR

A repository plan is the wrong hand-off artifact. It requires a branch and push before implementation starts, makes a path masquerade as a stable identity, and has created two execution paths: checked-in multi-unit plans and generated one-unit plans. The bet is one planning boundary and one execution input. A `plan` agent turns any admitted source bundle into a complete typed plan; deterministic code validates and pins its canonical bytes in the coordinator store, publishes a human view, and returns the plan id, digest and provider URL. Execution always loads the pinned copy.

GitHub Issues is the first address, not the source of truth: one parent issue is the plan's stable landing page, unit issues are its native work breakdown, a GitHub Project is the portfolio view and labels are an orthogonal grouping axis. Edits re-enter through `plan` and produce a newly validated pinned digest. Publication must create the parent URL before `code` starts, but incomplete sub-issues, labels or project membership are retryable projection defects, not execution-integrity failures. `ship` becomes `plan → code → review`; the initiating actor remains the authority principal; and a general abstraction that maps arbitrary agents to arbitrary outcomes is deferred because three explicit contracts prove the value with less machinery.

## Today at the proposal's base

| Current fact | Consequence |
| --- | --- |
| A seeded plan is read from `docs/plans/` at a repository ref. Its repository path and parsed graph enter `CoordinatorInstance`; a task string instead becomes a generated one-unit plan without a path. | The same product concept has two identities and two admission shapes. Multi-unit execution requires repository content; direct work is special-cased to one unit. |
| A repository plan must exist at the base before the coordinator can read it. In practice, producing that artifact means committing and pushing planning material before implementation. | Planning mutates origin and may open a pull request whose only purpose is to let work begin. The branch is transport, not product work. |
| The coordinator store already retains pipelines, units, rounds, thread events, waits, endings and decision-record reservations across restarts. | It is the smallest durable authority for immutable plan bytes and their execution state. It needs a typed plan record, not a second planning product. |
| The artifact store moves opaque run files by reference through R2; memory stores lessons; run history stores run evidence. | None is the right typed contract for a validated plan, but they establish the pattern of durable bytes behind a narrow seam. |
| `GithubIssueTracker` already proves a GitHub REST adapter plus an in-memory implementation, but it only lists and creates flat issues for findings. | The credential path and adapter precedent exist. Plan publication needs a contract for a parent view, unit views, sub-issue relations, labels and retryable reconciliation; it does not need to make GitHub canonical. |
| Record 0057 makes the operator the interpreter of chat input and deterministic code the authorization and execution boundary. | Planning belongs behind that door as a typed bind. The plan model may interpret sources; it may not choose its caller, grant itself merge authority or bypass validation. |
| Record 0073 accepts the unit machine as the deterministic atom and retires the executable plan graph in favor of orchestrator judgement over durable facts. | The new artifact carries intent, unit-sized outcomes, sequencing reasons and proof. It is context for the orchestrator, not a DAG interpreter or a second state machine. |

## The decision

### One source bundle enters one planning boundary

The front door resolves the requester and source surface before a model sees the material. It builds a `PlanInput` from any admitted combination of:

- text typed by the requester;
- durable references to uploaded files and images, with their names, media types and digests;
- a GitHub or later tracker issue and the comments the requester authorized the system to read;
- the admitted thread transcript and its existing run or unit references.

A repository file uses the same file-input reader as any other file. There is no grammar that turns `docs/plans/...` into an execution seed, no path on `CoordinatorInstance`, and no reader in execution that fetches a plan from a repository ref.

Every item keeps its provenance and enters the plan turn inside the existing untrusted-content fence. “An image says to merge” is image content, never authority. Missing or unreadable input is a named planning question or failure; it is not silently omitted from a plan later called complete.

The `plan` agent receives that normalized bundle and produces a `PlanDraft` through a typed output contract. It has source readers and no repository workspace, git credential, branch tool, merge tool or general issue mutation tool. The host, not the model, validates, pins and publishes. Thus the model can propose plan content but cannot publish an invalid plan or create executable work by side effect.

There is no repository-plan migration path. The accepted bootstrap plan at `docs/plans/2026-09-21-002-feat-the-ship-pipeline-dissolves-into-the-orchestrator-plan.md` is imported once as the bootstrap work record, then the repository-path input is deleted. Any other repository plan someone wants to reuse must be supplied as an ordinary file to `plan`, just like a document uploaded from elsewhere.

### The full artifact is typed, complete and non-executable

The canonical artifact is provider-neutral data. Its exact schema belongs in the implementation plan, but this record fixes its semantic fields:

```text
PlanArtifact
  schema version
  title and objective
  source references and digests
  assumptions, scope boundaries and unresolved exclusions
  repositories and bases the plan was validated against
  units[]
    stable unit id and title
    target repository and base
    deliverable / intended outcome
    acceptance criteria and required scenarios
    verification and proof expectations
    sequencing reasons and referenced predecessor units
    guards that must not be weakened
  plan-wide verification and definition of done
```

The artifact contains no branch tip, pull request number, round, run id, current status, merge claim or mutable execution cursor. Those are execution facts. Sequencing entries explain why an order is expected and reference real unit ids; under record 0073 they do not become hard graph edges that can overrule fresh repository facts. If the orchestrator departs from them, it cites the fresh fact as that record requires.

The validator is deterministic and versioned. It checks the schema; source and repository references; unique stable unit ids; references between units; required outcomes, criteria, scenarios and verification; configured size and unit limits; and every repository-resolved guard the front door can know before work. Validation never asks whether prose “looks good”. A valid artifact carries the validator version and a digest of the canonical bytes.

A plan is **full** when every required field is present for every unit and every unavailable fact is represented as a named assumption or exclusion. It is **validated** when deterministic validation succeeds and the coordinator store atomically pins the canonical bytes under their plan id and digest. GitHub read-back is not part of validation and cannot change the digest. The `plan` agent exits successfully only after publication has produced the stable parent URL. An invalid draft, failed pin or missing parent URL does not start `code`; an incomplete unit projection can be reconciled without changing the pinned artifact.

### The store is canonical; the provider URL is the address

Execution receives only:

```text
PlanRef
  planId
  digest
  providerUrl
```

`planId` is the stable logical identity, `digest` selects exact canonical bytes, and `providerUrl` is the human address. The URL is neither a lookup key nor proof of content. Before any unit starts, execution loads `(planId, digest)` from the coordinator store and refuses a missing or mismatched pin. Resume and re-issue use that same pinned artifact even if GitHub changes or is unavailable.

The narrow `PlanStore` boundary owns pinning and loading typed artifacts and attaching their published address. Its durable implementation extends the store already used for coordinator state; an in-memory implementation proves the contract. It is not a generic bucket for arbitrary agent output. A later artifact gets its own contract unless it has the same validation, identity and execution semantics as `PlanArtifact`.

GitHub is a projection of the pin. Issue bodies can render the whole current plan, but execution never reconstructs canonical bytes or a digest from them. There are no per-unit append-only revision comments, no manifest comment and no opaque provider locator. A GitHub edit becomes input to a new `plan` turn; only deterministic validation and a new store pin make it executable. The stable parent URL may remain attached to the logical `planId` while its current rendered digest advances.

This split is deliberate rather than duplicated authority. The store answers “what exact bytes may this pipeline execute?” GitHub answers “where can a person read, discuss and edit the plan?” A provider outage after the parent URL exists cannot corrupt or block an admitted execution. A store outage always blocks admission because no external view may substitute for the canonical pin.

### GitHub Issues is the first published human view

The GitHub publication adapter behind `PlanStore` maps the information architecture to GitHub's own concepts instead of serializing execution state into issues:

| Switchboard concept | GitHub representation | Rule |
| --- | --- | --- |
| plan | one parent issue in the configured planning repository | The issue is the stable human address. Its body renders objective, boundaries, sources, plan-wide verification, units and the current pinned digest. |
| unit | one issue, attached as a sub-issue when the provider permits | The unit issue renders its deliverable, criteria, scenarios, verification, target repository and sequencing reasons. Cross-repository units live in their target repositories. |
| pipeline | one runtime execution pinned to a plan digest | A pipeline links to the parent issue and digest. It is not another issue hierarchy and does not rewrite the plan into statuses. |
| run, round, verdict and outcome | existing run records, unit facts, pull request and comments | Runtime evidence links back to the unit issue. It does not become more planning sub-issues. |
| project | a GitHub Project containing plan and unit issues | Projects supply portfolio views, fields and grouping. A project is not created per plan and is not the plan's identity. |
| cross-cutting group | an ordinary repository label on unit issues | Labels are the third axis for capability, area or workstream within a Project. They do not encode parentage, execution status, unit order or authorization. |
| implementation | the unit's linked pull request | Closing or merging can update the unit issue through normal GitHub relationships; the pull request remains the code-review object. |

GitHub currently caps a parent at 100 direct sub-issues. That provider limit never becomes an artifact limit or validation precondition. The adapter attaches direct sub-issues where it can and publishes remaining unit issues through the parent body's unit index and the shared Project. It does not invent nested group issues that have no meaning in `PlanArtifact`. One unit or ten thousand units use the same execution path; only the completeness of the human projection differs while reconciliation runs.

Publication is idempotent reconciliation because GitHub cannot atomically create the parent, all unit issues, relationships, labels and project membership. The adapter derives a marker from `planId`, creates or adopts the parent first, stores its URL on the pin, then converges the rendered parent and unit views. Once the parent URL exists, `code` may start from the canonical store. A failure after that point leaves a partially rendered but retryable view; it cannot make the plan invalid, alter execution or require digest reconstruction from GitHub. A later pass repairs missing unit issues, relationships, labels or project membership.

GitHub-specific node ids, issue numbers, GraphQL pagination and sub-issue mutations stay inside the adapter. The core sees `PlanRef`, `PlanArtifact` and typed store or publication failures. A Linear adapter may publish the same canonical plan into Linear's project, issue and relation concepts; the native-session work in pull request 1625 is a client integration, not permission to let Linear types enter the core plan contract.

### Why the durable runtime store wins the storage choice

An external work system was attractive because it already supplies stable URLs, discussion, hierarchy, project views, labels and search. Making it canonical, however, adds machinery exactly where integrity matters: immutable revision comments, a manifest, read-back reconstruction and a partial-publication transaction protocol. None is needed when Switchboard already has a durable store beside the coordinator and execution already depends on it.

Extending that store with immutable typed plan bytes is the least new authority. GitHub still provides all human affordances as a published view, and the provider URL remains mandatory before work starts. The design does not require Switchboard to build issue pages or a plan editor; edits happen in GitHub and re-enter through `plan`. It requires only that the plan turn read the edited view as source rather than mistake it for canonical state.

R2 remains the wrong direct abstraction. It gives durable opaque bytes and signed transfer, not typed compare-and-pin semantics beside pipeline identity. Memory is deliberately lessons rather than status, and run history is deliberately evidence of runs. `PlanStore` may reuse their storage mechanics internally, but its contract is named and validated for plans.

### `ship` is plan, code, review

`plan` becomes an agent in the same sense as `code` and `review`: a named run kind with a prompt, model policy, tool capability set, output contract, exit criteria and run record. It may be invoked alone to produce or revise a plan, and `ship` invokes it whenever the request does not already carry a valid `PlanRef`.

The top-level composition is:

1. **plan** — collect the admitted source bundle, produce the full `PlanArtifact`, validate and pin it, publish the stable parent URL and return `PlanRef`;
2. **code** — load the pinned artifact and, for each selected unit, run the existing deterministic unit machine's code/fix work from durable repository facts;
3. **review** — produce the head-bound verdict the same unit machine consumes before checks and merge.

This is a composition view, not a replacement state machine. Record 0073 still owns code → review → findings/fix → checks → merge, one owner, budgets, rebase-before-push, gates, reviewed-head equality and the merge door. `ship` and the orchestrator choose bounded acts around that atom. The plan artifact cannot mark a unit reviewed, green or merged.

The preset name changes from `coding` to `code` without a compatibility window in the core. Before the new enum ships, one migration rewrites persisted rows and config values. New config, cards, records, metrics and contracts then know only `code`. At most, the directive parser at the client edge accepts `coding` as an alias for one release and immediately emits `code`; no core union, branch or stored row accepts both names. Historical prose remains history rather than a runtime value.

There is no general “agent maps to outcome” framework in this decision. The three stages have different products: `plan` returns a validated durable reference, `code` returns repository/work facts through the unit machine, and `review` returns a head-bound verdict. A generic registry would erase those differences before a second pipeline demonstrates reusable semantics. Explicit stage contracts are the smaller proof. Generalization becomes warranted only when another composition needs the same lifecycle, authority and artifact rules without being ship.

### Authority comes from the initiator, not the artifact

The front door resolves an `ExecutionInitiator` before planning:

```text
ExecutionInitiator
  actor identity
  authenticated/on-behalf-of identity when present
  client surface
  request/thread identity
```

That envelope is durable beside the plan hand-off but outside model-authored plan content. A GitHub issue author, an issue field, a label or prose such as “automerge this” cannot replace it. Record 0057's deterministic path authorizes the bind as the resolved actor, and the merge door re-resolves that actor's current effective grants and repository facts when merge is attempted. Revoked authority stays revoked; a stored plan does not freeze an old grant.

Automerge has two independent questions:

1. **Policy:** did this client request allow Switchboard to attempt merge automatically?
2. **Authority:** may this initiating actor merge this repository and head now, under authorization, confirmation and repository rules?

The answer is automatic only when both are true. Policy can narrow authority but never widen it.

The first cut uses one installation-wide setting, `ship.automerge: off | on`, default `off`. `off` always parks at the person boundary. `on` permits the merge door to act only for a requester whose current effective authority already permits that exact merge; otherwise it parks with the ordinary person-required outcome. This single switch proves plan-to-merge identity without inventing a matrix of surface rules first.

Every client adapter must nevertheless populate `client surface` and a resolved actor now. Slack/chat supplies the current requester. MCP, CLI, HTTP and later clients must bind the authenticated caller or their valid on-behalf-of person before they may start work; a credential with no person remains that credential and receives only its grants. Once more than one client needs a different policy, configuration may resolve `ship.automerge` by surface using the existing layered-config discipline. The stored initiator shape and merge door do not change.

### Delivery order proves the collapse before adding surfaces

The implementation order is fixed because reversing it would preserve both paths behind new adapters:

1. **Collapse execution first, with no GitHub writes.** Introduce the typed artifact, validator and canonical pin; materialize every resumable generated task and repository-seeded pipeline—including `2026-09-21-002`—as a pinned artifact; make `(planId, digest)` the unit machine's only plan loader; then delete the generated-plan execution kind, repository-path request grammar and repository plan reader. This is a dark migration slice, not an executable admission boundary: it admits or resumes no `code` run until publication can complete `PlanRef` with the required URL. Existing branches, pull requests and coordinator unit facts remain durable but paused; the migration fails before deleting either reader unless every resumable pipeline has a pin.
2. **Add the GitHub-facing `PlanStore` publication adapter and open admission.** Publish or adopt a parent for each pin, attach its URL to form the executable `PlanRef`, then resume migrated work and admit direct tasks through the one pinned-artifact path. Reconcile unit issues, sub-issue relations, Project membership and labels without making any of them execution inputs. Re-home the bootstrap record's human view at this point; do not revive the deleted repository reader.
3. **Add the `plan` agent and source adapters.** Text, files, images, issues and threads produce the same artifact and pin through the same boundary. Add client-specific planning entry points only after they can all return the same `PlanRef`.
4. **Rename and policy cleanup.** Rewrite persisted agent names once, switch the core to `code`, optionally retain the directive-edge alias for one release, and introduce the global automerge policy over the already-preserved initiator.

Each slice builds on the same execution input. There is no period in which a checked-in plan can still execute beside a pinned artifact, and no migration flag that selects between them.

## Two hard-case traces

### A screenshot and a thread become three units without a plan branch

1. A requester asks in a thread, attaches a screenshot and links an issue. The front door resolves the requester, reads the authorized thread and issue, and stores source refs and digests. No repository workspace or branch exists.
2. The operator binds `ship` with that source bundle. Because there is no `PlanRef`, `ship` starts `plan`.
3. The plan agent returns three units across two repositories. One screenshot region is ambiguous, so its first result is a question rather than a partial artifact. The answer enters the same planning run's source bundle.
4. The host validates the complete second draft and atomically pins its canonical bytes and digest. It creates or adopts the GitHub parent issue and attaches that URL to the pin. Unit issue reconciliation begins but is not an execution read.
5. Only now does execution load the pin and start `code`. The first origin push is the first unit's implementation commit after its required rebase and fast gates; no plan branch or placeholder pull request existed.
6. The second unit is interrupted after pushing while one unit issue is still missing. Re-issue reads the same pinned artifact and the unit's branch/pull-request facts, then resumes the unit under record 0073. Publication reconciliation can repair the missing issue independently.

### A plan changes while a pipeline is active

1. Pipeline `P1` starts from plan `work-42` at digest `A`; its `PlanRef` carries the GitHub parent URL, but execution loads `A` from the coordinator store.
2. A person edits that issue and asks `plan` to revise it. The issue is source material. The host validates the resulting full artifact, pins digest `B` under the same logical plan and refreshes the published view. No running state is rewritten.
3. A re-issued unit in `P1` resumes from pinned `A`, its stable unit id and current repository facts. It does not need GitHub to reconstruct the plan.
4. New work may start pipeline `P2` at `B`. If the requester wants `P1` to adopt `B`, that is an explicit re-plan/reconcile decision: deterministic code compares unit identities and completed work and either records a safe digest transition or asks a question. A mutable issue edit is never an implicit mid-pipeline migration.
5. At merge, each pipeline uses its own initiating actor's current effective authority and the global policy. Digest `B` cannot grant `P2` a merge that its requester lacks, and digest `A` cannot preserve a grant later revoked from `P1`'s requester.

## The difficulty map

1. **Atomic canonical pinning at the hand-off boundary.** Validation, plan identity and canonical bytes must become one durable fact before execution can load them. A pin without bytes, bytes under a different digest or a pipeline admitted before the pin recreates the integrity gap that GitHub read-back machinery was trying to cover. GitHub publication is retryable projection work after that boundary, except that the stable parent URL must exist before `code` starts.
2. **One identity across planning, execution and re-issue.** The plan id identifies the logical plan; the digest identifies canonical bytes; stable unit ids identify deliverables; pipeline and unit rows identify execution. Collapsing any pair recreates mutable-plan or new-attempt bugs.
3. **Authority crossing a long-running pipeline.** The initiating principal must survive every child and restart while current grants are re-read at privileged acts. Copying a boolean “may merge” into the plan would turn revocation into theater.
4. **Source completeness and untrusted multimodal input.** A model can summarize a missing attachment as if it had read it. The source bundle, per-source digest and named omission rule make completeness testable.
5. **A useful provider-native view without provider-shaped semantics.** GitHub sub-issues and Projects should feel native, but no GraphQL node id, label convention or 100-child cap may leak into the core artifact. Partial projection must remain observable and retryable without blocking pinned execution.
6. **The `coding` → `code` rewrite.** Preset names appear in config, directives, durable rows, metrics, docs and user surfaces. A one-time persisted-row rewrite is safer than teaching the core two names; only the directive parser may carry a release-bounded alias.
7. **Fitting record 0073's rollout.** Its implementation plan currently names repository plans and the old agent. The bootstrap import and first collapse slice must replace those assumptions before any later units run.

## Why not the alternatives

**Why not keep plans in the repository but avoid a pull request?** Any origin-backed reference still requires a commit and push before code, couples planning to one repository and makes revision and execution identity branch-shaped. A local-only plan cannot survive the run. The problem is the repository as plan transport, not only the pull request.

**Why not make GitHub the canonical store?** It would require immutable revision comments, a manifest, canonical reconstruction and digest read-back to turn mutable issue views into executable bytes. The coordinator store already supplies durability at the execution boundary. GitHub adds the human address and affordances without becoming a second integrity protocol.

**Why not store a Markdown or JSON plan directly in R2?** R2 is a durable object store but not the typed compare-and-pin contract execution needs, and a signed blob URL is not the permanent human work address. Its mechanics may back `PlanStore`; its object key does not become `PlanRef`.

**Why not use GitHub Projects as the plan?** A Project is a portfolio with views and fields over many issues and pull requests. Creating one per request would fight that model, scatter project configuration and make cross-plan grouping harder. The plan is addressed by its parent issue; the project contains many plans and units.

**Why not encode units as a task list in one issue?** Checkboxes provide no target-repository issue, independent discussion or pull-request relationship. The parent may index every unit for scale, but native unit issues remain the published discussion object where available.

**Why not let each source type have its own planner?** The difficult contract begins after source reading: one full plan, one validator, one pin and one execution input. Separate planners would drift in required fields and recreate generated-versus-checked-in behavior under new names. Source adapters normalize; the plan boundary is singular.

**Why not let the plan agent create issues directly?** Provider writes are authority-bearing and multi-step. A model with a generic issue tool could mutate unrelated work or leave an untraceable view. The model returns typed content; deterministic code validates, pins and drives idempotent publication.

**Why not keep `coding` as the public name and add only `plan`?** The requested composition is a verb sequence, `plan → code → review`, and `code` names both creating and changing implementation without implying that every run starts from nothing. One persisted-data rewrite plus a temporary edge alias is cheaper than preserving an inconsistent permanent name.

**Why not generalize agents into an outcome graph now?** The outcome types are intentionally unlike: artifact reference, repository/unit fact and verdict. A generic graph either becomes `unknown` plus runtime switches or bakes ship's three stages into a supposedly general framework. Explicit contracts leave room to discover the actual shared abstraction from a second use case.

## Relations and boundaries

[Record 0057](0057-the-operator-is-the-one-door-a-model-binds-every-chat-input-and-deterministic-code-authorizes-fences-and-executes.md) still owns interpretation and front-door authorization. It gains typed `plan`/`ship` binds and source references; it does not let a plan agent become a second door. Client adapters resolve identity, deterministic code authorizes the resolved actor, and untrusted source content remains fenced.

[Record 0073](0073-the-ship-pipeline-dissolves-into-the-orchestrator-the-unit-machine-is-the-deterministic-atom-and-judgement-composes-units.md) still owns orchestration over the unit machine. This record fills its deliberately open “plan format's long-term documentation shape”: the orchestrator reads a pinned `PlanArtifact` rather than a repository document. Plan sequencing remains cited context, not an executable graph, and every cardinality, adoption, preservation, reviewed-head, check and merge-door guard remains unchanged.

The accepted implementation plan at [`docs/plans/2026-09-21-002-feat-the-ship-pipeline-dissolves-into-the-orchestrator-plan.md`](../plans/2026-09-21-002-feat-the-ship-pipeline-dissolves-into-the-orchestrator-plan.md) is the one bootstrap exception, not a compatibility path. The first implementation slice imports it once as the bootstrap `PlanArtifact`, pins it, and removes repository-path admission while its units remain paused on durable coordinator and repository facts. The second slice publishes its GitHub human view, completes its `PlanRef` and permits those units to continue. No other repository plan is admitted by path; only already-resumable pipelines are migrated to preserve their work.

No new implementation plan is committed under `docs/plans/` after this decision. The follow-on work record is created outside the repository. Historical plan files may remain as evidence, but no runtime reads them and any reuse treats one as an ordinary file input to `plan`.

Preserved: one owner per thread/unit; durable run and unit facts; budgets; source and artifact fencing; authorization once per request against the resolved actor and agent; current-grant checks at privileged effects; no host tools; rebase before every push; changed-set fast gates on the pushed tree; work preservation; review isolation and head binding; checks; and the merge door.

Not decided here: implementation units, a plan editor in Switchboard, automatic adoption of a new plan digest by a live pipeline, parallel-unit scheduling, a provider-neutral project-management UI or Linear's exact field mapping. Those follow after this record is accepted. No implementation code or spec behavior changes in this proposal.

## What would change our mind

- If the coordinator store cannot atomically pin canonical bytes under `(planId, digest)` and retrieve them across restarts, the canonical implementation moves behind the same `PlanStore` contract to a durable object store with those semantics. GitHub reconstruction and read-back still do not become the integrity path.
- If GitHub routinely cannot create or retain even one stable parent URL before code starts, use another provider for the address. Do not move canonical bytes out of `PlanStore` merely to keep GitHub.
- If a second pipeline demonstrates the same three-stage lifecycle with different artifact types, the explicit contracts are candidates for an agent-to-outcome composition abstraction. Until then, concrete contracts remain the decision.
- If current-grant re-resolution makes legitimate long-running work impossible across client surfaces, change the grant/delegation model in authorization. Do not solve it by trusting merge policy stored in a plan.

## Acceptance and next artifact

This pull request proposes the decision only. It creates no implementation plan and changes no runtime behavior. Before acceptance, a fresh reader receives only this record and must answer five questions:

1. What exact artifact lets execution start, and why is an issue URL alone insufficient?
2. How do parent issue, unit issue, Project and label map to plan, unit, portfolio and grouping without making GitHub types core types?
3. What survives if GitHub is unavailable after a pipeline starts, and why can a partial publication not change execution?
4. Who may merge when global automerge is on, and what happens after that person's grant is revoked?
5. How do the former repository seed and generated one-unit request collapse without a compatibility execution path?

The gate passes only if the reader names the canonical store pin, plan id plus digest plus provider URL, initiating actor plus fresh authority, the one-time bootstrap import and one pinned-artifact execution path. The follow-on artifact is one external work record that reconciles this decision with record 0073's existing plan; it is not a new repository file. Its units, specs and rollout flags are deliberately not invented here.

## Sources

- The maintainer's direction for this proposal: plans are stable work references rather than committed files; planning precedes code without an origin push; every source form converges on one validated plan; merge authority comes from the initiator; `ship` composes `plan → code → review`; `coding` becomes `code`; implementation units follow later.
- [Record 0057](0057-the-operator-is-the-one-door-a-model-binds-every-chat-input-and-deterministic-code-authorizes-fences-and-executes.md) — the operator as the one interpreting door and deterministic code as authorization/fence/execution.
- [Record 0073](0073-the-ship-pipeline-dissolves-into-the-orchestrator-the-unit-machine-is-the-deterministic-atom-and-judgement-composes-units.md) and its [accepted rollout plan](../plans/2026-09-21-002-feat-the-ship-pipeline-dissolves-into-the-orchestrator-plan.md) — plans as context, the deterministic unit atom, durable adoption and the future graph-path collapse.
- [`src/core/coordinator/contract.ts`](../../src/core/coordinator/contract.ts), [`handOff.ts`](../../src/core/coordinator/handOff.ts) and [`instanceStore.ts`](../../src/core/coordinator/instanceStore.ts) — the current path/generated split and the durable execution store the canonical plan joins.
- [`src/execution/githubIssues.ts`](../../src/execution/githubIssues.ts), [`src/artifacts/store.ts`](../../src/artifacts/store.ts) and [`src/core/memory/`](../../src/core/memory/) — the existing tracker seam precedent and generic stores whose contracts are inputs to, not substitutes for, `PlanStore`.
- [GitHub's sub-issue model](https://docs.github.com/en/issues/tracking-your-work-with-issues/using-issues/adding-sub-issues) — cross-repository sub-issues, Projects progress and the current direct-child limit.
- [GitHub Projects](https://docs.github.com/en/issues/planning-and-tracking-with-projects/learning-about-projects/about-projects) — portfolio views and fields over issues and pull requests rather than one project per work item.
- Pull request 1625 — the in-flight Linear native-session integration that makes provider types behind the adapter a present constraint rather than a hypothetical one.

## Public hygiene

This record carries only public repository paths, public record and pull-request numbers, public product/provider names, and public documentation links needed to test the design. It identifies the decision-maker by role, not by name, and contains no Slack channel, user or message id, private URL, credential, customer or unpublished commercial fact.
