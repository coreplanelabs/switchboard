---
title: An outside fact finds the thread that owns the work and lands as its owner's turn
status: proposed
date: 2026-09-17
pattern: Signed outside events become durable evidence for the owning pull request and unit; the owner decides under its existing authority
---

# An outside fact finds the thread that owns the work and lands as its owner's turn

**Post-MVP plan, updated 2026-10-01.** This proposed record is the canonical plan for GitHub feedback after a pull request opens. Bot authors are the primary use case: a configured review bot's comment, CodeQL or GitHub Advanced Security alert, or another bot's review should reach the same review and coding loop as Switchboard's own findings. Human reviews and comments use the same path. No separate outside-feedback implementation plan is needed. This work follows the MVP; it is not an MVP gate.

## Outcome

For an owned, open pull request, an eligible outside fact is filed once, tied to its source and head, and presented to the unit's review agent. The review agent assesses it with the diff and existing findings. An actionable point enters the same findings ledger and coding round as an internal review finding. The coding agent fixes it or records a reasoned decline; a later review checks that disposition. A human reply such as “ignore F1 and F3 because XYZ” is a claim to validate in that round, not an automatic waiver. The PR remains owned through merge-ready so a later comment can resume the same unit. No sandbox or model run needs to stay resident while waiting for events.

Success means:

1. A configured bot's PR comment or review, and an eligible CodeQL/security alert, reaches the owning unit without a mention or a person relaying it. Human reviews and comments can do the same. A source can be disabled per repository.
2. Each fact has stable provenance: repository, PR, source kind and ID, author or app, URL, received time, relevant head, and its relation to a finding or disposition. Duplicate or unordered deliveries do not start duplicate work.
3. The review agent evaluates outside claims, including human requests to set aside its own finding IDs; the coding agent records `fixed` or `declined` with a reason, and re-review verifies the result. A bot or commenter cannot approve, waive a guard, grant authority, or merge by writing text.
4. The original unit, thread, requester, branch, PR, caps and grants remain the authority. A new event queues behind the active writer or reviewer and resumes at a safe unit boundary. After merge or close it is recorded without reopening the PR.
5. Restarts and sandbox teardown lose neither a filed fact nor its owner. Missed webhook deliveries are detectable and recoverable. The existing `check_run` wake and merge guards keep working.

## What is built now

| Seam | Current behavior | Work left |
| --- | --- | --- |
| Signed GitHub webhook | `src/channels/githubWebhook.ts` routes `check_run`, `push`, and `issue_comment`; `check_run` wakes a waiting check step and the unit re-reads GitHub. | Add review, inline comment, security alert and PR lifecycle readers behind a shared durable intake. |
| PR comment to unit | `handleIssueCommentIntake` accepts a comment from the exact requester identity on a live runner-owned PR, appends a durable unit event, and nudges the unit. It ignores bots and other humans. | Expand eligible sources and retain ownership through merge-ready and process endings. Do not replace this with an unbound chat turn. |
| Durable unit inbox | `CoordinatorInstanceStore.appendEvent` gives a unit event a stable ID; a wake can re-read it. | Connect source facts, reviewer triage and consumed status to this inbox across unit generations. |
| PR lookup | Run history already has a `(repo, pr_number)` index. | Add a durable, authoritative `(repo, PR)` → unit/thread/requester binding through merge or close, with exact repo and head checks; history alone expires and does not establish current ownership. |
| Findings | `src/core/findingsLedger.ts` joins Switchboard review verdicts and coding dispositions by finding ID. | Add outside source sightings and reviewer validation without turning a raw comment into a finding or erasing a declined finding. |
| Delivery | No general `X-GitHub-Delivery` ledger or catch-up path exists. | Add transport dedupe, logical fact dedupe, retry state and reconciliation for missing deliveries. |

The earlier snapshot at `cece6a73` is historical: it predated the current `issue_comment` path, unit event inbox and run-history PR index. The existing check wake is a latency path, not the general feedback mechanism. Record [0073](0073-the-ship-pipeline-dissolves-into-the-orchestrator-the-unit-machine-is-the-deterministic-atom-and-judgement-composes-units.md) makes the deterministic unit the lasting owner; this plan targets that unit seam rather than the plan runner's graph.

## Design

### Receive and identify

Verify GitHub's signature, store a minimal receipt keyed by `X-GitHub-Delivery`, then acknowledge promptly. An asynchronous reader normalizes `issue_comment`, `pull_request_review`, `pull_request_review_comment`, `code_scanning_alert`, and relevant `pull_request` events into source facts. Keep the existing `check_run` and `push` paths, routing them through common receipt accounting only where doing so preserves their current behavior. A review and its inline comments are one logical review: fetch the review and comments from GitHub after the event so delivery order does not decide content. Read current alert state and PR head from GitHub before acting. Link a check failure and its CodeQL alert when they name the same underlying alert; do not infer identity from similar text alone.

The repo's configured source policy decides which facts may request a round. Bot authors are first-class sources: match a stable GitHub account or App identity and repository policy, not a `[bot]` string or mention. The repository can allow specific bot authors and security alert sources. For a human, verify the account and current repository permission; a trusted collaborator's review or comment may request a round, while other comments can be retained as notes. Each source kind has a per-repository `turn`, `note`, or `off` mode: `turn` requests bounded review, `note` records evidence without starting work, and `off` ignores it. Approval alone is a note; a change request or actionable comment is eligible for a turn. The policy is admission to consideration, never permission for the sender to direct tools. The original requester's grant remains the only run authority, subject to current authorization and the Git door in [record 0048](0048-the-git-door-a-cold-runs-only-github-credential-is-its-run-bearer.md).

### File and resume

Resolve ownership from a durable PR binding written when the unit opens or adopts the PR. It names one unit identity, requester, thread, repository and branch, survives a bot restart, and remains until the PR merges or closes. If a chat coding run opens a PR outside Ship, the same binding can name its thread and agent; it must be published by the run's post-step rather than inferred from a recent history row. A fact for an unowned PR is visible as unowned and starts no run. A stale head remains evidence but cannot be treated as a finding on the current head without review. The unit event inbox stores the normalized fact by logical source ID and append sequence. Filing retries after the receipt is acknowledged; a wake is repeatable and causes the unit to re-read pending facts. This is the same unit even if its previous pipeline process or sandbox has ended.

The active unit has one writer. If coding or review is live, file the fact and schedule it at the next safe boundary; do not spawn a rival coding session or interrupt a person's turn. If idle, wake the unit through its durable owner. A review comment arriving at merge-ready withdraws that standing until the fact is triaged and the head, checks and approval are read again. The deterministic unit still owns review, fix, checks and merge guards; the orchestrator in record 0073 decides the next bounded act from the unit's returned facts. A bot event can consume only the existing unit's allowed budget. When no budget remains, park the fact visibly for the owner instead of silently minting another round.

### Review and disposition

The reviewer receives a bounded bundle of new outside facts, their links and source metadata, the current diff and the existing ledger. It classifies each as actionable finding, already covered by a finding, informational, stale, or incorrect, with a reason. Actionable findings get stable IDs and source links in the ledger. A human's “ignore F1 and F3” message is attached to those IDs; the reviewer or coding agent tests the claim against the code and spec, then the coding agent records a `fixed` or `declined` disposition with its reason. A decline remains reviewable; the author of a comment does not set the ledger status. Re-review confirms the head and verifies each claimed resolution or re-raises the finding.

All outside bodies are quoted as untrusted content. A bot may report a security problem and supply a proposed patch, but its words are evidence for the review agent, not commands to the coding agent. CodeQL status or a check conclusion can block the merge door independently of this triage; triage adds the explanation and possible fix to the review loop.

### Deliver and reconcile

Keep a durable receipt for each delivery and a separate logical fact key, such as review ID, comment ID or alert ID plus its update version. States distinguish received, filed, consumed, ignored, unowned and retryable failure. A redelivery may repeat a wake but cannot append or consume the same fact twice. If receipt storage fails, return an error so GitHub records a failed delivery. If a later GitHub read or filing fails, retain the receipt and retry it without depending on GitHub redelivery. Retry a filed but unconsumed fact after a crash or busy boundary. A bounded background reconciliation of owned open PRs compares GitHub reviews, comments and alerts with filed source IDs; it catches deliveries that never reached this service. This runs in the control plane and does not keep a sandbox warm.

Expose pending, failed and unowned receipts with source links and owner identity. Retain enough source IDs after a PR closes to reject late duplicates. Do not rely on webhook ordering, process memory, GitHub automatic retry or a continuously running model session for correctness.

## Implementation cuts

Each cut updates the covering living spec and exact tests in the same PR. Keep each PR reviewable; these are sequence boundaries, not a second executable plan graph.

1. **Durable receipt and owner binding.** Add delivery and logical-fact keys, an owner binding for open/adopted PRs, crash-safe append/wake, close/merge cleanup, and read-only receipt visibility. Prove duplicate delivery, restart, stale owner and exact repo/PR binding. Preserve the existing check wake.
2. **Bot-first end-to-end path.** Read bot PR comments, reviews and CodeQL/security alerts, fetch canonical GitHub state, apply repository source policy, and feed a bounded bundle to the reviewer. Prove a real bot source can become a finding and coding disposition without a mention. Handle unordered inline review deliveries and related check/alert facts.
3. **Human answers and unit continuation.** Admit trusted human reviews/comments, attach replies to finding IDs, validate “ignore F1/F3” claims, and resume the same unit from active, idle and merge-ready states under its remaining caps. Prove one writer, a changed head forcing re-review, and no automatic waiver.
4. **Recovery and operational proof.** Reconcile missing deliveries, expose retryable/unowned facts, measure duplicate and stale-head rates, and exercise natural bot and human events on an owned PR. Confirm bot restarts and sandbox teardown do not affect delivery. Enable the required GitHub webhook subscriptions and permissions as an explicit rollout step.

## Boundaries and open choices

- This is post-MVP. The current requester-only comment path and check wake remain the shipped baseline until these cuts land. This record does not claim external bot feedback works now.
- The GitHub event is a prompt to read authoritative repository facts. Neither a webhook payload nor a commenter supplies the unit owner, head, grant, finding disposition or merge approval.
- `pull_request_review_comment` is folded into its review when it has one; standalone inline comments need an explicit source key and triage rule in the reader. Comments arriving after merge are recorded without restarting coding.
- Choose the default human eligibility and bot source policy per repository during cut two, then document it in `config/config.example.yaml`. The safety invariant is stable identity plus bounded, owner-authorized work; it does not require every possible bot to be preloaded globally.
- Check whether a review arriving mid-round is best queued for the next boundary or steered into the current coding turn. Default to queue until evidence shows steering improves the fix without voiding review work.
- A low-rate catch-up read is a recovery path, not the primary trigger. Its frequency, rate budget and retention should be set from observed delivery gaps before rollout.
