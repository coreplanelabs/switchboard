---
title: The ship pipeline dissolves into the orchestrator - Plan
type: feat
date: 2026-09-21
status: proposed
artifact_contract: ce-unified-plan/v1
artifact_readiness: implementation-ready
product_contract_source: ce-plan-bootstrap
execution: code
extends: ../decisions/0073-the-ship-pipeline-dissolves-into-the-orchestrator-the-unit-machine-is-the-deterministic-atom-and-judgement-composes-units.md
---

# The ship pipeline dissolves into the orchestrator - Plan

## Goal Capsule

- **Objective**: Build accepted [record 0073](../decisions/0073-the-ship-pipeline-dissolves-into-the-orchestrator-the-unit-machine-is-the-deterministic-atom-and-judgement-composes-units.md): keep one deterministic unit machine for coding → review → fix → checks → merge, put an orchestrator reconcile loop over its durable facts, prove every current ending and recovery rule, then retire the plan runner's graph walk and person-facing recovery directives.
- **Authority**: record 0073, including its 2026-09-21 cold-reader and correctness amendments, owns composition. [Record 0072](../decisions/0072-a-run-has-one-live-state-owned-by-the-server-a-closed-set-one-event-one-wording-function-and-every-surface-reads-the-one-field.md) owns the parent live-state field and must have its U1 durable projection on `main` before this plan writes cardinality. Records [0046](../decisions/0046-a-budget-is-a-lease-carved-from-its-parent-and-one-module-proves-the-leases-fit.md), [0051](../decisions/0051-a-thread-has-one-owner-for-its-life-a-message-is-one-event-in-a-chosen-mode-and-a-pipeline-idles-instead-of-ending.md), [0055](../decisions/0055-a-unit-has-one-thread-and-a-round-reads-the-checks-at-its-head.md), [0064](../decisions/0064-the-plane-owns-every-runs-state-a-refusal-becomes-a-queue-position-an-ending-is-judged-by-the-ledger-that-saw-it-and-a-release-is-a-quiet-window-a-person-closes.md), [0068](../decisions/0068-one-agent-per-unit-a-run-continues-its-threads-transcript-and-the-unit-is-the-reading-unit.md), [0069](../decisions/0069-the-one-door-has-one-execution-path-a-bind-runs-clicks-or-routes-a-violation-is-re-asked-a-disagreement-floors-and-no-chat-surface-hands-back-a-line-to-retype.md), [0070](../decisions/0070-the-control-plane-is-where-the-maintainer-works-the-plane-page-pins-a-chat-column-beside-the-panels-and-an-orchestrator-thread-answers-about-the-fleet-and-acts-on-it.md) and [0071](../decisions/0071-a-ship-unit-owns-its-pull-request-until-it-is-merged-merge-ready-waits-on-facts-and-a-dirty-head-buys-a-rebase-round.md) keep their named leases, ownership, thread, admission, reviewer-wall, door, rebase, pushed-tree and merge guards.
- **Execution profile**: three code units in dependency order, each one pull request and one review. U1 lands the smallest hot-path change behind `plane.shipReconcile: off | shadow | on`, with the current plan runner authoritative in `off` and `shadow`. U2 makes the reconcile rules executable judgement fixtures and closes cross-generation ownership. U3 removes the rival graph walk and recovery copy only after the fallback has no unique behavior and no durable unit has two composers.
- **Stop conditions**: every unit stops and hands back a deviation before changing code if record 0072's durable live-state projection is absent; a writer cannot commit parent live state and its one child/wait/ending relation in one fenced mutation; a mode change can expose two composers or lose a mid-round unit; shadow mode needs a side effect; a reconcile act would write approval, checks, reviewed head, a gate receipt, grant or merge fact; or any unit needs to weaken admission, authorization, confirmation, rebase-before-push, changed-set fast gates on the rebased tree, work preservation, reviewed-head equality or the merge door. A unit also stops if it cannot add an exact proof row to every living spec it changes, if its failing scenario is not reproducible on its base, or if its scope grows beyond one review.
- **Tail ownership**: the current plan runner may carry these implementation pull requests. U1 and U2 leave it intact as the fallback. U3 retires the walk only after its own branch and pull request exist and its fixtures prove the orchestrator path; the deployed generation running the current plan may finish U3, but no later unit depends on that generation. No implementation unit grants merge authority.

---

## Product Contract

### Summary

A plain-words ship ask enters the continuing orchestrator conversation. The orchestrator chooses one unit-sized act and calls the same deterministic unit workflow the plan runner calls today. The unit workflow returns one durable fact; a pure reconcile projection classifies it, the orchestrator chooses a typed next act, and deterministic code authorizes and executes that act. A durable composer epoch and record-0072 parent state ensure one active composer and exactly one child, wait or ending through rolls and flag changes. Once every current plan-runner result is represented and compared, the graph walk and recovery directives are deleted.

### Problem Frame

The repository already has the right deterministic atom in `src/core/ship/coordinator.ts`: leased coding, review, fix, checks and merge transitions with exact head and guard facts. `src/core/coordinator/driver.ts` wraps it in a second orchestration language: a plan cursor, dependency blocking, merge-mode prediction, attempts and person-directed recovery. The wrapper cannot naturally represent a parked human question, a deploy roll, a bounded rebase conflict or a reply after the process ended, so those cases escape into prose and re-issue commands.

Replacing that wrapper with an LLM loop is safe only if the loop receives a closed fact, can select only a typed act, and cannot write the evidence that admits the act. The rollout is harder than a route switch: the old and new composers can run on different bot generations, a flag can change while the unit machine is mid-round, and current state uses both `UnitEnding` and `ShipRoundOutcome`. The plan therefore adds one reusable unit driver, one total fact projection, one durable composer fence and one shadow comparison before deleting anything.

### Requirements

**U1 — one ask, one unit, one reconciled next act behind a flag**

- R1. `plane.shipReconcile` accepts exactly `off | shadow | on` and defaults to `off`. `off` runs the current plan runner. `shadow` also runs the current plan runner and computes one orchestrator decision from the same normalized ask and repository/plane facts without spawning, writing, consuming an answer or merging. `on` admits the orchestrator as composer for supported units. Invalid values fail configuration by name; `config show` reports the effective value and source.
- R2. Extract or expose the existing unit driver as one callable deterministic atom without changing its transition rules. Its input starts from stable unit identity, thread, branch, pull request, reviewed head, check head, prior ending, pending question, lease and grant. Its output retains the exact source ending, branch head, pull request and guard facts.
- R3. A plain-words ask routed by the record-0069 operator creates or adopts one unit, not a generated plan walk. In `on`, the orchestrator calls that unit, reads its returned fact and chooses one typed next act. The first vertical receipt is deliberately small: an ask that needs one coding unit reaches merge-ready/done, the orchestrator reads it and records either the permitted merge/wait act or done.
- R4. A pure `reconcileFactOf` is total over the current `UnitEnding`, `ShipRoundOutcome` and approved-standing inputs. It preserves the source detail while classifying `merge_ready`, approved-not-merge-ready, held, checks-failed, died, interrupted, budget, stopped, merged/already-landed and refused/merge-refused. New source variants fail TypeScript or a totality test. U1 may defer non-receipt classes to the pinned plan-runner fallback, but it may not misclassify them.
- R5. A durable unit row carries stable unit identity, `activeComposer`, `desiredComposer`, `composerEpoch` and the facts needed for adoption. A flag change never cancels the unit-machine act in progress. Transfer occurs only after that act records one ending, wait or question: compare-and-swap the epoch, fence the old composer, then let the target adopt the same thread, branch, pull request, heads and pending question.
- R6. Shadow comparison receives byte-equivalent normalized asks and fact snapshots. It records old/new decisions and a stable reason code, redacted and bounded, but executes only the plan-runner decision. A test fails if the shadow path reaches a write-capable dependency.
- R7. U1 updates the applicable rows in `docs/reference/specs/agent-ship.md`, `routing-and-config.md`, `orchestration-plane.md`, `run-history.md` and `public-hygiene.md` with exact proofs. It changes generated config/reference regions only through their generators.

**U2 — reconciliation is executable judgement over fenced durable facts**

- R8. The parent cardinality projection is a tagged union with exactly one of `{ child }`, `{ wait }` or `{ ending }`. It commits in the same durable mutation and sequence as the hosted parent's record-0072 live-state transition under expected sequence, composer epoch and owner generation. Readers consume the tag rather than joining optional fields.
- R9. Reclaim fences the previous generation before a new writer may transition cardinality. Duplicate events are idempotent. A stale generation, stale composer epoch or losing expected-sequence compare is refused without changing either live state or relation. A legacy zero-cardinality row is repaired from child, ledger and repository facts with one compare-and-swap; ambiguity creates a bounded reconciliation wait/fault, never an inferred ending. A many-cardinality legacy row is likewise repaired or parked, never silently preferred.
- R10. The reconcile rule for `merge_ready` re-reads pull request, approved head, check head, merge queue and grant, then calls the merge door or waits. Approved-not-merge-ready distinguishes pending checks/queue, dirty conflict, fix-up commits, moved head and lost approval. None can become merge-ready from model prose.
- R11. `held` creates one durable pending-question key. The first accepted answer from the unit thread or pull request clears it and resumes once; redelivery and a near-simultaneous answer on the other surface become transcript evidence. A question has an absolute bound and appears as the parent's one wait relation.
- R12. `checks_failed` binds the failing checks to the pushed/reviewed head and creates machine-owned check findings. It enters a bounded fix/review round or parks a human-gated question. Rebase runs before the changed-set gates and the exact gated head is the one pushed.
- R13. A dirty pre-push head enters one bounded resolve step under the remaining unit lease with the thread and repository guidance. Every exit — success, stop, tool/process death, interruption or exhausted bound — invokes work preservation when the tree is dirty or a commit is unpushed. Success reruns the fast gates on the rebased tree before push; unresolved conflict parks a question or returns a named retained-head ending.
- R14. Died and interrupted facts re-read the ledger, branch tip, open pull request, checkpoint/salvage receipt, reviewed head and checks. They resume the earliest safe unit-machine state under the remaining lease or return a named ending carrying retained work; process death never means work death.
- R15. Budget facts use record 0046's existing renewal and fit result. The orchestrator may select only the continuation, wait/question or ending that result permits and cannot mint time. A stop runs preservation before sealing; only a later explicit reply resumes the same unit by adoption.
- R16. Preserve the ended-thread continuation already on the base at `cf64c31a`: a reply resolves that thread's stable unit identity, not the last terminal run id; an ended non-merged pipeline re-issues its original task on the same plan and branch, while a merged unit routes fresh. Reconciliation reuses that resolver, resumes or asks one clarifying question, and never creates a new unit from reply text. A re-issue reads the branch tip and open pull request first, resumes review at the actual tip or the merge decision at an approved green head, and starts coding from zero only when neither durable fact exists.
- R17. Every typed act re-enters the existing unit machine or door. Tests use write spies to prove the orchestrator cannot set approval, checks, reviewed head, gate receipts, grant, authorization, confirmation or merge facts. U2 updates exact proof rows in `agent-ship.md`, `run-history.md`, `orchestration-plane.md`, `github-tools.md`, `authorization.md` and any other living spec whose code path changes.

**U3 — retire the rival composer and recovery vocabulary**

- R18. Before deletion, a fixture matrix runs every U2 ask/fact through the authoritative orchestrator rules and the plan runner's equivalent path. All behavior the runner uniquely exercised is either represented by a typed act/fixture or explicitly retained as a deterministic tool. The plane reports zero units with two composers and zero unadopted fallback-only units.
- R19. Delete the plan cursor, dependency-blocking walk, merge-mode column, generated-plan attempt numbering and graph-level contract stop policy. Keep the unit workflow, lease carving, branch/PR adoption, git resolver, reviewed-head/check handling and merge door as callable deterministic pieces.
- R20. Remove `agent:ship`, `agent:coding` and `pulls rebase` only as person-facing recovery instructions. Do not remove the presets or the resolver while the orchestrator still calls them as implementation tools. A thread reply is the documented recovery surface.
- R21. Remove `plane.shipReconcile` and the fallback branch only after `off` and `shadow` have no unique fixture and all current rows can be adopted by the orchestrator. Unknown legacy rows fail closed into a bounded reconciliation wait; they do not resurrect the deleted graph walk.
- R22. Remove obsolete config, migrations, generated docs, command copy and spec rows in the same pull request as their last source. Preserve authorization and effective merge grants; deleting `plan:merge` as a workflow-column action cannot broaden `merge` authority.

### Scope Boundaries

- The deterministic unit state machine remains. This plan changes composition and recovery ownership, not review semantics, lease arithmetic, fast-gate commands, repository operations or the merge door.
- Plans remain documents with goals, units, sequencing reasons and proof. U3 removes their executable graph interpretation, not the files or the orchestrator's duty to cite a departure from their order.
- Record 0072 supplies the parent live-state field. This plan adds the child/wait/ending relation in the same transition; it does not introduce a rival live-state vocabulary or a second state event.
- One unit runs at a time during this rollout. Parallel scheduling is a later decision.
- No new merge grant, credential, store, Worker, queue, timer or polling loop. Existing events wake the reconcile loop; absolute bounds come from existing leases and waits.
- No deploy receipt is needed to accept this plan or the record. Deploy behavior belongs to the implementation units' later operational observation, not this documentation pull request.

### Deferred to Follow-Up Work

- Parallel unit selection after one-at-a-time ownership and reconciliation are proven.
- UI affordances for comparing plan reasons with orchestrator departures beyond the thread citation and plane facts.
- Removing internal agent presets after no deterministic tool invokes them; U3 removes recovery directives, not necessarily every implementation name.

---

## Planning Contract

### Key Technical Decisions

- **K1. The unit machine is extracted, not rewritten.** U1 gives both composers one callable seam over the current transition function. A rewrite would make rollout comparison meaningless.
- **K2. Facts are closed before judgement.** `reconcileFactOf` normalizes current ending, round and standing unions while carrying their exact source. The model sees that projection and can select only an enumerated act; it never synthesizes evidence.
- **K3. The config mode is desired ownership.** `plane.shipReconcile` does not route each event independently. Durable `activeComposer` and `composerEpoch` fence writes; a flip asks for transfer at the next durable act boundary.
- **K4. Shadow is side-effect-free by construction.** It receives read-only ports and emits one comparison record. A shared write-capable context would turn a measurement into a second owner.
- **K5. Parent cardinality is one tagged field in the live-state mutation.** Optional `child`, `wait` and `ending` fields updated separately cannot satisfy the invariant across generations. One discriminant plus expected sequence can.
- **K6. The flag retires last.** U3 deletes fallback only after U2's complete fixture matrix and adoption cases pass. Deleting the runner earlier would make an unknown ending a production experiment.
- **K7. Recovery copy is not recovery machinery.** The presets and git resolver may remain private tools; person-facing directives disappear once a plain thread reply deterministically resolves the unit.

### High-Level Technical Design

A small reconcile module owns three pure shapes: `ShipReconcileFact`, `ShipNextAct` and `reconcileFactOf`. The fact adapter consumes the existing unit-machine return plus fresh pull-request and ledger facts. The record-0069 operator/orchestrator selects a `ShipNextAct`; an executor validates the unit's composer epoch and dispatches to the existing unit driver, pending-question store, bounded wait or merge door. There is no generic “set state” act.

The coordinator unit row gains stable composer ownership and one tagged parent relation. Its mutation takes `{ expectedSeq, composerEpoch, ownerGeneration }`, writes the relation and record-0072 live state together, and returns the new sequence. Bot reclaim advances the owner generation before writes resume. The plane's reconcile pass reads malformed legacy rows, derives candidate facts from durable sources and compare-and-swaps either one valid relation or a bounded reconciliation wait.

The rollout mode is evaluated into `desiredComposer`. In `shadow`, the existing normalized hand-off ask and snapshot feed both decision functions, but only the plan runner has an executor. Comparison rows name agreement or the first differing fact/act with bounded redacted detail. In `on`, the orchestrator owns new units. Existing units continue their in-flight deterministic act; after its durable return, ownership can transfer by epoch and adoption. The same protocol handles `on → off`, `off → on` and a process roll.

U3 removes the outer `walk` and plan-cursor types from the coordinator driver, then deletes hand-off and surface copy that tells a person to re-issue an agent or run `pulls rebase`. The unit driver, coordinator routes needed by it, git resolver and merge door remain. Config and documentation generation remove the rollout key after fallback retirement.

### Sequencing

U1 → U2 → U3. U1 requires record 0072 U1's durable projection on the base. U2 requires U1's fact and ownership seams. U3 requires every U2 fixture, the complete shadow comparison and a repository-visible zero-dual-owner proof. No unit may pull U3 deletion into an earlier pull request.

### Assumptions

- `src/core/ship/coordinator.ts` remains the current deterministic unit transition source; its `UnitEnding` union and `ShipRoundOutcome` are the compile-time sources for totality.
- The coordinator unit row and hosted parent live row can be updated through one existing state-Worker transaction after record 0072 U1. If they cannot, U1 stops rather than inventing distributed atomicity.
- The operator already routes plain-words write asks through typed binds; U1 adds a typed ship-unit bind/act rather than a special prose route.
- Existing thread-event deduplication and pending unit identity can accept one pending-question key. U2 extends those seams instead of creating another inbox.
- `cf64c31a` already makes an ended non-merged ship-thread reply re-issue the original task on the same plan and branch and routes a merged unit fresh. U2 preserves that behavior and moves it behind the shared reconcile fact/act seam; it does not build a second continuation path.
- Current git and GitHub readers can return branch tip, pull-request head, reviewed head and check head fresh at reconciliation time.

---

## Implementation Units

| U-ID | Title | Key files | Depends on |
| --- | --- | --- | --- |
| U1 | One plain ask runs one reconciled unit behind the flag | config/dispatcher/operator, unit driver, coordinator row ownership, reconcile fact/act, shadow comparison | record 0072 U1 |
| U2 | Every ending and recovery rule is an executable fixture | parent live-state transaction, plane reconcile, question/resolver/adoption paths, judgement matrix | U1 |
| U3 | The plan walk and recovery directives retire | coordinator graph driver/hand-off, ship contract and surfaces, pulls recovery copy, config/docs/specs | U2 |

### U1. One plain ask runs one reconciled unit behind the flag

- **Goal**: land the smallest complete hot path — a plain-words ask becomes one stable unit, the current deterministic machine runs it, the orchestrator reads its durable result and records one typed next act — while the plan runner remains the default and shadow authority.
- **Requirements**: R1–R7. The pull-request receipt must name `plane.shipReconcile` and include the shadow comparison over the same asks and fact snapshots as the plan runner.
- **Dependencies**: record 0072 U1 merged on the unit's base; no dependency on U2 or U3.
- **Files**: `src/config.ts`, `src/config/validate.ts` and tests; `config/config.example.yaml`; `src/core/installationSettings.ts`; `src/core/dispatch/operator.ts`, `src/core/dispatcher.ts`, `src/core/dispatch/ship.ts` and focused tests; `src/core/ship/coordinator.ts` and tests; extract a reusable unit driver from `src/core/coordinator/driver.ts` with tests; new `src/core/orchestrator/shipReconcile.ts` and `.test.ts` (or the existing orchestrator module if one has landed); `src/core/coordinator/contract.ts`, instance store/state-Worker row and tests for composer ownership; docs generators and the specs in R7.
- **Approach**:
  1. Add failing config tests for absent/off, shadow, on, invalid value, effective source and generated example/reference output.
  2. Characterize the current `runUnit` step sequence with its existing driver tests, then expose it behind one input/output seam without changing the state machine. Keep graph extraction separate from behavior in reviewable commits inside the unit pull request.
  3. Define `ShipReconcileFact` and `ShipNextAct`; pin the fact adapter exhaustively to `UnitEnding`, `ShipRoundOutcome` and approved standing. Carry source facts whole and prohibit generic state writes.
  4. Add durable `{activeComposer, desiredComposer, composerEpoch}` to the unit row and a compare-and-swap ownership transition. Default legacy rows to the plan runner until explicitly adopted.
  5. Route one operator-bound plain ask to a stable unit identity and the unit driver in `on`. On return, re-read repository facts, classify the result and allow only the receipt's merge/wait/done act.
  6. In `shadow`, feed both paths the same normalized ask and snapshot. Give the shadow path read-only ports, record bounded agreement/difference and assert every spawn/write/merge spy remains zero.
  7. Test `off → on` and `on → off` during a coding/review act: the current act finishes once, transfer advances the epoch at its returned fact, the new composer adopts all heads, and an old-epoch write is refused.
  8. Regenerate config/reference output through `npm run fix` only if its source changed; bind exact spec proofs.
- **Test scenarios**:
  - With the key absent or `off`, the same plain ask starts exactly the current plan-runner path and no orchestrator reconcile call occurs.
  - In `shadow`, one normalized ask and one fact snapshot reach both decisions; the comparison says equal for the happy path, only the plan runner starts a child, and all shadow write ports stay at zero.
  - In `on`, “fix the login redirect” creates/adopts one unit and one thread, runs coding → review → checks through the existing machine, then the orchestrator reads `merge_ready` and selects the effective merge wait/door or reads merged and selects done.
  - A second delivery of the ask returns the same unit identity and composer epoch; it starts no second child.
  - Every current `UnitEnding` and `ShipRoundOutcome` maps to one fact class or compile-time fixture; source cause, retained head and pull request survive the mapping.
  - A mode flip in coding, review, checks and merge records desired ownership but neither interrupts nor duplicates the act; transfer at the returned fact advances the epoch once, and the losing writer is fenced.
  - A legacy row with no composer fields remains plan-runner-owned until a successful adoption compare-and-swap.
  - Invalid `plane.shipReconcile` names the allowed values; config output and public docs contain no internal or private identifier.
- **Verification**: run `npx vitest run` on the exact touched config, operator/dispatch, unit-driver, reconcile and coordinator-store test files; `NODE_OPTIONS=--max-old-space-size=6144 npx tsc --noEmit -p tsconfig.json`; `npx prettier --check` on changed files; generated config/docs checks if their sources changed; `npm run hygiene:check`; `npm run specs:check`; CI runs the full suite and `npm run verify`. Receipt: the focused shadow test prints the same ask/fact digest for both decisions, the chosen acts and zero shadow effects.

### U2. Every ending and recovery rule is an executable fixture

- **Goal**: make the accepted record's full reconcile table executable, with one cross-generation parent relation, one pending question, one bounded conflict resolver, salvage on every ending and durable adoption from an ended thread or re-issue.
- **Requirements**: R8–R17.
- **Dependencies**: U1.
- **Files**: the U1 reconcile module and tests; `src/core/pipelineStanding.ts`, `src/core/runEvents.ts` and totality tests; record-0072 live-state/ledger modules and tests; `src/core/runLedger/types.ts`, `ledger.ts`, in-memory/write-through implementations and the state Worker transaction; `src/core/plane/decide.ts`, `src/core/planeService.ts` and tests; `src/core/coordinator/contract.ts`, instance store, routes, checks intake and tests; `src/core/ship/coordinator.ts`, `contract.ts`, coding-child preservation, renewal, preflight and tests; `src/core/pullSweep.ts` as the callable resolver; dispatcher thread-owner/reply paths and tests; specs named by R17.
- **Approach**:
  1. Write the judgement matrix red for the eight accepted reconcile facts plus merged/landed and refused outcomes. Assert exact next acts and forbidden writes.
  2. Add one tagged parent relation and update it with record-0072 live state in one transaction under expected sequence, epoch and generation. Table-test transition legality and stale-write refusal.
  3. Simulate a roll between every pair of writes with old and new generations racing. Reclaim fences old before new; duplicate events are idempotent; readers observe exactly one relation.
  4. Add deterministic repair for legacy zero/many relations. Re-read durable child, ledger and repository facts, compare-and-swap one answer, or park one bounded fault if facts disagree.
  5. Implement one pending-question key consumed from thread or pull-request input. Preserve duplicate answers as transcript rows without a second resume.
  6. Route dirty approved/pre-push facts to the existing resolver under the remaining lease. Centralize the “dirty or unpushed means preserve” predicate so success, stop, death, interruption and bound exhaustion all call it.
  7. Build fresh-fact adoption over branch tip, pull-request head, reviewed head, check head, checkpoint and salvage receipt. Reuse `cf64c31a`'s ended-thread continuation resolver for died/interrupted, re-issue and composer transfer; delete or refuse any parallel path.
  8. Bind each living spec row to the exact matrix, transaction, race, question, resolver, salvage and adoption test.
- **Test scenarios**:
  - `merge_ready`: fresh approved head + green checks + grant reaches the merge door once; person grant and merge queue become one bounded wait; moved/red/dirty facts never call merge.
  - Approved-not-merge-ready: checks pending and queue pending wait; dirty enters one resolver; fix-up commit or moved head returns to fix/review; lost approval returns to review.
  - `held`: thread and pull-request answers race; one key is consumed once, one segment resumes, and the other answer remains transcript evidence.
  - `checks_failed`: findings bind to the exact pushed/reviewed head; automated findings enter fix, human-gated findings park, and no green/merge fact is written.
  - Died: provider transient, child failure and step-threw each re-read branch/pull-request/salvage facts; retry is lease-bounded and a retained head appears on every non-retry ending.
  - `interrupted`: bot restart, replaced container and sandbox fault adopt checkpoint/head/open pull request and resume the earliest safe state without a new attempt or empty branch.
  - Budget: continued/review-pending/round-cap/wall-clock-cap/idle-expired follow the existing renewal/fit result; no act widens a lease, and every ending carries retained work.
  - `stopped`: soft and hard exits invoke preservation for dirty/unpushed work before sealing; no automatic restart occurs; a later explicit thread reply resumes by adoption.
  - A conflict receives one bounded resolver round; success rebases, reruns exact changed-set gates and pushes that head; every unsuccessful exit salvages and parks or ends with the actual cause, never `conflict`.
  - Parent relation transition races old/new generations at child→wait, child→ending and wait→child; every read sees one tag, stale sequence/epoch/generation writes are refused, and same-event retry is idempotent.
  - Legacy zero and many relations repair only from agreeing durable facts; disagreement produces a bounded reconciliation wait and no invented ending.
  - A mode flip in either direction at every matrix row transfers once at the durable act boundary and preserves the same unit, thread, branch, pull request, heads and pending question.
  - The landed ended-thread fixtures remain green through the shared seam: a non-merged pipeline re-issues its original task on the same plan and branch, a merged unit routes fresh, and a stale steer decision cannot consume either reply. A re-issue at an open head resumes review, and an approved green head resumes the merge decision.
  - Write spies prove no reconcile decision sets approval, checks, reviewed head, gate receipt, grant, authorization, confirmation or merge result.
- **Verification**: run the exact touched judgement, ledger/state-Worker, plane, coordinator, resolver, preservation, reply and adoption Vitest files by path; scoped root TypeScript under `NODE_OPTIONS=--max-old-space-size=6144`; prettier on changed files; `npm run hygiene:check`; `npm run specs:check`; any generated docs checks whose sources changed; CI runs full `verify`. The unit receipt is the table/race suite: every source fact names one act, and every two-generation schedule leaves one relation.

### U3. The plan walk and recovery directives retire

- **Goal**: remove the second orchestration language and its recovery vocabulary after the orchestrator owns every current fact, leaving the unit workflow, tools and guards intact.
- **Requirements**: R18–R22.
- **Dependencies**: U2.
- **Files**: `src/core/coordinator/driver.ts` and tests; `src/core/ship/coordinator.ts` graph-only types/tests; `src/core/coordinator/handOff.ts`, contract/briefs and tests; `src/core/dispatch/ship.ts`, dispatcher and surface tests; `src/core/ship/contract.ts`; `src/core/pullSweep.ts` and commands/tests; config types/validation/example/installation settings; coordinator Worker/shim routes if graph-only; run event/standing mappings for removed plan statuses; generated command/config docs and migrations; `docs/reference/specs/agent-ship.md`, `orchestration-plane.md`, `routing-and-config.md`, `command-registry.md`, `run-history.md`, `github-tools.md` and exact affected rows.
- **Approach**:
  1. Freeze one differential fixture corpus from U2. Run the orchestrator and plan runner over identical asks/facts and list every divergence; move each legitimate runner-only behavior into a typed act or deterministic tool before deletion.
  2. Add a repository-visible retirement gate: complete corpus passes, no unit row reports dual composers, no active row is fallback-only, and every legacy row is adoptable or one bounded reconciliation wait.
  3. Delete the plan cursor, dependency ready/block algorithm, merge-mode prediction, generated-plan attempt ids and graph-level stop prose. Keep the extracted unit driver and its state machine unchanged.
  4. Remove plan-runner hand-off/finish paths and graph-only coordinator routes/events once no caller remains. Update exhaustive maps in the same commit as removed source variants.
  5. Replace user-facing `agent:ship`, `agent:coding` and `pulls rebase` recovery sentences with one thread-continuation sentence or no sentence. Keep private tool calls and presets while the orchestrator invokes them.
  6. Remove `plane.shipReconcile`, `off`, `shadow`, comparison storage and fallback code after the retirement gate passes. The orchestrator becomes the only composer; unknown legacy input parks fail-closed.
  7. Regenerate command/config/reference docs and remove stale migration text through repository generators. Rebind or delete exact spec rows only with their source behavior and proof.
- **Test scenarios**:
  - Differential corpus covers merge-ready, approved-not-ready, held, checks-failed, died, interrupted, budget, stopped, merged/landed and refusals; every old next act has an equal orchestrator act or an explicit retained deterministic guard/tool.
  - A plan with stale dependencies remains readable context; the orchestrator cites fresh facts when departing from order, but no cursor blocks or starts a unit.
  - No production import reaches plan-cursor, ready-unit, blocked-unit, merge-mode or attempt-numbering code; deleted coordinator routes return their normal unknown-route refusal rather than partial behavior.
  - A unit in coding/review/fix/checks/merge at upgrade is adopted at its durable act boundary with the same facts; no fallback process restarts it.
  - Thread and card copy contains no instruction to re-issue `agent:ship`, invoke `agent:coding` or run `pulls rebase`; a reply into the thread resumes the unit.
  - Agent presets and git resolver remain callable through typed internal acts as long as an implementation path uses them; no person-facing command is required.
  - Removing the merge-mode column does not change the effective grant, confirmation ladder, merge-door request or person-required outcome.
  - Unknown legacy rows enter one bounded reconciliation wait and expose their reason; they never silently run a deleted graph path.
  - The rollout key is rejected as retired configuration with a migration sentence, then disappears from generated settings/reference output once the migration window specified by repository convention closes.
- **Verification**: run exact coordinator-driver/hand-off, ship machine/contract, dispatcher/surface, pulls/commands, config and differential retirement tests by path; scoped root TypeScript under `NODE_OPTIONS=--max-old-space-size=6144`; prettier on changed files; generated docs/command checks; `npm run hygiene:check`; `npm run specs:check`; CI runs full `verify`. The unit's completion receipt is the passing differential corpus plus the no-import/no-directive assertions and the zero-dual-owner retirement gate.

---

## Verification Contract

| Criterion | Proof |
| --- | --- |
| One plain ask runs one existing unit atom and returns one typed next act | U1 operator → unit-driver → reconcile integration test [gap: U1] |
| `plane.shipReconcile` defaults off and shadow cannot write | U1 config tests and same-ask shadow comparison with zero effect spies [gap: U1] |
| Flag changes preserve a mid-round unit in either direction | U1 composer-epoch transfer matrix over coding/review/checks/merge [gap: U1] |
| Current ending, round and approved-standing unions are total | U1 compile-time and table tests over `UnitEnding`, `ShipRoundOutcome` and approved facts [gap: U1] |
| Parent cardinality is exactly one across two generations | U2 state-Worker transaction and race schedule matrix [gap: U2] |
| Legacy zero/many rows repair without guessing | U2 durable-source repair tests with agree/disagree cases [gap: U2] |
| Merge-ready and approved-not-ready cannot bypass head/check/grant facts | U2 judgement matrix and merge-door write spies [gap: U2] |
| One human question parks and resumes once from either surface | U2 pending-key race and redelivery tests [gap: U2] |
| Conflict resolution is bounded and every ending salvages dirty/unpushed work | U2 resolver exit matrix and preservation spies [gap: U2] |
| Died, interrupted, budget and stopped retain and adopt work correctly | U2 ledger/branch/pull-request adoption matrix [gap: U2] |
| Ended-thread replies and re-issues continue the same unit | U2 thread-owner and adoption integration tests [gap: U2] |
| The orchestrator cannot write machine or door evidence | U2 typed-act negative capability tests [gap: U2] |
| The plan runner has no unique behavior before deletion | U3 differential fixture corpus [gap: U3] |
| Graph walk and recovery directives are absent while tools/guards remain | U3 dependency/no-copy assertions and focused guard regressions [gap: U3] |
| No dual-owned or fallback-only row blocks retirement | U3 repository-visible retirement gate [gap: U3] |
| The accepted record and this plan land together | After this documentation pull request merges, `main` shows record 0073 with `status: accepted` and this exact plan path; no deploy is required |

Every implementation unit runs the fast gates at changed-set scope before each push: `npx vitest run` on exact touched test files; `NODE_OPTIONS=--max-old-space-size=6144 npx tsc --noEmit -p` for each touched tsconfig; `npx prettier --check` on changed files; `npm run hygiene:check`; `npm run specs:check`; and `npm run check:pr-title -- "<title>"`. Generated docs/config checks run when their source changes. CI alone runs the full suite, full typecheck and `npm run verify` after the push.

## Definition of Done

- U1, U2 and U3 merge in order, each with exact living-spec proofs and no weakened guard.
- One plain-words ask reaches one stable unit and the orchestrator decides again only from a durable closed fact.
- Every current merge-ready, approved-not-ready, held, checks-failed, died, interrupted, budget and stopped fact has one tested next-act rule; merged/landed and refusal outcomes remain terminal or guard-owned as specified.
- A hosted parent exposes exactly one live child, bounded wait or ending through rolls and composer changes; stale generation, epoch and sequence writes are fenced.
- A question, conflict, process death, interruption, spent bound, stop, ended-thread reply and re-issue all preserve the same unit identity and adopt durable work.
- The plan cursor, dependency walk, merge-mode prediction, attempts and person-facing recovery directives are gone; the unit machine, git resolver, guards and merge door remain.
- Public hygiene, specs and CI's full verification pass for every unit.
- For this documentation unit's receipt, the pull request merges and `main` carries record 0073 as accepted plus `docs/plans/2026-09-21-002-feat-the-ship-pipeline-dissolves-into-the-orchestrator-plan.md`; no deploy is needed.
