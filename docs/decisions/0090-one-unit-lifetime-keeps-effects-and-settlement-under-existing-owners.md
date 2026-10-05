---
title: One unit lifetime keeps effects and settlement under existing owners
status: proposed
date: 2026-10-04
pattern: Single-writer state, compare-and-swap reservation, transactional outbox and retained finalization obligations
---

# One unit lifetime keeps effects and settlement under existing owners

## Context

[Record 0073](0073-the-ship-pipeline-dissolves-into-the-orchestrator-the-unit-machine-is-the-deterministic-atom-and-judgement-composes-units.md) chose a deterministic unit machine composed by the main conversation. Its rollout also proposed another composer, an epoch, an off/shadow/on flag and complete graph retirement. Those structures are unnecessary for the supported lifecycle. Existing durable unit, recovery, run, session and workspace owners already hold the relevant authority. Seeded plans still have supported dependency behavior that cannot be deleted without changing their contract.

The process-local pull ownership map could disagree with durable work after restart. Composite GitHub mutations could lose a response and then replay a request whose outcome was unknown. A terminal execution could finish before its report or workspace obligations, leaving a process responsible for obligations that outlived it.

## Decision

Keep one shared deterministic unit lifetime for generated tasks, exact pull requests and original-unit recovery. It owns the pre-start stop check, coding, review, findings, checks, bounded continuation, indexed idle waits and confirmed terminal settlement. Generated work enters that lifetime directly as one independent unit. Seeded plans retain the existing dependency sequencer, ordering, appended selection, blocked/stopped outcomes and merge authority. There is no second sequencer or claim that every graph feature has retired.

The main conversation composes bounded work. A run is an execution of that work; it is not a replacement unit or a new grant. The existing recovery journal identifies each requester-authorized recovery by its original source and immutable payload. Transport Workflow identity, action identity and the child namespace stay exact across retries. A later action cannot adopt an earlier action's uncertain writes or consumed evidence. Missing historical allowance or provenance never becomes a new budget.

### Ownership and effects

Read complete canonical pull owners from the existing store, including unhosted units, direct publication producers, terminal uncertain effects and retained workspace obligations. A read routes input; it cannot reserve a writer. Ownership-sensitive admission and target changes check exclusivity in the same store transaction as the original full-row replacement. Incomplete, unreadable or unavailable scans refuse. Remove process-local ownership maps, reservations and restart rebuilds.

Keep one bounded `currentEffect` on the original unit. Its exact execution, ordinal, target and native calls are immutable after admission. Begin each call durably before its external request. Native accepted/refused/uncertain results are operation-specific facts. A missing response is uncertain; a later mutable listing does not certify acceptance or authorize replay. Stop and terminal settlement retain unresolved effects and their original owner. Ordinary writes cannot erase or regress the cell.

Reuse existing run publication receipts for ordinary runs and existing unit effects for original dead-child recovery. Freeze original publication bytes in the existing private session before writing. An optional identity ref move and pull creation are separate calls. Positive native acknowledgement must be durable before publication credit. Full native target and response checks remain; GitHub endpoints without a head precondition are not described as atomic head CAS.

### Maintenance

An authorized command or authenticated watch retains its typed source intent, resolved actor/requester, exact repository/PR/ref/base/head and immutable lease, turn bound and reserved paid-round allowance. Maintenance admission reserves the existing effect cell before local preparation. A frozen plan then names its native push, metadata update, comment or funded child calls. No-op cancellation applies only to the exact never-begun reservation.

Reuse an eligible original unit and its publication owner without replacing its requester, terminal report, private work brief or history. When a command targets an unowned PR, admission creates a logical maintenance instance and unit in the same existing store. A foreign requester, channel, credential or relay cannot reuse this original owner. After settlement and a complete atomic ownership scan, a new same-owner intent can bind its natively read current head and base without changing historical requester, report or instance base. This logical identity has no native Workflow. Maintenance child metadata retains its exact action identity; completion and lifecycle signals never fabricate a Workflow recipient.

A native-only operation consumes no model charge. A model resolver requires explicit funding, an admitted exact child and the original reserved allowance. This allowance accounts for a paid round; it is not a per-call dollar cutoff. The actual dispatcher enforces the immutable lease and turn bound. Only positively acknowledged child admission records its charge; uncertain dispatch retains the pending call and does not admit a second child. Only an exact accepted original native push may advance the publication binding. Changed grants, native heads or canonical owners refuse before another effect.

### Reports and workspace obligations

The existing state owner discovers attributable terminal Workflow executions through a bounded worklist and the existing alarm. It persists reconciliation in the existing outbox before delivery to the bot. Native termination is not successful work. Unknown status or an active uncertain effect retains ownership. The shared bot performer revalidates the original action and row, settles through the existing terminal transaction, freezes the original report, records status and completes required private or public delivery. It dispatches no replacement work. Outbox acknowledgement independently rereads the exact required receipts. Pending original report obligations fence reentry.

HTTP/MCP job handles may explicitly declare their initial report deliverable as durable state. Before the first terminal report admission, that capability may select an empty thread copy while retaining the full report and status. The existing empty-copy receipt means no message was owed; it does not claim a reply. A retry after committed admission but failed freeze uses only the original exact owner/proposal. Missing adapters, arbitrary undeliverable handles, prior admissions and existing frozen nonempty copies cannot discard original bytes. Private workers still require the original private reply identity and bound audience.

The terminal run transaction retains exact workspace obligations before detach. Reconciliation and version acknowledgement use the existing run generation, fence, physical binding and retained revision. Unknown private state remains protected. A successful obligation ACK is not permission to remove private files.

## Consequences

- One unit lifetime and the existing owners determine behavior; adapters report facts rather than inventing authority.
- Recovery survives bot restarts without local pull maps or a second lifecycle controller. Native Workflows and alarms remain transport and wake mechanisms.
- Seeded dependency behavior remains supported. Single-unit entry no longer pays for graph selection; complete DAG removal is not part of this decision.
- Unknown effects and required delivery may keep an owner reserved. Their absence from a public listing or a process is not proof they ended.
- Deployment requires matching readers/writers, owner-safe cutover, exact-head gates and live acceptance. Source contracts alone do not prove release, deployment or production recovery.
- Sandbox runtime replacement remains an adapter migration with its own execution, retention and image proofs. It adds no lifecycle authority.

## Alternatives

A global lifecycle resource duplicates existing ownership. A new PR lock table or cache requires another reconciliation protocol. A shadow composer and rollout epoch preserve two orchestration systems. Replaying uncertain writes from observed remote state risks duplicates. Clearing report or workspace obligations to unblock another action discards the original custody. Retiring seeded dependencies before preserving their behavior changes the supported product.

## Proofs

The living contracts and their exact source/producer/store proofs are [Ship](../reference/specs/agent-ship.md), [run history](../reference/specs/run-history.md), [orchestration plane](../reference/specs/orchestration-plane.md), [delegated outcomes](../reference/specs/delegated-outcomes.md) and [review publication](../reference/specs/agent-review.md). Their deployed procedures remain separate from unit and Durable Object tests. This record's proposed status is not a final review or rollout receipt.
