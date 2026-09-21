---
title: The ship pipeline dissolves into the orchestrator — the unit machine is the deterministic atom, judgement composes units, and the pipeline graph retires
status: proposed
date: 2026-09-21
pattern: Agentic orchestration over deterministic unit workflows — coding → review → fix → checks → merge remains one leased, single-owner state machine; an LLM loop reads each durable ending and chooses the next bounded act, while DAG planning, recovery directives and person-managed workflow columns retire
---

# The ship pipeline dissolves into the orchestrator: the unit machine is the deterministic atom, judgement composes units, and the pipeline graph retires

**The ask.** Record the maintainer's decision of 2026-09-19, reaffirmed 2026-09-21: the deterministic atom is the **unit machine** — coding → review → fix → checks → merge, under [record 0046](0046-a-budget-is-a-lease-carved-from-its-parent-and-one-module-proves-the-leases-fit.md)'s leases, [record 0051](0051-a-thread-has-one-owner-for-its-life-a-message-is-one-event-in-a-chosen-mode-and-a-pipeline-idles-instead-of-ending.md)'s one owner, [record 0064](0064-the-plane-owns-every-runs-state-a-refusal-becomes-a-queue-position-an-ending-is-judged-by-the-ledger-that-saw-it-and-a-release-is-a-quiet-window-a-person-closes.md)'s admission and endings, the merge door, and [record 0071](0071-a-ship-unit-owns-its-pull-request-until-it-is-merged-merge-ready-waits-on-facts-and-a-dirty-head-buys-a-rebase-round.md)'s rebase before every push. An LLM orchestrator — [record 0069](0069-the-one-door-has-one-execution-path-a-bind-runs-clicks-or-routes-a-violation-is-re-asked-a-disagreement-floors-and-no-chat-surface-hands-back-a-line-to-retype.md)'s one-door loop, continuing in [record 0070](0070-the-control-plane-is-where-the-maintainer-works-the-plane-page-pins-a-chat-column-beside-the-panels-and-an-orchestrator-thread-answers-about-the-fleet-and-acts-on-it.md)'s orchestrator thread — composes those atoms by judgement and decides again after every unit ending. Written for an engineer who knows the plan runner, the ship coordinator and the plane. Success criteria:

1. A plain-words ask in Slack reaches the orchestrator; the orchestrator chooses one bounded unit; the deterministic unit machine runs it; the orchestrator reads its ending and the fresh repository and plane facts, then chooses the next act — a fix round, a re-issue adopting the branch head, a question parked on the thread, the merge, or done.
2. The unit machine keeps the deterministic work where predictability is load-bearing: leases and admission, one owner, coding → review → fix → checks → merge, reviewed-head and fast-gate guards, rebase-before-push, the merge door, and named endings with causes. The orchestrator calls this machine; it does not replace its transitions with prose.
3. The plan runner's DAG features retire: depends-on columns, the sequential walk, `plan:merge` versus `merge: person`, attempts numbered by re-issue, and the typed unit contract's stop rules. Deterministic workflows remain as callable pieces, never a DAG a person manages.
4. The thread is the conversation with the orchestrator. [Record 0055](0055-a-unit-has-one-thread-and-a-round-reads-the-checks-at-its-head.md) keeps one thread per unit, and [record 0068](0068-one-agent-per-unit-a-run-continues-its-threads-transcript-and-the-unit-is-the-reading-unit.md) keeps the transcript across runs. A reply after today's pipeline process ended resumes that thread's unit; it does not require a recovery directive and does not start a rival unit.
5. Reconciliation is structural: a parent declares exactly one of a live child, a bounded wait or an ending; a stuck move re-reads durable facts; a question is a bounded wait; a pre-push conflict is a bounded resolve step inside the unit; and a re-issue adopts durable work instead of recreating it.
6. No ending discards a commit. The branch head and an open pull request are inputs to the next decision, not residue from a failed attempt.
7. A person still merges wherever the effective grant requires a person. What retires is the plan column that predicts the actor, not authorization, confirmation or the merge door.

## TL;DR

The product has two orchestration systems where it needs one. The plan runner deterministically walks a DAG, numbers attempts, predicts who will merge and turns a typed unit contract's stop sentences into terminal outcomes; people recover from the cases it cannot express by re-issuing `agent:ship` or `agent:coding`, running the pull-request sweep, and explaining the next move in a thread. Beside it, the one-door loop and the orchestrator thread already provide the missing capability: read fresh facts, use judgement, act through deterministic tools, and continue one conversation. The bet is to keep the part that is genuinely a machine — one unit's coding → review → fix → checks → merge under leases, ownership, admission, gates and the merge door — and make that the atom an LLM orchestrator composes. After every ending the orchestrator reads the facts and decides again; plans become context, not an executable DAG. Doing nothing keeps recovery as a second, person-driven orchestrator outside the runner, where releases, human questions and rebase conflicts can leave durable work with no live decision-maker.

## Today at `933821ab`

The seams this record removes and the atom it preserves are visible at head:

| Seam at `933821ab` | What it decides today | Disposition |
| --- | --- | --- |
| `src/core/coordinator/driver.ts` | Walks units one at a time in plan order, waits for in-play dependencies to merge, blocks dependents after any other ending, distinguishes a plan branch merged under `plan:merge` from a task branch waiting for a person, and turns a re-issue into another numbered instance | Retire the graph walk, dependency columns, merge-mode column and attempt numbering. The orchestrator reads the plan as context and chooses one next unit from current facts. |
| `src/core/ship/coordinator.ts` | Implements the pure unit machine: coding → review → findings/fix → checks → merge, one branch and one unit thread, retry-safe steps and named endings | Keep it as the deterministic atom. Narrow its interface to start or resume one unit from durable branch, pull-request, review and check facts, and return one ending with its cause and retained head. |
| `src/core/ship/contract.ts` | Renders the typed unit contract and says, before the pointer to the unconditional rebase rule, “A conflict ends the unit: report it as the handoff and stop.” | Retire stop rules as orchestration policy. A pre-push conflict enters the unit's bounded resolve step; the contract carries facts and guards, not a terminal judgement that contradicts rebase-before-push. |
| `src/core/pullSweep.ts` | Exposes `pulls rebase` as a person's command for an unowned pull request and has a special runner-owned path for a live pipeline | Keep the deterministic git resolver as a callable piece. The orchestrator invokes it for the owned unit; the sweep is not the normal recovery surface a person must remember. |
| `src/core/coordinator/handOff.ts`, `src/core/dispatch/ship.ts`, `src/core/ship/coordinator.ts` | Create or re-issue plan-runner instances; recovery words tell the person to post `agent:ship`, while findings enter the unit as `agent:coding` | Retire the recovery directives. The orchestrator thread owns the next decision and binds the same unit from plain words or a resumed event. |
| `src/core/ship/coordinator.ts` entry facts and agent-ship item 10 | An open pull request at the branch tip resumes at review, and an approved green head resumes at the merge decision | Preserve and generalize this adoption rule: every re-issue starts by adopting the branch head or open pull request, never by assuming an empty attempt. |

The split is already implicit. The unit machine is pure and deterministic; the driver around it is another deterministic machine trying to encode judgement about which work matters next. The former is the safety boundary. The latter is the part incidents route around.

## The shape

### The deterministic atom

One invocation of the unit machine owns one unit identity, one thread, one branch and, once opened, one pull request. It enters from durable facts — branch head, open pull request, reviewed head, checks, prior ending and pending question — and runs the next deterministic transition permitted by those facts. Coding, review, fix, checks and merge remain explicit states with retry-safe step keys. Record 0046's lease bounds each child and wait; record 0064 admits the work and owns its ending; record 0051 prevents a second owner; record 0071 requires the rebase and fast gates before each push; the merge door re-reads approval, checks, head and grant before it acts.

The machine returns facts, never advice: one named ending with a cause, the branch head it retained, the pull request and reviewed head when they exist, the check and review facts, and whether a pending question or bounded wait remains. A caller cannot turn “the process ended” into “the work vanished”: every commit-bearing return names the retained head.

### The orchestrator's loop

The orchestrator is one LLM loop behind record 0069's door, continuing in the unit's record-0070 thread. Its loop is:

1. Read the ask, the continuing transcript, the plan when one was named, and fresh plane and repository facts.
2. Choose one unit-sized next act and call the deterministic machine or another deterministic tool.
3. Read the resulting ending, wait or question and its cause.
4. Decide again: run a bounded fix or rebase step in the same unit, adopt the durable head in a re-issue, park one question, pass a merge through the door, start another unit, or report done.
5. Record the decision and the cited facts in the thread, then repeat only when an event or the person supplies new facts.

This is judgement between atoms, not inside them. Record 0068's wall still holds: no model arbitrates a review verdict into an unguarded code change, and the coding → review → fix → checks → merge transitions remain machine-owned. The orchestrator decides which bounded transition to ask for next after a returned fact; the deterministic component authorizes, fences and executes it.

### Plans become context, not programs

A plan may still name units, sequencing arguments, risks and validation. It is read by the orchestrator as evidence. It is no longer compiled into a person-managed DAG with depends-on columns, a sequential cursor, merge-mode columns or attempt counters. “The consumer follows the schema change” remains a reason the orchestrator should usually honor; it is not a graph edge whose stale status can block a newly safe act after the facts change.

A re-issue is therefore not “attempt 3”. It is another decision in the same unit's conversation, starting from the branch head or open pull request the last decision retained. The unit identity, thread, branch and pull request remain stable. A roll, a model refusal or a human question can end one run without manufacturing a new unit.

### The conversation is the recovery surface

The unit's thread is where the orchestrator asks and where a person answers. A question is durable pending state keyed to the unit and the fact that required it. The first accepted answer from either the unit thread or the pull request clears that pending question and resumes the same unit; a duplicate answer becomes transcript evidence and starts nothing twice. A reply after the old pipeline process ended resolves the unit from the thread and resumes it. `agent:ship`, `agent:coding` and `pulls rebase` cease to be recovery instructions because the thread itself names the work and the orchestrator has the tools.

### The reconciliation rules

| Rule | Required transition | 2026-09-21 fixture |
| --- | --- | --- |
| A live parent declares exactly one of **a live child**, **a bounded wait** or **an ending** | The parent carries the state field accepted by [record 0072](0072-a-run-has-one-live-state-owned-by-the-server-a-closed-set-one-event-one-wording-function-and-every-surface-reads-the-one-field.md). Child completion atomically replaces the child state with a wait or ending. The plane's stuck move never infers an ending from silence; it re-reads the child, ledger and repository and records the cause it finds. | Issue #2134: the 1.260.1 roll left the parent live and childless; issue #2133's reconciliation resumed it. The forbidden state is the gap between those facts. |
| A human-gated finding is a **question**, not a failed attempt | Park the unit on one durable pending question. An answer in the unit thread or on the pull request resumes the same unit under the same owner; no new attempt or rival run starts. | Issue #2154; pull request #2140 accumulated three held attempts while waiting on a person. |
| A pre-push rebase conflict is a **bounded resolve step inside the unit**, never an ending | The resolver runs under the unit's remaining lease with the thread and repository instructions. If it cannot resolve inside the bound, the unit parks a question or another bounded decision; “conflict” itself never discards the head or becomes the ending cause. | Issue #2153; `src/core/ship/contract.ts` says “A conflict ends the unit” immediately before the `REBASE_BEFORE_PUSH` pointer; run `c0bbe2c8` is the concrete loss path. |
| The fast gates run on **the tree that is pushed** | Rebase first, then run the changed-set gates, then push that exact head. A gate receipt from the pre-rebase tree proves nothing about the pushed tree. | Issue #2152. |
| A reply into a thread whose pipeline process ended resumes **that thread's unit** | Resolve the stable unit identity from the thread, adopt its durable head or pull request, and continue the orchestrator loop. Never require a top-level recovery directive. | Issue #2144. |
| A re-issue adopts durable work | Read the branch tip and the open pull request first. Resume review at the actual tip, or the merge decision at an approved green head; only a unit with neither durable fact starts coding from zero. | The entry-facts path in `src/core/ship/coordinator.ts` and agent-ship item 10 at `933821ab`: open heads resume review and approved green heads resume the merge decision. |

The parent invariant is a cardinality rule, not display advice: for a hosted parent, `live child + bounded wait + ending = 1`. A transition writes the replacement before releasing the old state. Any read that finds zero or more than one is a reconciliation fault; the plane re-reads the sources and records the repair. An ending always names its cause and retained work.

## One hard-case trace: the roll leaves a parent, not an orphan

This replays the #2134/#2133 failure through the new boundary; the later fixtures show how the same unit continues instead of becoming another attempt.

1. The orchestrator has chosen one unit. Its parent declares one live coding child; the child has pushed a commit and the parent carries that head. The 1.260.1 roll replaces the process before the next transition is recorded.
2. Today, #2134 could leave the parent live but childless: neither a live child, a bounded wait nor a named ending. Recovery arrived from #2133 outside the runner. Under this record, the zero-cardinality read is itself the plane's stuck fact. The move re-reads the durable child record, branch and pull request, then atomically records either the still-live child, a bounded rehost wait, or an ending whose cause is the roll. It never invents failure from the missing process.
3. The orchestrator wakes on that recorded fact. It adopts the retained branch head or open pull request and decides the next act; it does not restart a sequential plan walk or number a new attempt. If review needs a person's judgement, the #2154 rule parks one question. If the next push meets the #2153 conflict, the unit enters its bounded resolver and retains the commit.
4. The resolver rebases first. The #2152 rule runs the fast gates on the resulting head and pushes that exact tree. A successful fix returns to review or checks through the unit machine; an unresolved decision parks, with its bound and question visible on the parent.
5. If the hosting process ends again, a reply in the unit thread applies #2144: the same orchestrator conversation resumes the same unit and adopts the head. The only terminal outcome is a named ending caused by an actual fact — merged, stopped by the person, refused by a guard, or a spent bound — never “the process rolled”, “a question was asked” or “git conflicted”.

The property: every event leaves one decision-maker or one named reason there is none, every commit remains adoptable, and a deploy changes latency without changing ownership.

## The difficulty map

1. **The parent cardinality across a roll** (most consequential): child completion, rehost and ending are written by components that can be on different generations. The transition must be durable and idempotent; otherwise the orchestrator is only another observer of the same owner gap. Record 0072's state field is accepted but not yet implemented, so the rollout cannot claim this rule shipped until that field or an equivalent durable projection exists.
2. **Keeping judgement outside the atom**: the orchestrator must be free to choose the next unit without being able to waive reviewed-head, fast-gate, admission, authorization or merge-door guards. The tool boundary, not a prompt sentence, enforces the split: judgement selects a typed act; deterministic code decides whether and how it runs.
3. **One question, two answer surfaces**: the same human-gated finding can be answered in the thread or on the pull request. Both feeds must converge on one pending-question key so redelivery, a near-simultaneous answer and a copied reply resume once.
4. **A conflict that is bounded but not terminal**: “never an ending” cannot mean “retry forever”. The resolve step spends a lease; on exhaustion it becomes a bounded wait for a question or a fresh orchestrator decision, retaining the head. A later stop may end the unit, but the ending cause is the stop, not the conflict.
5. **Adoption without stale work**: the branch tip, pull-request head, reviewed head and check head can differ. Re-issue must read all four fresh and enter the earliest safe deterministic state; “an open pull request exists” is not enough to skip coding when the branch advanced beyond it.
6. **Retiring recovery without removing an escape hatch too early**: directives and the plan runner are today's way out. The flagged loop must prove resume, question and rebase fixtures before those surfaces disappear, and fallback must not create two owners for one unit.
7. **Explaining a plan that is no longer executable**: plans still carry engineering intent and review-sized cuts. The orchestrator must cite why it departed from a written order, or “judgement” becomes unreviewable scheduling by vibe.

## The hard parts

**The atom/composer boundary.** “Let the orchestrator decide” is safe only because the unit machine remains an indivisible tool with its own guards. The orchestrator may decide *that* another fix round is warranted; it cannot mark review approved, claim gates passed, choose an unreviewed head or merge around the door. The machine returns facts in a closed shape, and the next call starts from those facts.

**An ending is evidence, not disposal.** Today's attempt vocabulary bundles process lifetime with work lifetime. This record separates them: a child or hosting process may end while the unit, branch and conversation continue. Every ending carries its cause and retained head, and every next decision starts by adoption. That is what makes a roll, a held question and a bounded resolver ordinary transitions rather than special recovery paths.

**Reconciliation must work without the model.** The LLM cannot be the mechanism that notices a parent has no child: it can roll too. The plane owns the cardinality check and durable repair trigger. The orchestrator receives the repaired fact and chooses what it means for the work; deterministic code establishes that the fact exists.

**The person-merge boundary survives the column's retirement.** `plan:merge` versus `merge: person` currently mixes workflow shape with authority. Removing the column does not grant the orchestrator a merge. Each merge decision still passes the requester's resolved grant, the confirmation ladder and the merge door; when those say “person”, the orchestrator parks the question or presents the act and waits.

## Why not X

**Why not repair the DAG runner one more time?** The six rules above are not graph problems. A human question, a deploy roll, a rebase conflict and a reply after process death require fresh facts and judgement about the next bounded act. Encoding each as another status, edge and attempt rule grows a second orchestration language whose recovery still happens in prose outside it.

**Why not make the whole pipeline agentic?** Review approval, check settlement, head equality, lease arithmetic, admission and merge authorization must be repeatable and inspectable. Turning them into model judgement would trade the runner's rigidity for nondeterminism at the safety boundary. The unit machine is retained precisely because those transitions are where predictability matters.

**Why not keep a deterministic super-workflow and let the orchestrator fill its blanks?** A workflow with “LLM decides the next node” is still a DAG whose author must enumerate every legal node and recovery edge. The decision here is smaller: the orchestrator can call deterministic units and tools from current facts; no second graph claims to know the whole conversation in advance.

**Why not keep depends-on as a hard guard?** Dependencies are engineering reasons, not always repository facts. The orchestrator should normally honor them and must explain a departure, but a merged change, an adopted open pull request or a person narrowing scope can make an old edge false. The guards that must never soften live inside the unit machine and door; plan order remains context.

**Why not treat a question or rebase conflict as a clean ending and re-issue later?** That is today's attempt leak. It splits one unit across parent rows, loses the active owner, makes replies ambiguous and risks rerunning from stale input. A bounded wait or resolve step says the truth: the unit still exists and is waiting on one named fact.

**Why not retain `agent:ship`, `agent:coding` and `pulls rebase` as the documented recovery path?** They make the person reconstruct state the system already has, and a mistargeted directive can start rival work. They may exist during the flagged rollout, but successful reconciliation makes them implementation tools the orchestrator calls, not commands a person must know.

## Boundaries

Unchanged: the unit machine's coding, review, fix, checks and merge internals; record 0046's lease fit; record 0051's one-owner rule; record 0055's one thread per unit; record 0064's plane admission and named endings; record 0066's vocabulary; record 0068's continuing transcript and reviewer wall; record 0069's one door; record 0071's rebase-before-push, reviewed-head rule and merge door. This record changes who composes units, not how a guarded unit transition proves itself.

Not granted: autonomous merge authority. A person still merges wherever the effective grant, repository rule or confirmation requires it. The orchestrator can present and park that act; it cannot convert “person” into “runner”.

Not owned here: the plan format's long-term documentation shape, record 0072's implementation, a new scheduling heuristic for parallel work, or a new vocabulary. The first rollout deliberately runs one next unit at a time; concurrency is a later decision over plane capacity and independent unit ownership, not a preserved DAG feature.

Compatibility: cut one is behind a flag and the plan runner is the fallback. The flag selects one composer for a unit; it never lets both own the same unit. Rollback returns composition to the plan runner without rewriting the unit machine or discarding the durable head.

## Rollout

One plan in the same series as this record, with every unit sized to one review and this record remaining `proposed` until the independent cold-reader receipt and the implementation gates land.

1. **Cut one — the smallest hot-path change.** Put the orchestrator's reconcile loop over today's unit machine behind a flag. A plain-words Slack ask enters the orchestrator thread; it selects one unit, starts or adopts it, reads its ending and chooses the next act. The existing plan runner is the fallback, and admission enforces one composer per unit. Prove the #2134/#2133 parent repair, branch/open-pull-request adoption and a reply after the hosting process ended.
2. **Cut two — judgement fixtures.** Make the six reconciliation rows above executable fixtures: parent cardinality and stuck re-read; the #2154 question parked and resumed from thread or pull request exactly once; the #2153 conflict as a lease-bounded in-unit resolver with no discarded commit; the #2152 gates on the pushed tree; #2144's ended-thread resume; re-issue at branch tip/open pull request. Each fixture asserts the ending cause and retained head.
3. **Cut three — retire the rival composer.** Remove the plan runner's graph walk, depends-on and merge-mode columns, numbered attempts, contract stop rules and person-facing recovery directives. Keep the deterministic unit workflow, git resolver and merge door as tools. Remove the flag after the fallback has no unique fixture and the plane shows no units owned by both paths.

**Beta target: the week of 2026-09-21.** The target is a beta, not acceptance. Acceptance waits on the maintainer's independent cold-reader gate on the pull request: the reader sees only this record and returns a quoted restatement, the hardest part, and the first objection the record already answers. That receipt lands afterwards as a dated amendment; this author-side adversarial review is not a substitute.

## Sources

- The maintainer's decision of 2026-09-19, reaffirmed 2026-09-21: the deterministic unit machine is the atom and the LLM orchestrator composes units by judgement.
- Issues #2133 and #2134 — the 1.260.1 roll, the childless live parent and its reconciliation.
- Issue #2154 and pull request #2140 — a human-gated finding represented as three held attempts instead of one parked question.
- Issue #2153, run `c0bbe2c8`, `src/core/ship/contract.ts` and the coding preset's `REBASE_BEFORE_PUSH` rule — the conflict contradiction and the discarded-work risk.
- Issue #2152 — the fast gates must prove the tree that is pushed.
- Issue #2144 — a reply in a thread whose pipeline process ended must resume the thread's unit.
- `src/core/coordinator/driver.ts`, `src/core/ship/coordinator.ts`, `src/core/ship/contract.ts`, `src/core/pullSweep.ts`, `src/core/coordinator/handOff.ts`, `src/core/dispatch/ship.ts` at `933821ab` — the seams preserved, narrowed or retired.
- Records [0046](0046-a-budget-is-a-lease-carved-from-its-parent-and-one-module-proves-the-leases-fit.md), [0051](0051-a-thread-has-one-owner-for-its-life-a-message-is-one-event-in-a-chosen-mode-and-a-pipeline-idles-instead-of-ending.md), [0055](0055-a-unit-has-one-thread-and-a-round-reads-the-checks-at-its-head.md), [0064](0064-the-plane-owns-every-runs-state-a-refusal-becomes-a-queue-position-an-ending-is-judged-by-the-ledger-that-saw-it-and-a-release-is-a-quiet-window-a-person-closes.md), [0066](0066-a-user-meets-twelve-nouns-and-no-others-the-vocabulary-is-a-reference-page-bound-to-the-code-and-the-consistency-check-fails-a-user-surface-that-prints-an-internal-word.md), [0068](0068-one-agent-per-unit-a-run-continues-its-threads-transcript-and-the-unit-is-the-reading-unit.md), [0069](0069-the-one-door-has-one-execution-path-a-bind-runs-clicks-or-routes-a-violation-is-re-asked-a-disagreement-floors-and-no-chat-surface-hands-back-a-line-to-retype.md), [0070](0070-the-control-plane-is-where-the-maintainer-works-the-plane-page-pins-a-chat-column-beside-the-panels-and-an-orchestrator-thread-answers-about-the-fleet-and-acts-on-it.md), [0071](0071-a-ship-unit-owns-its-pull-request-until-it-is-merged-merge-ready-waits-on-facts-and-a-dirty-head-buys-a-rebase-round.md) and accepted [0072](0072-a-run-has-one-live-state-owned-by-the-server-a-closed-set-one-event-one-wording-function-and-every-surface-reads-the-one-field.md).

## Public hygiene

This record keeps only the public evidence required to test the decision: public issue and pull-request numbers, the released version, a shortened run id, repository-relative paths and the pinned public-tree sha. It names the decision-maker only by role. It carries no Slack channel, user or message ids, no private URL, no customer or company name, no credential, and no unpublished cost or account detail. The issue, pull-request, version and run references remain because removing them would make the reconciliation claims unauditable; they live in the decision record and not in production comments or user-facing copy.

## Amended 2026-09-21 — adversarial correctness review; the independent cold-reader gate remains pending

Before this proposal stands, an author-side adversarial pass tried to falsify the boundary rather than summarize it. No independent or cross-model reader was used in this pass; that is deliberately the pending cold-reader gate, not evidence silently claimed here.

1. **Objection: an LLM orchestrator contradicts record 0068's “only a state machine sits between agents”.** Valid if the orchestrator could translate a review into code or waive a guard. The record now draws the boundary twice: coding → review → fix → checks → merge stays one deterministic atom, and the orchestrator selects only typed, bounded acts after returned facts. Record 0068's reviewer wall and machine-owned transitions survive.
2. **Objection: “exactly one of child, wait or ending” is impossible during hand-off and after a process roll.** Valid unless the replacement is durable and atomic. The reconciliation section makes it a cardinality invariant, assigns zero-or-many to the plane's stuck move, requires a re-read rather than inference from silence, and makes record 0072's accepted but unimplemented field (or an equivalent durable projection) a rollout dependency. The model is not the repair mechanism.
3. **Objection: answers on both the thread and pull request can resume twice.** Valid and actionable. The shape now requires one durable pending-question key; the first accepted answer clears it, redelivery and the other surface become transcript evidence, and no second act starts.
4. **Objection: a conflict that is “never an ending” can retry forever.** Valid trade-off only if “bounded” has a next state. The record now says the resolver spends the unit's lease and, if unresolved, parks a question or another bounded decision while retaining the head. A later person stop or spent overall bound can end the unit with that actual cause; `conflict` itself never disposes of work.
5. **Objection: retiring `merge: person` accidentally grants autonomous merge.** Contract misread prevented by a harder boundary: the column retires, the effective grant does not. Every merge still passes authorization, confirmation and the merge door, and a person acts wherever those resolve to person.
6. **Objection: removing depends-on makes plan order optional and unsafe.** Noise for safety guards, valid for engineering intent. Guards remain inside the unit and door; plan dependencies remain reasons the orchestrator reads and should honor. A departure must cite fresh facts in the thread, making judgement reviewable rather than silently discarding the plan.
7. **Objection: fallback can produce two owners.** Valid and rollout-blocking. The flag selects exactly one composer at admission for a stable unit identity; rollback changes the composer only after the durable head is adopted. Cut three cannot remove the fallback until the plane proves no dual-owned unit and every fallback-only fixture has moved.
8. **Objection: this proposal treats record 0072's accepted authority as shipped implementation.** Valid. The record now distinguishes acceptance from implementation everywhere 0072 is load-bearing and makes its field or an equivalent durable projection a dependency, never a present implementation fact.

After those changes, the remaining risk is not an unanswered structural contradiction but whether a reader with no session context can recover the boundary and the reconcile rules from the document alone. That is the pending gate: the maintainer gives only this record to an independent reader on the pull request and appends the reader's quoted restatement, hardest part and already-answered first objection. Until that receipt lands, `status: proposed` is the truthful status.
