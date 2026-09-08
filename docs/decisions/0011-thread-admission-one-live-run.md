---
title: One live run per thread; a follow-up steers the run or is refused, never queued as a second run
status: implemented
date: 2026-09-08
pattern: Admission control
---

# One live run per thread; a follow-up steers the run or is refused, never queued as a second run

## Context

The sandbox and the resident worktree are keyed by thread. When two coding runs started in one Slack thread they shared a checkout: the second run's `git checkout -b` switched the first run's branch underneath it, and the first run's PR post named a branch it had never pushed. The follow-up that started the second run was not a new request at all; it was a nudge meant for the run already in flight.

## Decision

A thread admits one live run. The claim is taken right after the agent permission gate and before the setup card, repository resolution or any executor attach, so no window exists in which two runs can attach the same per-thread workspace.

A follow-up that arrives while a run is live is steered: it is folded into the live run's inbox and read at the run's next step boundary. The live run is never interrupted or restarted for it. Exactly one case is refused instead: a follow-up that names a different agent than the one running (`agent:review` in a live coding thread is a new request, not a nudge). No agent ever answers a follow-up with "wait for it to finish."

When the run releases the thread, any inputs it did not consume are handed back and the dispatcher runs them as a fresh turn, so nothing is dropped.

Everything in `threadAdmission.ts` is synchronous, pure state and platform-blind; nothing there starts a run. With the durable ledger ([0019](0019-durable-run-ledger-resume-after-kill.md)) the claim became a `thread_key UNIQUE` constraint on the live-runs table, so admission holds across container generations.

## Consequences

- Shared per-thread workspaces are safe by construction.
- A follow-up reaches the run mid-flight rather than after it, which is what a person nudging a working agent expects.
- There is deliberately no per-agent follow-up policy to configure.
- A run that ignores its inbox for a long step delays the steer until the step ends. That is bounded by the step budget, not by the run.

## Alternatives rejected

- **A second, independent run.** The previous behavior and the incident that motivated this record.
- **Interrupting or restarting the live run on a follow-up.** Throws away work the user asked for to react to a nudge.
- **Queueing the follow-up until the run finishes.** Answers "wait" to a person who wanted to steer.

## Pattern

Admission control on a per-thread key. The inbox is a mailbox read at step boundaries.
