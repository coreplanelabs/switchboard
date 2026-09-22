---
title: A side effect crosses one typed seam - Plan
type: feat
date: 2026-09-22
status: proposed
artifact_contract: ce-unified-plan/v1
artifact_readiness: implementation-ready
product_contract_source: ce-plan-bootstrap
execution: code
merge: person
extends: ../decisions/0074-a-side-effect-crosses-one-typed-seam.md
---

# A side effect crosses one typed seam - Plan

## Goal Capsule

- **Objective**: Build accepted [record 0074](../decisions/0074-a-side-effect-crosses-one-typed-seam.md): every effect outside ordinary checkout edits crosses one runner-owned typed command, starts from fresh facts and operation-specific gates, and ends in a durable typed receipt or refusal; the child keeps no shell or credential route around that seam.
- **Authority**: record 0074 owns the effect boundary and its receipt rule. [Record 0071](../decisions/0071-a-ship-unit-owns-its-pull-request-until-it-is-merged-merge-ready-waits-on-facts-and-a-dirty-head-buys-a-rebase-round.md) owns rebase-before-push, the two-rung resolver and reviewed-head behavior. [Record 0073](../decisions/0073-the-ship-pipeline-dissolves-into-the-orchestrator-the-unit-machine-is-the-deterministic-atom-and-judgement-composes-units.md) consumes the resulting acts and receipts without gaining authority to forge them.
- **Execution profile**: four code units in dependency order, each one pull request, one review and `merge: person`. Every unit starts with tests, runs changed-set gates on the tree it proposes to publish, and updates exact proof rows in `docs/reference/specs/agent-ship.md`, `execution.md` and the harness contract in `harness.md`; it updates any additional living spec its paths change.
- **Rollout**: U1 introduces `harness.effects: shadow | on`. `shadow` logs the typed seam's decision while today's path alone may publish for one release. `on` makes the runner command authoritative and removes the child's shell write route. There is no mode in which both routes may perform the same effect. U2–U4 use the same port after U1 establishes it.
- **Stop conditions**: stop and hand back a deviation if a child can still spend a write credential in `on`; an effect can be accepted without resolving the current resource and expected version; a receipt can outlive a changed tree or dirty state; ambiguous success can retry without reconciliation; a shared rebase service would absorb caller ownership policy; a connector operation can select arbitrary transport; or a unit would weaken authorization, leases, rebase-before-push, changed-set gates, reviewed-head equality, confirmation, work preservation or the merge door.
- **Tail ownership**: this plan changes publication and external-write ownership, not merge authority. A person merges every unit. Salvage remains a runner-owned preservation operation but never becomes evidence that the child requested publication.

---

## Product Contract

### Summary

A child edits and tests in its checkout, then asks for one narrow effect. The runner resolves current facts, authorizes and fences the exact resource, applies the operation's gates, performs at most one write and records a receipt keyed by a caller-minted `effectId`. Push, rebase, pull-request writes, comments and connector writes become finite typed commands. Shell prose and provider payloads are evidence only; they never become transition authority.

### Problem Frame

Today a coding child can publish by spelling `git push` in bash while the harness tries to recover the effective repository, source and destination from text. Pull request #2164 demonstrated that aliases, configuration, omitted or configured refspecs, alternate endpoints, wrappers, substitutions and compound commands make that language unbounded. Issues #2152 and #2173 show the second cost: gate evidence can describe a different tree, and each parser omission buys another review round.

The runner also cannot authoritatively consume effects it did not perform. In issue #2197, a child's successful push did not enter the runner's `pushed[]`; only salvage did, so completed work was judged not ready. Issue #2200 showed the same shell guard confusing a directive run's open-pull-request head with its base, after which different children invented different destinations. In issue #2196, two record-writing children both selected the same next free number because no runner serialized the shared allocation. The durable transition must therefore consume the runner's own typed receipt rather than infer success from shell output or a later remote snapshot.

Rebase is already split between prompt instructions and executable sweep machinery. GitHub writes have operation-local seams but not one lifecycle. Connector work from pull request #1625 would otherwise expose another credential-bearing general tool. The four units close these paths in dependency order without ever making the legacy and typed routes co-authoritative.

### Requirements

**U1 — `push`: one exact gated tree reaches one run-owned ref**

- R1. Add a shared `RunEffects` port with a caller-minted, persisted-before-dispatch `effectId`, a closed `push` command and typed success/refusal envelopes. Production and recording implementations satisfy one conformance suite.
- R2. The runner resolves exactly one admitted repository endpoint, source commit/tree and run-owned destination. It refuses unresolved, multiple, alternate, bulk, tag or mirror destinations; the child cannot provide a URL, refspec, flags or arbitrary git arguments.
- R3. `push` owns the order: require the expected clean head; invoke the shared rebase behavior available at that cut; resolve the resulting tree; run changed-set gates on that exact tree and clean state; recheck both immediately before publication; lease-publish exactly that commit; then record the old and new remote sha, destination, tree and gate receipts.
- R4. Gate receipts are bound to commit tree and clean-state evidence. A failed canonical gate, later commit, index/worktree mutation, or dirty-state change invalidates them and forces a fresh gate run before publication.
- R5. Every successful requested publication appends a run `pushed[]` receipt with `by: runner`. Ship-round readiness is derived only from that runner receipt at the expected tree/head, never from child prose, shell exit, a remote-ref guess or `by: salvage`.
- R6. The typed `push` is a harness capability for every coding run, whether ship-parented or directive. A directive run bound to branch X publishes X through the same command even when X heads an open pull request; the pull request's head is the run-owned destination, never confused with its base, and the child cannot invent a stacked branch after a refusal.
- R7. Remove publish authority from the child's shell in `on`. Every `git push` shape in bash is refused by one structural rule — “the child does not push” — and the #2164 forms become a conformance table of refused spellings, not an allow parser.
- R8. Salvage is a distinct runner command and receipt marked as preservation the child never asked to publish. It may retain work but cannot satisfy requested-publication readiness or claim a pull request was opened.
- R9. `harness.effects` accepts exactly `shadow | on` and enters rollout at `shadow`. In `shadow`, today's path remains the only publisher for one release and the typed decision records what it would allow or refuse without writing. In `on`, only the typed command can publish and the shell route has no write credential. Config reports the effective value/source and rejects unknown values by name.

**U2 — `rebase`: one resolver, several caller policies**

- R10. Extract one runner rebase service from `src/core/pullSweep.ts`, `src/execution/gitRebase.ts` and `src/execution/sweepCheckout.ts`; the live unit, sweep and salvage call it, while each retains its own ownership, continuation, review and preservation policy.
- R11. Rung one fetches the named base and invokes git as argument vectors with repository merge drivers and `rerere`. A clean result records old head, fetched base, new head and range-diff; a conflict records the exact conflict set.
- R12. Rung two runs only for a conflict rung one leaves: one bounded lightweight-model round with relevant thread context and `AGENTS.md`, no publish credential and no ability to widen repository, base or operation. Deterministic code validates the index and continuation.
- R13. The command returns a closed typed outcome: clean head with range-diff, conflict set, or `conflict_unresolved`. It never turns git prose into control flow, and every exit preserves the actual head and conflict paths.
- R14. Pull request #2158 becomes a caller of the shared service rather than a prompt-only approximation. A clean unchanged patch may carry approval only under the caller's existing policy; a live unit, sweep and salvage still decide their distinct next acts.

**U3 — `open_pr` and `comment`: fenced writes reconcile by marker**

- R15. Add `open_pr` and `comment` to the effect port. Their shared envelope carries a stable caller-minted `effectId` persisted before first dispatch and reused after retries or resumes; every receipt echoes it.
- R16. `open_pr` resolves the run-owned repository and branch, defaults base to `main` unless the unit names another admitted base, compares expected head, validates the typed description and creates or updates once. It adopts an existing pull request for the branch/head rather than creating a rival.
- R17. `comment` resolves a typed issue, pull-request or unit-thread subject and checks an expected version where the subject has one. It cannot take an arbitrary URL or let body text select another operation.
- R18. Every published body carries `<!-- switchboard:effect <effectId> -->`. After ambiguous `open_pr`, list pull requests for the run-owned branch and match the marker; after ambiguous `comment`, list the subject's comments and match it. A hit records the found remote id as the receipt; a miss permits one write attempt.
- R19. Fresh head/version, ownership, open/closed state and authorization are read immediately before writing. A moved head, merged/closed resource or changed version returns a typed fact; it cannot be overwritten from an earlier snapshot.

**U4 — connectors: compile-time operations, Linear first**

- R20. Define a compile-time connector operation registry. Each operation contributes argument schema, resolver, authorization action, ownership/freshness check, adapter, typed receipt/refusal mapping and recording fake; an unregistered connector or operation is refused before credentials are touched.
- R21. Land Linear issue update from pull request #1625 as `connector.linear.update_issue({ connection, issue, expectedVersion, patch })`. The patch is typed and bounded; connection and issue resolve canonically; version mismatch is a typed refusal.
- R22. Connector credentials remain only in runner adapters and never enter child tools, shell environment, prompts, logs or receipts. A connector cannot expose generic HTTP, arbitrary method/path, arbitrary JSON or a transport escape hatch.
- R23. Connector text writes use the same effect-id persistence and operation-specific reconciliation rule. A transport's prose is sanitized evidence, never a reason callers parse.

### Scope Boundaries

- Ordinary checkout edits, local reads and changed-set test execution remain child work. Publishing, ancestry rewrite that determines publication, GitHub writes and connector writes are runner effects.
- The effect port reuses the existing authorization table and resolved actor. It does not create a second grant system, credential store or merge path.
- CI remains the full verification gate after publication. U1 owns only the repository-declared changed-set gates required before the exact tree is published.
- Record-number reservation from issue #2196 is a later operation on the same seam. Its fixture proves the boundary but does not expand these four units beyond the accepted rollout.
- Composite deploy effects named by record 0074 remain follow-up work; no unit hides deploy behind a generic connector.

### Deferred to Follow-Up Work

- Runner-owned record-number reservation and admission assignment for concurrent record-writing units (#2196).
- Composite, version-fenced deploy effects across Worker, image and configuration.
- Connectors beyond Linear and Linear operations beyond typed issue update.

---

## Planning Contract

### Key Technical Decisions

- **K1. Receipts are transition authority.** A remote observation can reconcile an ambiguous attempt, but cannot replace the runner's receipt as readiness evidence. This directly closes #2197 without making remote-ref guesses authoritative.
- **K2. The credential boundary enforces the type boundary.** `on` removes the child's publish and connector credentials; text refusal remains defense in depth, not the security model.
- **K3. Push is a composite typed operation.** Rebase, changed-set gates, lease publication and receipt recording belong to one command because splitting them would permit a tree change between proof and effect.
- **K4. Rebase mechanics and caller policy remain separate.** One resolver produces facts; the live unit, sweep and salvage decide ownership and continuation from those facts.
- **K5. Text effects carry their id; git effects reconcile by ref and sha.** Content markers distinguish an ambiguous retry from an identical older write. Git objects already have canonical content and destination identities.
- **K6. Shadow observes but never publishes.** Keeping legacy publication authoritative for one release allows comparison. `on` is the only cutover and structurally removes legacy authority.
- **K7. Connector extensibility is compile-time.** A new connector operation adds schema, policy and adapter code; runtime strings cannot invent transport authority.

### High-Level Technical Design

`RunEffects` accepts `{ effectId, command }` where `command` is a discriminated union. The caller persists the envelope before dispatch. A runner service applies one lifecycle: resolve fresh facts, authorize and fence, prepare and gate, perform once, record. Production adapters hold write credentials; a recording adapter drives contract and shadow tests. Receipts and refusals carry closed operation-specific values under a shared envelope.

U1 establishes the port and durable effect ledger around push. Its push implementation resolves the source tree from the admitted checkout, uses U2's final shared rebase service when that unit lands, executes repository-declared changed-set gates, compares tree and dirty state again, lease-publishes and appends `by: runner`. During U1 before U2, the existing executable rebase path is called through a narrow adapter; U2 removes duplicate mechanics without changing push's contract.

The harness gives child bash read/local-write access but no route that can spend repository or connector write credentials. In shadow, the recorder evaluates the would-be command while legacy publication remains authoritative. In on, only the production effect adapter owns credentials. The same mode cannot invoke both writers.

U3 persists text effect ids and embeds their markers. Ambiguous outcomes reconcile against a bounded subject or branch before one retry. U4 registers connector operations statically and gives their adapters the same lifecycle without exposing generic transport.

### Sequencing

U1 → U2 → U3 → U4. U1 creates the port, receipt ledger, credential boundary and rollout mode. U2 centralizes the rebase operation U1 calls. U3 relies on effect-id persistence and production/recording implementations. U4 relies on the shared lifecycle and registry shape proven by git and GitHub effects. No later unit may reopen a shell write route or bypass an earlier receipt.

### Unit Rules

Every unit is one pull request and one review with `merge: person`. Its first implementation act is a failing focused test. Before every push it rebases onto current `main`, reruns the exact touched Vitest files once, scoped TypeScript for touched tsconfigs, Prettier on changed files, `npm run hygiene:check`, `npm run specs:check` and any generated-doc/config check its sources require. CI alone runs the full suite and `npm run verify`.

Each unit updates exact proof rows in:

- `docs/reference/specs/agent-ship.md` for ship readiness, caller ownership and retained-work behavior;
- `docs/reference/specs/execution.md` for checkout, git, credential and external-effect execution;
- `docs/reference/specs/harness.md` for the typed tool contract, child negative capabilities and adapter conformance;
- any additional affected spec, including `routing-and-config.md`, `github-tools.md`, `authorization.md`, `command-registry.md` or connector specs.

---

## Implementation Units

| U-ID | Title | Depends on | Pull request |
| --- | --- | --- | --- |
| U1 | `push` owns the exact tree and publication receipt | none | one PR, one review, `merge: person` |
| U2 | `rebase` becomes one shared runner service | U1 | one PR, one review, `merge: person` |
| U3 | `open_pr` and `comment` reconcile fenced text effects | U2 | one PR, one review, `merge: person` |
| U4 | Compile-time connectors, Linear first | U3 | one PR, one review, `merge: person` |

### U1. `push` owns the exact tree and publication receipt

- **Goal**: make the runner the only authority that can publish a child's requested tree and make its receipt the only requested-publication evidence ship consumes.
- **Requirements**: R1–R9.
- **Dependencies**: accepted record 0074; no implementation-unit dependency.
- **Code paths**: `src/core/harness/contract.ts`; pi harness tool registration/rules under `src/core/harness/pi/`; run effect orchestration under `src/core/`; `src/core/dispatch/runLoop.ts`; `src/core/codingPrPostStep.ts`; `src/core/ship/coordinator.ts`; run ledger/event/record projections carrying `pushed[]`; repository git adapters under `src/execution/`; `src/config.ts`, validation and installation settings; config/docs generator sources.
- **Test paths**: focused harness contract and pi conformance tests; `src/core/dispatch/runLoop.test.ts`; `src/core/codingPrPostStep.test.ts`; `src/core/ship/coordinator.test.ts`; config tests; new effect-port production/recording contract tests; exact spec rows in `agent-ship.md`, `execution.md`, `harness.md` and `routing-and-config.md`.
- **Approach**:
  1. Add recording-port tests for envelope persistence, exact source/destination resolution, clean expected head, tree-bound gate evidence, lease push and closed refusals.
  2. Convert #2164's aliases, `git -c`, `GIT_CONFIG`, omitted/configured refspecs, alternate remotes/URLs, force forms, bulk/tag/mirror forms, wrappers, substitutions and compound commands — including #2173's case-by-case review progression — into one table asserting child bash cannot push.
  3. Add the #2197 fixture: a child completion without a runner `push` receipt is not ready even if prose or a remote fixture says the ref moved; a matching `by: runner` receipt opens the PR/review path; `by: salvage` retains work but does not qualify.
  4. Add the #2200 fixture at the harness contract: a directive coding run bound to an open pull request's head publishes that same branch through typed `push`; it never mistakes the head for the base, chooses another destination or creates a stacked branch.
  5. Implement production push resolution and exact-tree changed-set gates. Add #2152's rebase-changed-the-tree fixture, invalidate receipts on every tree/dirty mutation, lease-publish one commit and append one durable receipt.
  6. Add `harness.effects` validation, effective-source reporting and generated docs. Shadow calls only the recorder and logs allow/refuse; on calls only production effects and strips child write authority.
  7. Run shadow for one release before enabling on. The operational cutover reads comparison counts but the code's conformance test proves no invocation can dispatch both writers.
- **Validation criteria**:

| Criterion | Bound proof | Receipt runnable when |
| --- | --- | --- |
| One push resolves one admitted endpoint, source tree and run-owned destination; every ambiguous/bulk form refuses before transport | Effect-port table tests plus #2164/#2173 refused-shapes harness conformance fixture | The focused tests run with fake git/config variants and assert one transport call only for the canonical command |
| Rebase precedes changed-set gates; gate receipts name the published tree and clean state | #2152 push lifecycle integration test with ordered spies and recorded tree ids | The test can create two commits and a dirty mutation, then show only freshly gated tree B may publish |
| Mutation or failed gate invalidates earlier evidence | Tree/dirty-state matrix over commit, index, worktree and canonical gate failure | Each matrix case runs without network credentials and reports `gates_missing`, `dirty_tree` or `gate_failed` |
| Ship readiness consumes `by: runner`, never remote guesses or salvage | #2197 coordinator/post-step fixture | The fixture can replay child completion with `pushed[]` empty, salvage-only and runner-matching variants |
| Every coding run receives typed push, including a directive run on an open PR head | #2200 harness/dispatcher fixture over ship-parented and directive coding runs | The fixture binds branch X as an open pull request's head and asserts the runner publishes X, never its base or a new stacked ref |
| Shadow never writes and on never exposes shell publication | Config/harness mode matrix with transport and credential spies | Both modes run against recording adapters; shadow transport stays zero and on child credential lookup stays zero |
| Every child `git push` spelling is refused by “the child does not push” | #2164 conformance table | The harness test can submit each command shape without a real repository or remote |

- **Verification**: exact touched Vitest files; scoped TypeScript; Prettier on changed files; config/docs generation checks; `npm run hygiene:check`; `npm run specs:check`; CI full verification. The unit receipt is the passing #2164/#2173/#2152/#2197/#2200 matrix plus one exact-tree production-adapter test that records `by: runner`.

### U2. `rebase` becomes one shared runner service

- **Goal**: give push, the live unit, sweep and salvage one deterministic two-rung resolver while keeping their ownership and next-state policies outside it.
- **Requirements**: R10–R14.
- **Dependencies**: U1's effect port and push lifecycle.
- **Code paths**: `src/core/pullSweep.ts`; `src/execution/gitRebase.ts`; `src/execution/sweepCheckout.ts`; the U1 effect service; live-unit pre-push/rebase paths in `src/core/ship/`; salvage wiring in `src/core/dispatch/runLoop.ts` and coding post-step; budget/lease carving for the lightweight round.
- **Test paths**: `src/core/pullSweep.test.ts`; `src/execution/gitRebase.test.ts`; `src/execution/sweepCheckout.test.ts`; ship coordinator/rebase tests; salvage tests; new shared rebase service contract tests; exact rows in `agent-ship.md`, `execution.md`, `harness.md` and `github-tools.md`.
- **Approach**:
  1. Characterize the current sweep resolver's git, merge-driver, rerere, conflict and range-diff behavior before extraction.
  2. Extract a service whose inputs are admitted repository, expected head, base and bounded context, and whose outputs are clean head/range-diff, conflict set or `conflict_unresolved`.
  3. Give rung two one bounded lightweight-model round with `AGENTS.md`, conflict context and no publication capability. Validate its index before continuation.
  4. Route U1 push, live-unit conflicts, sweep and salvage through the service. Keep approval carry, review, park/end and preservation decisions in caller-owned policies.
  5. Turn pull request #2158's behavior into a shared-service caller fixture and delete prompt-only duplicate mechanics only after every caller test is green.
- **Validation criteria**:

| Criterion | Bound proof | Receipt runnable when |
| --- | --- | --- |
| Git/rerere/merge drivers produce a clean head and range-diff or an exact conflict set | Shared service rung-one unit tests over repositories with declared merge drivers and rerere state | Fixtures create local repositories and run without a model or remote write credential |
| Only an unresolved git conflict enters one bounded model round | Rung-selection table with model-call count and lease assertions | The fake model and clock are injected; clean and non-conflict failures keep call count zero |
| The model round cannot publish or widen repository/base | Harness capability test over the rebase child context | The recording executor exposes no push/open/comment/connector command and refuses changed identifiers |
| Outcomes are closed and retain old/base/new heads, conflicts and range-diff | Compile-time exhaustiveness plus service result table | Every fixture returns a typed variant without parsing stderr outside the adapter mapping |
| Live unit, sweep and salvage share mechanics but retain policy | Caller matrix including #2158 | Each caller runs the same service fake and asserts distinct follow-up actions with identical resolver facts |

- **Verification**: exact touched resolver, sweep, ship and salvage Vitest files; scoped TypeScript; Prettier; `npm run hygiene:check`; `npm run specs:check`; generated docs checks if sources change; CI full verification. The unit receipt is one caller matrix proving all three policies consume the same typed resolver outcomes.

### U3. `open_pr` and `comment` reconcile fenced text effects

- **Goal**: make GitHub text writes idempotent across lost responses, current-head fenced and adoptive rather than rival-creating.
- **Requirements**: R15–R19.
- **Dependencies**: U2 and the effect ledger established by U1.
- **Code paths**: the shared effect command/receipt types and ledger; PR description/open/edit post-step code; GitHub pull-request and comment clients under `src/execution/`; ship/coding PR adoption paths; comment producers in review, handoff and operator surfaces.
- **Test paths**: PR open/edit and description post-step tests; GitHub pull/comment adapter tests; ship adoption tests; effect retry/resume contract tests; exact rows in `agent-ship.md`, `execution.md`, `harness.md` and `github-tools.md`.
- **Approach**:
  1. Add red contract tests that persist `effectId` before dispatch, echo it in receipts and reuse it on retry/resume.
  2. Put the marker in every `open_pr` body and comment body. Test exact marker escaping/rendering and ensure user-visible content is otherwise unchanged.
  3. Resolve fresh branch/head/base and existing pull requests. Default base to `main` unless the unit carries another admitted base; adopt/update the branch's existing pull request rather than create a rival.
  4. Reconcile an ambiguous open by listing branch pull requests and matching the marker; reconcile an ambiguous comment by listing subject comments and matching the marker. A match records the remote id; no match permits one post.
  5. Add #2195's plan-ref fixture, #2182's fresh-classification fixture and #2185's moved/merged resource fixture. Refuse stale expected heads/versions before any write.
- **Validation criteria**:

| Criterion | Bound proof | Receipt runnable when |
| --- | --- | --- |
| Effect id is durable before dispatch and reused after retry/resume | Ledger ordering test with crash points before call, after ambiguous call and before receipt | The fake ledger and GitHub adapter can stop/restart at each point and expose call counts |
| Every text effect embeds its exact marker | Body rendering tests for open/update PR and each comment subject | Pure rendering tests compare the final body and marker without GitHub access |
| Ambiguous success reconciles by marker before one retry | Adapter contract tests with marker hit and miss | Fake listings return matching, identical-unmarked and absent bodies; call count proves hit=0 writes, miss=1 |
| Existing pull request is adopted and base defaults correctly | #2195 adoption fixture with plan ref plus explicit-base cases | Repository/branch facts are fakeable and the fixture asserts update vs create and `main` vs named base |
| Fresh facts fence stale or completed resources | #2182/#2185 head/version/state matrix | Fake facts move between resolve and perform; every moved/merged/closed case returns typed refusal and zero writes |

- **Verification**: exact touched effect, GitHub adapter, PR post-step and ship-adoption Vitest files; scoped TypeScript; Prettier; `npm run hygiene:check`; `npm run specs:check`; generated docs checks if sources change; CI full verification. The unit receipt is the crash/reconcile matrix showing one remote object and one durable receipt per `effectId`.

### U4. Compile-time connectors, Linear first

- **Goal**: prove the seam extends to an external write without giving the child a credential-bearing generic transport.
- **Requirements**: R20–R23.
- **Dependencies**: U3's persisted effect ids, reconciliation lifecycle and recording adapter.
- **Code paths**: shared effect registry and dispatch; connector configuration/connection resolution; new connector contract and Linear adapter under the existing execution boundary; authorization action mapping; credential materialization; command/tool schema generation and docs sources.
- **Test paths**: registry exhaustiveness and unknown-operation tests; connector contract suite over recording and Linear fake adapters; authorization/config/credential tests; retry/version-fence tests; exact rows in `agent-ship.md`, `execution.md`, `harness.md`, `authorization.md`, `routing-and-config.md` and connector documentation/specs.
- **Approach**:
  1. Define a static registry type that binds connector name and operation to schema, policy action, adapter, receipt and refusal variants. Make missing registrations fail compilation or the registry exhaustiveness test.
  2. Add recording and production adapter contracts before Linear wiring. Refuse unknown connector/operation and malformed patches before credential lookup.
  3. Implement `connector.linear.update_issue` from pull request #1625 with canonical connection/issue resolution, expected-version fence and a bounded typed patch.
  4. Materialize the Linear credential only inside the runner adapter. Add source scans and runtime spies proving no child tool schema, environment, prompt, log or receipt receives it.
  5. Apply caller-minted effect ids and operation-specific ambiguous-success reconciliation; sanitize unmapped transport failures as internal effect failures rather than caller-parsed prose.
- **Validation criteria**:

| Criterion | Bound proof | Receipt runnable when |
| --- | --- | --- |
| Registry is compile-time complete and unknown operations fail before credentials | Type-level registry test plus runtime unknown connector/operation matrix | Tests compile the registry and use a credential spy that must remain zero on every refusal |
| Linear update resolves canonical resource, checks expected version and applies only typed patch fields | Linear adapter contract tests from #1625 fixtures | The fake Linear client returns current versions and records the exact patch without network access |
| Version movement refuses without overwrite | Expected-version race test | Fake version changes between resolve and perform; update count remains zero and refusal carries expected/current versions |
| Credential never reaches child capabilities or observability | Harness schema/environment tests, source scan and redaction/log/receipt assertions | Tests use a sentinel secret and fail on any child tool, env, prompt, event, log or receipt occurrence |
| Retry/resume yields one Linear effect receipt | Ambiguous-success reconciliation matrix | The fake client simulates accepted-then-timeout and exposes remote version/id for reconciliation |

- **Verification**: exact touched registry, Linear adapter, authorization/config and harness Vitest files; scoped TypeScript; Prettier; generated command/config/docs checks; `npm run hygiene:check`; `npm run specs:check`; CI full verification. The unit receipt is the connector conformance suite passing against both recording and Linear adapters with the sentinel credential absent from every child-visible surface.

---

## Verification Contract

| Criterion | Proof | Receipt runnable when |
| --- | --- | --- |
| Record 0074 is accepted and this plan extends it with U1–U4 in dependency order | `npm run decisions:check`; plan frontmatter/link and implementation-unit table | This documentation pull request's changed tree is available locally or in CI |
| U1 publishes only one exact rebased, gated tree, gives every coding run the same typed command and consumes its runner receipt | U1 #2164/#2173/#2152/#2197/#2200 conformance, exact-tree, readiness and directive-run matrix [gap: U1] | Recording git, gate and ledger adapters can run with no external credential |
| U1 rollout never gives legacy and typed paths simultaneous authority | U1 mode/capability matrix and one-release shadow receipt [gap: U1] | Shadow comparison is deployed for one release; code-level zero-write tests run earlier |
| U2 gives live unit, sweep and salvage one resolver with caller-owned policy | U2 resolver/caller matrix including #2158 [gap: U2] | Local git fixtures and a fake bounded model are available |
| U3 retries text effects without duplicates and adopts existing pull requests | U3 marker/crash/adoption matrix including #2195, #2182 and #2185 [gap: U3] | Fake GitHub listings can represent marker hits, misses and moved resources |
| U4 registers Linear statically, fences versions and hides its credential | U4 connector conformance and sentinel-secret tests from #1625 [gap: U4] | Recording and fake Linear adapters satisfy the same operation contract |
| Every unit updates living proofs without weakening guards | `npm run specs:check` plus exact changed rows in `agent-ship.md`, `execution.md`, `harness.md` and affected specs [gap: U1–U4] | Each unit's test names exist on its pushed head |
| Every unit runs changed-set gates and remains person-merged | Each unit PR's validation receipt and `merge: person` contract [gap: U1–U4] | The unit has a rebased clean head and its exact touched test/config/doc paths are known |

For every implementation unit, the receipt is runnable only after its dependency has merged and the unit branch has rebased onto that merged parent. The runner executes the exact touched Vitest files, scoped TypeScript, Prettier on changed files, `npm run hygiene:check`, `npm run specs:check`, relevant generated checks and the title gate before push. CI alone runs the full suite and `npm run verify`.

## Definition of Done

- U1–U4 merge in order, each as one person-merged pull request after one review, with exact living-spec proofs.
- A child can request only registered typed effects and has no credential or shell route that can perform those writes in `on`.
- Every ship-parented and directive coding run publishes through the same typed `push`; push readiness, rebase results, GitHub writes and Linear updates transition only from runner-owned receipts carrying exact tree, head, resource and version evidence.
- Changed-set gate receipts are invalidated by any tree or dirty-state change and the published commit is the exact rebased commit they prove.
- Every published text effect embeds its caller-minted id and reconciles an ambiguous outcome before retry; git effects reconcile by ref and sha.
- The live unit, sweep and salvage share rebase mechanics without sharing or weakening ownership policy.
- Shadow runs for one release without writing; on removes the old shell route; no steady state has two authoritative writers.
- Public hygiene, exact specs and CI full verification pass for each unit.
- For this documentation pull request, `npm run decisions:check`, `npm run docs:check`, `npm run specs:check`, `npm run hygiene:check` and formatting pass; the plan links accepted record 0074 and lists U1–U4 with bound proofs and a receipt-runnable predicate for every criterion.
