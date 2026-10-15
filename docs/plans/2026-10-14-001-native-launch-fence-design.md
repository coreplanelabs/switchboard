---
title: Hard stop requires a native launch gate and descendant containment
type: design
date: 2026-10-14
status: proposed
surveyed_at: 5930d518c2fb926271097974ba0b53f4a8f85d4f
---

# Hard stop requires a native launch gate and descendant containment

The Resident execution maintainer should qualify kernel-owned per-run containment before replacing owned SDK launches. This proposal is for an engineer new to this code and must be settled before production wiring.

## The decision

A durable native gate prevents delayed launches from starting after cancellation. It cannot stop a child that already escaped its launch process group. Reliable surgical shutdown needs both that gate and a kernel-owned containment unit for every descendant, including privileged setup and publication. Prefer a delegated cgroup v2 subtree when the deployed runtime supports one; otherwise retain the current refusal and qualify a per-run PID namespace or a separate execution runtime. This proposal does not treat the local Docker capability result as a deployed Cloudflare result.

## Today at the surveyed commit

| Fact the design depends on | Evidence |
| --- | --- |
| Owned ordinary commands record native admission before SDK submission; a lost submission reply can leave no process identity. | `deploy/cloudflare-resident/worker.ts`, `run` and `beginThreadNativeOperation` |
| Credential inspection also submits directly through the SDK; owned file writes use the SDK filesystem route. These three paths all need the same gate. | `worker.ts`, `inspectThreadCredentials` and `writeOwnedFile` |
| Privileged publication executes under the original native scope, but a thread UID is not the identity of its root process. | `worker.ts`, `publishThread` and `withOwnedNativeOperation` |
| Cancellation checks original ownership and kernel identity and preserves unresolved native submissions. It cannot certify their confinement. | `worker.ts`, `cancelRun` and `observeRetiredThreadRuntime`; [native recovery record](../decisions/0101-native-operation-recovery-requires-the-original-process-receipt.md) |
| Native execution does not wake a stopped container and supports standard input. Its process signal does not terminate descendants. The Resident template omits scheduling_policy, which selects default; the durable_object policy capability warning is not a current-deployment claim. | `deploy/cloudflare-resident/wrangler.template.jsonc`; [Cloudflare native execution contract](https://developers.cloudflare.com/containers/api/durable-object-container/#exec) and [scheduling policy](https://developers.cloudflare.com/containers/configuration/scheduling-policy/) |

**Author-observed local reproduction, not CI or live proof:** the bounded local fixture used the cached Sandbox image `0.13.0-next.751.1`, without network, host mounts or additional privileges. A locked gate denied a deliberately delayed launch after closure. A second fixture killed the launch process group and observed its detached root child still alive. The same local runtime exposed a read-only cgroup filesystem and refused nested user/PID namespace creation. These observations establish a rejected local shortcut, not production capability or kill acceptance.

## The shape

Use the service-manager pattern: the controller stays outside the workload's kernel containment unit. Unlike a conventional job, the original DO can restart and an SDK request can arrive after its caller lost the reply. The immutable gate therefore binds run, thread, generation, fence, kernel and a random gate identity. Native state lives outside restored workspace trees; the DO journal retains the same identity before submission. The DO first persists a caller-known creation reservation after existing custody checks, including a random gate ID and expected kernel, before sending bootstrap. Native bootstrap can initialize only that reserved gate. A launch wrapper can validate it but never create or reopen it.

```mermaid
sequenceDiagram
    participant D as Original DO owner
    participant G as Native gate controller
    participant K as Per-run kernel containment
    participant W as Delayed wrapper
    D->>D: Persist creation reservation and caller-known gate ID
    D->>G: Bootstrap reserved immutable owner/kernel gate
    D->>D: Persist attempt and gate identity before submission
    D->>W: Submit wrapper once
    D->>G: Close original gate under native admission lock
    G->>G: Persist closed state; release short lock
    G->>K: Kill confined processes and descendants
    W->>G: Validate gate and try admission under same lock
    G-->>W: Closed; refuse before payload
    K-->>G: Independent empty-state observation
    G-->>D: Exact closed-gate and quiescence receipt
    D->>D: Compare original ticket and owner; finish cancellation
```

## Where the difficulty is

1. **Contain every launcher before execution.** This is the hardest correctness question; a process group or file permission is insufficient for privileged escaping children.
2. **Serialize close and spawn without waiting for the payload.** A hung command must not hold the admission lock needed by Kill.
3. **Preserve identity across reset and bootstrap.** Workspace restore must not reopen a closed gate or substitute a successor.

### Containment is required before production wiring

A delegated cgroup can retain children after `setsid`, double fork or UID changes. The kernel's [cgroup v2 contract](https://docs.kernel.org/admin-guide/cgroup-v2.html#core-interface-files) defines `cgroup.kill` over the complete subtree, including concurrent forks, and `cgroup.events` reports whether it remains populated. Payloads must have no authority to migrate out, replace the controller's gate, or move unrelated work into that subtree. Checking that the directory is writable does not establish those conditions. Cloudflare explicitly states that the durable_object scheduling policy gives native exec processes root-equivalent capabilities regardless of their user IDs. Passing a user option or setting root-owned file modes therefore cannot establish the privilege boundary on that policy. Qualification must identify an enforced capability/mount boundary or a separate per-run runtime, not infer one from a pool UID.

The alternative is a per-run PID namespace with a supervisor whose death ends all processes in that namespace, or a provider-owned per-run container that can be destroyed independently. Both need a qualified capability and original identity. A shared resident destroy would affect unrelated work and does not meet this proposal's scope. The fixed launcher's root controls must remain inaccessible to every payload, including root publication; a cgroup without an enforceable privilege and migration boundary is also insufficient. Adding host privileges, mounting the host cgroup tree or changing security profiles in a local fixture would not prove Cloudflare support.

Ordinary commands, credential inspection, owned writes and privileged publication must all join containment before the first payload instruction. For writes, stream private content through native standard input and keep the existing 524,288-character limit; argv, environment and SDK logs must not carry file content. A successful process kill cannot settle an uncertain remote publication or file-write result.

### Close and admission share one native critical section

The launcher starts with a controller-owned executable, loader path, environment and working directory. Caller PATH, loader variables such as LD_PRELOAD/LD_AUDIT, interpreter startup variables and credential environment are payload inputs; they are applied only after admission. The launcher reads the payload through native standard input. This prevents caller-controlled constructor or startup code from executing before the gate.

For the cgroup candidate, the fixed launcher itself takes the lock and joins the original per-run subtree before it can execute a payload. It writes its own PID and process start identity, durably commits that admission, releases the lock, and replaces itself with the payload using exec. There is no payload child created between these steps: a crash before exec ends the launcher without executing user code. A crash after admission leaves a process in the killable subtree. Closing takes the same lock, durably commits closed state, and rejects future wrappers; the lock never spans the payload or output collection. A separate supervisor/handshake implementation for a PID namespace is not specified or admitted by this proposal.

If joining containment or persistence fails, the launcher refuses before exec. The launcher must not fork a payload before admission; the first payload fork occurs only after containment and registration. A close reply lost after commit is observed through the same original gate and cancellation ticket; it does not authorize another command submission. Kernel replacement refuses an old wrapper before effects. A cold attach can reserve a gate only when its original run/generation/fence matches the existing run high-water mark and allocated pool UID. The reservation transaction rechecks that original cancellation and the thread cancellation control are absent. Bootstrap validates the expected native kernel and that reserved tuple; it cannot allocate a UID, choose a new owner, rewrite the workspace binding or advance a generation. These are the required custody-transition proofs, and their cold-start implementation remains unqualified. Gate creation is an outstanding native operation: cancellation enumerates the durable reservation even when bootstrap has not returned. Closing an absent reserved gate writes an irreversible tombstone under its exact native lock. A delayed bootstrap sees that tombstone and refuses instead of creating an open gate. Bootstrap failure or a lost reply leaves its reservation held until an exact observation; it is never an excuse to generate another gate ID.

### Keep past uncertainty separate from physical quiescence

The closing receipt binds the original owner, ticket, gate, kernel and independent empty-state observation. The final DO transaction rechecks those facts and the complete journal inventory. It can prove the run has no remaining execution authority while retaining unknown past effects. It preserves any verdict already saved by the original owner as evidence. Cancellation cannot create a new verdict or publication receipt, replay a publication, purge native controls or rewrite a successor's ownership.

Legacy SDK admissions have no gate identity. Installing this design cannot retroactively prove they were confined. Their shutdown requires separately supported original-runtime evidence; otherwise they remain unconfirmed. Existing backups, workspace registration, history and UID spend evidence remain retained.

## Qualification before adoption

| Question | Owner and resolver |
| --- | --- |
| Does the deployed runtime expose delegated cgroup kill and prevent workload migration, or support a per-run PID namespace? | The original deployment controller supplies supported runtime capability evidence. Local capability failure is not substituted for this receipt. |
| Can every privileged launcher use containment without changing credential or Git-door authority? | The existing Resident source writer proves the command, credential, write and publication paths through their current seams. |
| What bound does native closure meet under a hung payload? | The source writer uses the current 2,000 ms native-control bound in `worker.ts` (`FORCE_DETACH_KILL_TIMEOUT_MS`) as the qualification target. A control or quiescence timeout returns unconfirmed; it cannot be a successful terminal receipt. Measure end-to-end latency separately before promising a terminal-time bound. |

Adoption requires actual Linux proofs for both close/spawn orders, lost submission and control replies, wrapper crash before and after registration, DO restart, wrong kernel, UID reuse and foreign successor, detached/root descendants, concurrent fork, private maximum-size writes, malformed or missing gates, close-before-bootstrap and lost bootstrap replies, payload preload/constructor attempts before admission, and an unaffected independent run. The author-observed local fixture demonstrates the delayed-launch denial and process-group escape; it does not validate a production helper. Complete positive containment, production wiring and live terminal receipts remain gaps.

Update the existing execution, Resident, cancellation and hosted-stop spec rows in the implementation PR. Keep source checks, review, merge, containing deployment and live hard-stop receipts separate. This proposal changes no runtime code or live authority.

## Proof labels

| Claim | Evidence and limit |
| --- | --- |
| Managed stop preserves both possible outcomes of an unconfirmed review state write. | `src/core/runsService.test.ts::RunsService.stopRun::hard stop preserves deferred review checkpoint outcomes without posting: committed=%s`. This exercises the service and InMemory ledger with an injected runtime acknowledgment and the complete committed checkpoint payload, including its saved verdict. Cancellation retains that verdict as evidence and supplies no publication receipt; this does not replay the review model or prove physical shutdown. |
| Gate closure blocks delayed launch and reserved bootstrap; a process group and caller-controlled startup environment are insufficient. | Author-observed isolated Linux reproductions. Private fixture receipts retain the exact image ID, commands and results. These are neither checked-in helper tests nor production capability receipts. |
| The proposed design accounts for creation and payload-startup races. | Two independent cold-reader rounds and an adversarial source review identified those gaps; this proposal now reserves creation before submission and separates trusted startup from payload inputs. This is design review, not current-head Switchboard approval. |
| Complete native containment and live surgical shutdown work. | Open. No launch helper is wired by this proposal, and no positive production capability or live terminal receipt is supplied. |


## Amendment: native cgroup implementation, 2026-10-14

The implementation uses a controller outside each run's cgroup v2 subtree. It reserves the gate in DO storage, closes admission through the kernel freeze flag, uses `cgroup.kill`, and verifies an empty subtree. The gate remains closed on disk and in storage. A late wrapper validates its original kernel before it can run. A lost close reply is observed under the same gate; an open or absent gate resumes the same monotonic close. Incomplete bootstrap is never treated as ready.

Ordinary payloads drop all capabilities. Privileged payloads receive a private mount/PID view and only the capabilities needed for ownership and UID changes. The host account and loader files stay read-only. Fixed account provisioning and UID inventory run in the controller lane without caller commands or environment. Per-run network hooks deny the image's SDK control port. Private write content stays on standard input. The helper preserves the image's test and build limits.

Shared VM restore, Git setup, dependency producers, cache adoption and background backups keep independent maintenance ownership. They serve multiple worktrees and must not inherit one consumer's kill scope. Thread commands, writes, credential diagnostics, dependency views and publication use the run gate. This preserves the existing shared-resident architecture.

A disposable Cloudflare Sandbox fixture qualified the kernel gate, cgroup kill, capability/mount restrictions, control-port exclusion and delayed admission. A separate local Linux test exercises the actual production helper, including its privileged profile. Neither result establishes the exact deployed Resident image/policy, product UI closure, or migration of historical unknown SDK work. Those remain acceptance prerequisites. New scopes cannot retrospectively contain old submissions; the old native recovery path remains explicit.


### Amendment: execution birth and rolling deployment, 2026-10-14

A lazy gate cannot cover old detached SDK work. First canonical execution admission therefore freezes the run's protocol in the existing durability archive. New plane placeholders bind their first execution client before attachment; old placeholders remain legacy. A native client declares its protocol at claim/reclaim. A client that lacks that declaration cannot take a native run's lease, even if it copied its metadata. Resident requests use a versioned namespace so old receivers refuse before effects.

Attachment reads that original canonical contract, commits the local protocol and native reservation, then begins hydration and execution. A reset preserves that decision. Legacy work never gains a gate from an empty journal or missing workspace. Native commands use the reservation before VM start, so hard stop can close an unstarted run without waiting for startup. Legacy execution retains user demotion and the existing native recovery path.

The payload environment is applied after the capability and UID transition, through an isolated Python stage with stdin data. The privileged loader receives a fixed clean environment. Closure observation takes the same admission lock as launch so it cannot ignore a delayed controller before cgroup membership.

### Rollout dependency amendment

The first implementation required a joint deploy in prose but left the old Bot-before-Resident plan intact. That order would send versioned routes to an old receiver. The runner now publishes the same prepared configuration after Memory and before either consumer, while it retains the original source version, hash and Bot application checks. Resident drains and proves its image ready before Bot uploads. A Bot-only or forced plan independently checks protocol support and a complete ready image registry before upload. Secret rotation remains a separate operation. This preserves the reason configuration preceded the execution workers in record 0015. The existing Bot SIGTERM handoff, Resident drain and live image gates remain in force. An unavailable dependency produces a known no-upload refusal.

The deployed image and kernel still require separate live qualification. A public protocol flag proves route support, not kernel privileges, process closure or remote publication outcome. Pre-migration work retains its original legacy execution contract and requires its existing recovery receipts.

### Retained consumer readiness amendment

Resident upload still requires the selected fenced window. The Resident step seals it as completed after image readiness. The following Bot step consumes that completed window under the same current source, attempt and image checks. This readback does not authorize another Resident upload. The full runner regression performs the seal response transition before observing Bot upload. Adjacent unsealed, wrong, incomplete, foreign, stale, expired and non-current image cases refuse before Bot changes.
