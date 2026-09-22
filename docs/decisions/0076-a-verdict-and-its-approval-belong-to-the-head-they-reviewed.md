---
title: A verdict and its approval belong to the head they reviewed
status: proposed
date: 2026-09-22
pattern: Head-bound review subscription — a posted verdict creates one durable watch on the pull request; a substantive head move invalidates the verdict and approval, emits one idempotent update per surface, and renews both through a review pinned to the new head
---

# A verdict and its approval belong to the head they reviewed

**The ask.** Decide whether Switchboard, rather than repository branch protection, owns the re-review when the head of a pull request it reviewed changes after the verdict was posted. This applies to a review requested directly and to a review inside a ship unit. Written for an engineer who knows the review post-step, the ship machine, the GitHub App webhook intake and the repository settings surface. Success criteria:

1. A verdict posted to a pull request creates one durable subscription for that repository and pull request, carrying the reviewed head, the originating review thread, the run and the verdict. Reviews requested directly gain this subscription; a ship unit reuses its existing pull-request ownership rather than creating a second watcher.
2. With `review.rereviewOnPush: on` — the per-repository default — a substantive head change after a verdict creates exactly one replacement review run for the new head. Redelivery or two near-simultaneous webhook deliveries create no second run.
3. The claimed move posts exactly one first update in the originating review thread and one pull-request comment: “the head moved from `<old>` to `<new>`, re-running the review — `<run link>`”. When the replacement run ends, exactly one second update on each surface states its verdict at `<new>`.
4. The old verdict and its auto-approval cease to be current as soon as a changed patch is observed. Only `LGTM` at the new head re-mints the auto-approval, pinned to that head; changes requested never do.
5. A rebase-only move whose patch is unchanged keeps the verdict and approval under [record 0071](0071-a-ship-unit-owns-its-pull-request-until-it-is-merged-merge-ready-waits-on-facts-and-a-dirty-head-buys-a-rebase-round.md)'s rule. The subscription advances to the new head through the same unchanged-patch proof, without a model re-review.
6. `review.rereviewOnPush: on | off` is stored at repository scope, defaults to `on`, appears in the repository settings page and is writable through `config set repo`. `off` disables the automatic replacement run and says so on the repository surface; it does not make a stale verdict current.
7. An optional GitHub check run named **Switchboard verdict at head** is green only when the latest verdict is `LGTM` at the current head. Repositories may require it as an extra merge gate; the bot-owned subscription and re-review do not depend on it being required.

## TL;DR

A review verdict is a statement about one commit, but after the review run ends Switchboard stops watching a directly requested review. Issue #2145 records the result: on 2026-09-21 one pull request merged over an unresolved blocker, and three more merged after commits were pushed on top of an `LGTM`; the auto-approval still counted even though it named the earlier head. The in-flight reviewed-head guard prevents a review from first landing stale, but nothing renews a verdict that was current when posted and became stale later.

The bet is that the bot owns that renewal. Every posted pull-request verdict leaves one durable subscription. A changed patch invalidates the verdict and bot-produced approval, emits one old-head → new-head update in the originating thread and on the pull request, starts one review at the new head, then emits the new verdict and re-mints approval only for a new-head `LGTM`. An unchanged rebase carries the decision under record 0071. Repository branch protection may additionally require the **Switchboard verdict at head** check, but it is a belt over the bot's event-driven re-review, not the mechanism that starts it.

## Today at `9f6516d0`

| Fact at `9f6516d0` | Consequence |
| --- | --- |
| `src/core/dispatch/runLoop.ts`, `src/core/reviewedHead.ts` and `src/core/headMoved.ts` settle a review against `reviewedHead`. If the pull request moves while that run is live, a substantive move gets a second turn at the new head; an unchanged rebase carries the review. | The dangerous in-flight race is guarded. The guard ends with the run and subscribes to no later `pull_request.synchronize` event. |
| A posted review records the pull request, verdict and reviewed head in the run. Directly requested reviews have an originating channel thread; ship reviews additionally have a durable unit and pull-request row. | The facts needed to create a watch exist. What is new is the durable `(repository, pull request) → current verdict, head, thread` subscription for reviews requested outside a ship unit, and one ownership rule across both paths. |
| `.github/workflows/auto-approve-review-lgtm.yml` accepts only the configured App's deterministic `LGTM:` review, checks that its `commit_id` equals the event's current head, and posts the approval with that `commit_id`. | It refuses an approval when the head moved before the workflow ran. After an approval succeeds, however, a later push can leave GitHub counting that approval unless another mechanism dismisses or supersedes it. The approval needs the same head lifecycle as the verdict. |
| `src/channels/githubWebhook.ts` already verifies App deliveries and routes check-run, issue-comment and base-push events. `pulls.watch` and the merge-ready book already demonstrate a repository-scoped event subscription. | The App intake and a watch pattern exist. What is new is intake for reviewed pull requests' `pull_request.synchronize` events, not another poller or Action in every repository. |
| The repository settings surface and `config set repo` exist, but repository-scoped runtime configuration currently carries the `pulls` block alone. | `review.rereviewOnPush` is a new repository-scoped setting and settings-page control. Its default is deliberately `on`, unlike the more expensive merge watch: a posted verdict has already established intent to review this pull request. |
| Issue #2145's fixture has four merges from 2026-09-21: pull request 3539 merged over an unresolved blocker; 3535, 3541 and 3551 merged after commits landed on top of an `LGTM`, while the auto-approval remained attached to the earlier head. | Advice at one commit was consumed as authority at another. The fixture is the acceptance case: none of those four merge states may show a current green Switchboard verdict, and each changed-patch push must buy one re-review without a person re-requesting it. |

## The shape

### One subscription per reviewed pull request

A successfully posted verdict upserts a durable review subscription keyed by repository installation and pull-request number. The row carries the current reviewed head, verdict, verdict run, originating review thread, latest observed head and the setting snapshot needed to explain its next action. The run record remains the audit source; the subscription is the event index that finds it without scanning history.

There is one active owner, not one per historical request. The most recent successfully posted verdict becomes current and its originating thread becomes the update thread. A later explicit review in another thread supersedes that owner when its verdict posts. A ship unit stores the same subscription identity beside its existing unit ownership, so a synchronize event cannot wake both a generic requested-review watcher and the ship machine.

A review that opted out of posting to GitHub creates no repository subscription: it made no repository verdict to keep current. A closed or merged pull request seals the subscription. Turning the setting off prevents new automatic runs but retains the row and its stale/current fact for audit and for the optional check.

### A head move is one claimed transition

The signed App webhook intake admits `pull_request.synchronize`, resolves the repository setting, refreshes the pull request and looks up its subscription. A substantive move from subscribed head `A` to current head `B` is claimed durably under `(repository, pull request, B)`. The claim creates or adopts one review run pinned to `B` and records its run link before either surface is updated. A redelivery sees the same claim and can finish missing publications, but cannot create another run.

The transition invalidates the current verdict and bot-produced approval before dispatch. The old review remains immutable audit evidence at `A`; it is no longer merge evidence for `B`. The auto-approval path dismisses or supersedes its own stale approval and records whether GitHub accepted that write. Failure to clear the GitHub artifact leaves the product state stale and the optional check red; it never silently treats the approval as current.

Before dispatch, the intake uses the existing compare/range-diff evidence to classify an unchanged rebase. If the patch is unchanged, record 0071's carry rule applies: advance the subscription from `A` to `B`, re-pin the carried verdict and approval to `B`, and publish one carry note per surface. No model run is spent and there is no interval in which an unchanged patch loses its approval. Unknown or incomplete comparison fails toward re-review, never toward carry.

### Two updates, each once

For a substantive move, the first publication is deterministic and includes the full old and new heads plus the replacement run link. It is posted once in the originating review thread and once as a pull-request comment. Both publications carry the transition id in their durable receipt (and an invisible marker where the remote surface needs reconciliation), so a timeout after GitHub or the channel accepted the write is read back rather than posted twice.

The replacement review runs through the ordinary review path at `B`: the same read-only agent, reviewed-head guard, typed verdict, severity gate and deterministic GitHub review body. Its end records one second publication per surface: `LGTM at B`, `Changes requested at B`, or a named no-verdict/refusal state. Only the first two are verdicts; only `LGTM at B` can re-mint the auto-approval. If the head moves again to `C`, the `B` run can finish for audit but cannot become current or approve `C`; the `C` transition is claimed once and becomes the subscription's next run.

### The setting lives with the repository

`review.rereviewOnPush: on | off` resolves at repository scope and defaults to `on`. The settings page shows the effective value on that repository, and `config set repo --repo <owner/name> --review.rereviewOnPush on|off` writes the same row. This is not a user, channel or thread preference: one pull request must not have two safety policies depending on who asked for its first review.

`off` means “do not spend a replacement review automatically.” It does not carry a changed-patch verdict, preserve its approval or turn the optional check green. The first update instead states that the head moved and automatic re-review is off, with the repository setting as the remedy; a later explicit review at the current head becomes the subscription's current verdict in the ordinary way.

### One optional check exposes the same fact

With the second rollout unit, the GitHub App writes a check run named **Switchboard verdict at head** on each observed pull-request head. Its conclusion is success only when the subscription's latest verdict is `LGTM` and its reviewed head equals the current head. A changed patch, changes requested, no verdict, a failed dispatch, an unknown current head or a head-move claim still in flight is non-green with the exact reason in the summary.

The check is a projection of subscription state, never a second verdict store. The App uses `checks:write`; no repository workflow or marketplace Action recreates the decision. A repository may make the check required through its repository policy, surfaced beside `review.rereviewOnPush` in settings and documented in setup. If it does not, the bot still posts updates and re-reviews; requiring the check only makes GitHub enforce what the product already reports.

## One hard-case trace: an `LGTM`, two pushes and webhook redelivery

1. A requested review of pull request 42 posts `LGTM` at head `A`. The run record and subscription both name `A`, its originating thread and the approving verdict. The auto-approve workflow creates an approval pinned to `A`; the optional check at `A` is green.
2. A contributor pushes a substantive commit, producing `B`. GitHub delivers `pull_request.synchronize` twice around a process restart. The first delivery claims `(repo, 42, B)`, invalidates the current verdict and approval, creates run `rB`, and records its link. The second delivery adopts that claim. Between them, exactly one thread update and one pull-request comment say that the head moved from `A` to `B` and link `rB`; the check at `B` is red with “verdict is at A; review rB is running”.
3. While `rB` is reviewing, another substantive push produces `C`. The `C` delivery claims a separate transition and creates `rC`. `rB` may finish and its verdict is retained at `B`, but compare-and-swap against the subscription refuses to make it current, mint approval or turn `C` green. Its second update says the `B` verdict is superseded by `C`; no further child is spawned from that late end.
4. `rC` requests changes at `C`. One second update per surface states that verdict, no approval is minted, and the check remains red with the blocker. A repeated finish event repairs a missing publication receipt but posts no duplicate.
5. The contributor fixes the blocker at `D`; one new transition creates one `rD`. It returns `LGTM at D`, posts one second update per surface, mints an approval pinned to `D` and turns only the `D` check green. GitHub can merge under the same verdict the reader sees.
6. Had `A → B` been an unchanged rebase instead, the compare proof would have advanced the subscription and re-pinned the carried verdict and approval to `B` with one carry note, no `rB` and no red interval. An unavailable or ambiguous proof would have taken the substantive path.

The invariant is: for the current head, there is at most one automatic review run, at most one update of each kind per surface, and no current approval without an `LGTM` that applies to the same patch and is pinned to that head.

## The difficulty map

1. **One owner across requested reviews and ship units** (most consequential). Today a ship unit knows its pull request, while a direct review ends with only a run record. The new index must let either path establish the same subscription without two synchronize handlers dispatching two reviews.
2. **Invalidating the auto-approval, not merely the verdict.** GitHub may continue counting an approval created by Actions after the branch advances. The product must withdraw or supersede its own approval and fail closed in its state and check when GitHub refuses, while never dismissing a person's review.
3. **Exactly-once effects over at-least-once webhooks.** Run creation, two channel posts, two pull-request comments/reviews and approval writes span stores and APIs. Durable transition ids and per-effect receipts are required; an in-memory dedupe map loses on the restart in the hard-case trace.
4. **The rebase-only exemption.** “Same patch” must be the existing executable range-diff/compare proof, not a commit-message guess. Unknown comparison spends a re-review. Carry must advance every head-bound projection together — subscription, review post, approval and optional check — or the exemption creates a split truth.
5. **A head that moves while its replacement review runs.** The late `B` verdict is valid audit evidence and may need its second update, but it cannot mutate the `C` subscription, approval or check. The current-head compare-and-swap is the fence.
6. **Finding the originating thread after restart.** A directly requested review needs a durable channel/thread address and request identity, not a process callback. A deleted or unavailable thread must not block the GitHub comment, review or check; each surface reconciles independently.
7. **Default-on cost without runaway fan-out.** The first posted verdict is the admission signal, so default on is justified. Coalescing successive pushes to the newest observed head and one active automatic review per pull request keeps a force-push sequence from filling the review queue with knowingly obsolete work.
8. **The optional check's authority.** A required check can block merging but cannot become a parallel source of truth. It must be regenerated from the current subscription and head every time, with stale or unavailable facts non-green and named.

## The hard parts

**A verdict is immutable; currency is mutable.** The review at `A` must remain exactly what was posted. The subscription says whether it is the latest verdict for the current head. Moving that pointer under a compare-and-swap preserves audit history while preventing a late run from rewriting current truth.

**The approval is an effect of the verdict, not an independent vote.** The Action exists to convert the App's deterministic `LGTM:` token into the repository's approval primitive. It cannot outlive the token's reviewed head. The implementation therefore records the approval's source review and commit, withdraws only approvals it created, and mints the next one only from the current subscription's `LGTM`.

**Webhook ownership needs a durable bridge to conversations.** Ship already has a unit row and thread. A directly requested review does not. The new subscription is deliberately small: it indexes the latest posted review by pull request and points back to its run and originating thread. It does not copy the transcript or invent a second review history.

**The update protocol is product behavior, not logging.** People need to see the gap open and close in the place they asked and on the pull request they may merge. The first update names old head, new head and live run; the second names the verdict and reviewed head. Hidden transition ids make those two human messages safe to retry.

**Branch protection is enforcement, not orchestration.** Requiring **Switchboard verdict at head** can stop a merge while a review is stale, and repositories that trust the bot deeply should enable it. It cannot start the review, preserve the thread, explain the run or renew the approval. Those remain the bot's work whether the check is required or merely visible.

## Why not X

**Why not require “Dismiss stale approvals” and call it done?** It closes one merge gate only in repositories that enable it. It starts no review, posts no update, preserves no original thread and leaves a person to notice and re-request. The issue's direction is that the bot that made the verdict owns renewing it; branch protection is an optional second layer.

**Why not rely only on the required status check?** A red check can prevent a merge but cannot produce the missing judgement. Without the subscription, every push stays red until a person manually asks again. The check is a projection and enforcement option, not the workflow.

**Why not put a GitHub Action in every repository?** The App already receives signed synchronize events and holds the run, thread, verdict and setting facts. A repository workflow would duplicate state, need another token and still have to call back into Switchboard to start the run. The only Action retained is the existing repository-owned conversion of a current `LGTM:` into approval until that effect moves behind the App.

**Why not poll reviewed pull requests?** Polling creates an arbitrary stale window, repeatedly reads unchanged pull requests and still needs durable deduplication after a restart. GitHub already sends the fact once and redelivers it until acknowledged; the intake needs a ledger, not a timer.

**Why not subscribe only ship units?** The three post-`LGTM` merges in the fixture did not become safe because the original review was requested outside a pipeline. A verdict has the same head semantics regardless of how the review began. Two policies would make the least structured request the least safe one.

**Why not re-review unchanged rebases too?** Record 0071 already decided that an empty range-diff carries approval: the reviewed patch did not change. Spending a model run would add latency and cost without new evidence. The safe fallback remains re-review whenever unchanged-patch proof is unavailable.

**Why not keep the old approval visible until the replacement verdict arrives?** That is the failure. During the gap, GitHub can merge `B` using a decision made at `A`. A changed patch opens a red interval immediately; only the new-head `LGTM` closes it.

## Relations and boundaries

[Record 0071](0071-a-ship-unit-owns-its-pull-request-until-it-is-merged-merge-ready-waits-on-facts-and-a-dirty-head-buys-a-rebase-round.md) supplies the unchanged-patch carry rule and the pull-request watch precedent. This record applies that rule to a verdict after it has posted and adds the changed-patch renewal. [Record 0055](0055-a-unit-has-one-thread-and-a-round-reads-the-checks-at-its-head.md) keeps ship's review round tied to one unit thread; this record does not create a sibling thread for the webhook run. [Record 0047](0047-an-outside-fact-finds-the-thread-that-owns-the-work.md) supplies the signed-webhook-to-owner pattern and durable deduplication requirement. [Record 0041](0041-the-settings-page-is-a-surface-over-the-registry-and-configures-the-shared-tiers.md) keeps the settings page and `config set` over one config store; `review.rereviewOnPush` is another repository-scoped field in that system.

Preserved: the reviewed-head guard before and during a review; the typed verdict and severity gate; the read-only review identity; the App-authored COMMENT review; the ship machine's review/fix/check transitions; a person's merge authority; and the auto-approve workflow's App identity checks. A webhook cannot waive authorization, post `LGTM` itself, turn a no-verdict run into approval or merge a pull request.

New: the durable subscription for a directly requested review; one subscription owner shared with ship; the two update messages; the default-on repository setting; the approval's lifecycle tied to the subscribed head; and the optional check projection. Not decided here: autonomous merge, re-review after base-branch movement that does not move the pull-request head, a general notification framework, or a broader merge-readiness check covering facts beyond the head-bound verdict.

## Rollout sketch

This is a two-unit sketch, not permission to implement before this proposal is accepted.

- **Unit one — re-review on push, update messages and setting.** Add the durable review subscription and claim ledger; subscribe direct reviews when their verdict posts and connect ship's existing pull-request ownership to the same identity; admit `pull_request.synchronize`; classify unchanged rebases through record 0071's proof; invalidate changed-patch verdicts and bot-produced approvals; create one new-head review run; post the first and second updates once per surface; add `review.rereviewOnPush` at repository scope, default on, to settings and `config set repo`. Fixture tests replay all four issue #2145 merges, webhook redelivery, a second push during re-review, an off repository and an unchanged rebase.
- **Unit two — optional required check and docs.** With `checks:write`, project the subscription into **Switchboard verdict at head** at every observed head; success only for current-head `LGTM`, every other state non-green with its reason. Surface repository opt-in to requiring it and document the GitHub policy setup, permissions, rollback and its relationship to the always-running subscription.

Unit one can roll back by turning the repository setting off while preserving subscriptions and audit rows; no stale verdict becomes current. Unit two can roll back by ceasing to require the check before ceasing to publish it. Neither rollback reattaches an old approval to a changed patch.

## Cold-reader and acceptance gates

Before acceptance, give a fresh reader only this record and ask for four things: restate the bet; explain why branch protection is optional rather than the owner; trace `A → B → C` through verdict, approval, messages and runs; and name the rebase-only exception. The gate passes only if the answer says that a changed patch immediately invalidates both verdict and bot-produced approval, one durable claim creates one new-head run and two once-per-surface updates, only a current-head `LGTM` restores approval, and an unchanged-patch proof carries the decision without a model run.

The receipt must be posted as a pull-request comment before any acceptance change. This pull request leaves `status: proposed`; its runnable repository gate is `npm run decisions:check`, which must pass with record 0076 still proposed. An author-side reread, a review approval or merge of the proposal is not the independent cold-reader receipt. Acceptance is a later, explicit status change that cites the comment and re-evaluates any objection it raised.

Implementation acceptance for unit one additionally replays the four issue #2145 fixtures and proves one run and one update of each kind per surface under webhook redelivery. Unit two acceptance proves the check red at a stale, blocked or in-flight head and green only at a current-head `LGTM`, both when GitHub requires it and when it is informational.

## Sources

- Issue #2145 — direction, the four 2026-09-21 merge fixtures, the update wording, repository setting and optional check.
- `src/core/dispatch/runLoop.ts`, `src/core/reviewedHead.ts`, `src/core/headMoved.ts`, `src/core/reviewPost.ts` and `src/core/runEvents.ts` at `9f6516d0` — the in-flight reviewed-head guard, rebase carry, substantive in-run re-review, posted verdict decision and durable review facts.
- `.github/workflows/auto-approve-review-lgtm.yml` at `9f6516d0` — the App identity guard, deterministic `LGTM:` contract, event-head comparison and commit-pinned approval.
- `src/channels/githubWebhook.ts`, `src/core/coordinator/checksIntake.ts`, `src/core/mergeWatch.ts` and `src/config.ts` at `9f6516d0` — signed App intake, event dispatch, watch pattern and repository-scoped settings precedent.
- [Agent review](../reference/specs/agent-review.md), especially items 6, 8, 10 and 12 — posting, reviewed-head protection, head-moved updates and the unchanged-rebase/substantive-move split while a run is live.
- Records [0041](0041-the-settings-page-is-a-surface-over-the-registry-and-configures-the-shared-tiers.md), [0047](0047-an-outside-fact-finds-the-thread-that-owns-the-work.md), [0055](0055-a-unit-has-one-thread-and-a-round-reads-the-checks-at-its-head.md) and [0071](0071-a-ship-unit-owns-its-pull-request-until-it-is-merged-merge-ready-waits-on-facts-and-a-dirty-head-buys-a-rebase-round.md).

## Public hygiene

This record keeps only public issue and record numbers, the four pull-request numbers carried by the issue as acceptance fixtures, repository-relative paths, the public-tree sha, the date and public setting/check names needed to test the decision. It names no Slack channel, user or message id, no private URL, customer or company, no credential, run id, unpublished cost or account detail. The originating review thread is part of the design shape but no production thread identifier appears here.
