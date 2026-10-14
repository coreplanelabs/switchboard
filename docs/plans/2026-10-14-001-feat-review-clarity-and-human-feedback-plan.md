---
title: Clear PR reviews and human usefulness feedback
type: feat
date: 2026-10-14
status: accepted
---

# Clear PR reviews and human usefulness feedback

## Outcome and scope

A person can read each finding and decide whether it warrants a change without opening the agent evidence. They can rate whether the review helped that decision with a native GitHub reaction. The existing metrics page shows the feedback, its coverage, and its trend over time.

This plan has three implementation PRs. The comment change can ship first. Keep the existing agent evidence, stable finding identities, case assessment rules, severity gate, exact-head publication, and approval behavior. Ratings do not change findings, authorize fixes, or train the reviewer automatically.

The scope is review clarity and perceived usefulness. Reactions do not measure finding accuracy, comprehension, time saved, or causal changes in delivery performance. Native reviews group several findings, so a review-body reaction cannot be assigned to an individual finding.

## Existing sources and constraints

The source inspected for this plan is revision `62032bbc1`.

- [Review renderer](../../src/core/reviewVerdict.ts): the human section currently displays severity, pinned location, and a title capped at 180 code points. Explanations are below the agent fold.
- [Submission tool](../../src/tools/submit.ts), [review prompts](../../src/agents/registry.ts), and [history](../../src/core/reviewHistory.ts): prior findings retain controller-owned metadata. The human explanation must be separate from the original title.
- [Native publication](../../src/execution/githubComments.ts): validates the returned review ID, body, head, state, and repository, but returns only the write state.
- [Publication receipt](../../src/core/reviewPublication.ts) and [post-step](../../src/core/reviewRound.ts): publication survives restart and never repeats an uncertain write. New feedback data must preserve that boundary.
- [Run metrics](../../src/core/runMetrics.ts), [metrics service](../../src/core/metricsService.ts), and [metrics page](../../web/src/pages/MetricsPage.vue): operational metrics use sampled, at-most-once Analytics Engine records. They are not an exact store for editable votes.
- [State Worker](../../deploy/cloudflare-memory/worker.ts): durable run state already owns publication receipts. Use that state for an exact feedback projection, with an in-memory implementation of the same interface for tests.
- [Delivery snapshot](../../src/core/deliverySnapshot.ts) is a useful refresh pattern, but its merged-only selection and PR update-time optimization must not select or refresh feedback.
- [Review spec](../reference/specs/agent-review.md) and [run metrics spec](../reference/specs/run-metrics.md) own the affected outcomes. Update them in the implementation PRs. Add an ADR only for the durable feedback ownership and mutable-cohort semantics; do not edit existing decisions.

GitHub's [GraphQL PullRequestReview](https://docs.github.com/en/graphql/reference/pulls#pullrequestreview) implements Reactable and exposes paginated reactions, their actors, and the native review identity. This supports reactions on the existing review body. The [REST review-comment API](https://docs.github.com/en/rest/pulls/comments) addresses inline diff comments, a different resource. Do not change publication to an issue comment or add a second PR comment to obtain ratings.

## Human comment contract

Add verdict-level `humanFindings`, keyed by the exact active finding ID. Each entry contains:

- `problem`: the current problem, suitable for the visible title.
- `scenario`: a concrete input or user action and the conditions needed to reach the failure.
- `impact`: the wrong result and affected user or system.
- `evidence`: a basis and short detail. Distinguish a code trace, an isolated reproduction, a deployed reproduction, and an explicit repository rule. Reproduction details name their environment; a trace must not imply reproduction.
- `requestedChange`: the smallest change that addresses the finding.
- `location`: a presentation locator at this verdict's reviewed head. Use a repository-relative file and optional line, validated by the existing location rules. A moved failure must not link to the old frozen line at the new head.

Render these as a short paragraph after the severity, problem, and pinned location. Use a short evidence and fix sentence when that helps scanning. Do not add six headings per finding. The fields define content, not mandatory verbose prose.

Example:

> **Major — Users cannot continue a live connection setup.** This affects the normal chat flow: the server saves the connection receipt, but the console does not receive the update needed to show Connect or Continue. The workflow waits until it times out; reloading restores the buttons. The reviewer traced the code path but did not reproduce it live. Send the receipt before waiting.

Fresh submissions require unique, complete coverage of all active findings, including scoped prior IDs. An approval with no findings uses an empty array. Bound the explanation to 900 visible code points per finding, returning a named validation error rather than silently clipping its evidence or fix. Verify that budget against the example and multi-finding fixtures before finalizing it.

Historical verdicts without the new array remain readable and use the current legacy rendering. Persist the new array with the canonical verdict and accepted tool receipt, including restart/replay and redaction paths. It does not replace or alter history-owned finding metadata. Keep the existing machine marker's authority fields and agent fold intact; historical GitHub reads do not need the new human fields to recover findings.

Fresh human entries use their current presentation locator for the visible code link. Original finding locations remain in the history/agent evidence. A file move or a fix that leaves a different case open is a required regression fixture.

Require concrete reachability rather than invented likelihood. A rare, supported security or data-loss failure can warrant a fix. An input ruled out by a guard does not. Unknown frequency stays unknown. The schema proves coverage and shape, not the truth of a model's explanation.

## Rating contract and metrics

Place one invitation after the human review and before the existing fold:

> Did this review help you decide what to change? 👍 Yes · 👎 No.

Include the same invitation on reviews with no findings; those reviews can also be useful. Separate them from reviews with findings in the report.

Use only thumbs-up and thumbs-down from identifiable GitHub User actors. Exclude Bot actors and configured automation account IDs. Classify missing/deleted actor identities as unknown rather than human. A human account operated by an agent cannot always be identified; the report describes the counts as ratings from human accounts.

One actor supplies at most one effective vote per native review. Up only is positive; down only is negative; both is ambiguous and excluded from the helpful-vote ratio. Count and display ambiguous pairs. Multiple people may rate the same review; display distinct review and rater counts so a heavily rated PR is visible.

An eligible publication is a durably accepted native review in the selected publication range, tracked from the new receipt protocol and carrying the rating invitation, excluding acceptance-test cohorts. Missing native identity or delayed projection is a tracking gap, not exclusion from the publication denominator. All usefulness ratios use the same subset with complete, fresh snapshots. Show last-known stale ratings separately from those ratios.

| Measure | Exact definition |
| --- | --- |
| Review feedback, the headline | Positive-only, negative-only, and mixed reviews, counted once per native review. Show counts together; do not hide disagreement in a single score. |
| Helpful share of clear ratings | Positive-only reviews / (positive-only + negative-only reviews). Show mixed reviews beside this ratio and name its denominator. |
| Helpful votes, secondary | Positive effective votes / (positive + negative effective votes). Display counts and distinct reviews alongside the percentage. |
| Rating coverage | Completely fetched reviews with at least one unambiguous human vote / completely fetched eligible reviews. |
| Tracking and sync coverage | Registered reviews / eligible accepted publications; then fresh complete reaction snapshots / eligible accepted publications. Missing identity and delayed projection remain visible gaps. |
| Review distribution | Positive-only, negative-only, mixed-sign, ambiguous-only, unknown-only, and unrated reviews, using mutually exclusive buckets. |
| Context | Distinct PRs, reviews, and raters; approval-only versus findings-bearing reviews; repository and format version. |

No votes means no rating, not zero usefulness. Inaccessible, deleted, pending-sync, and stale reviews do not become unrated. Show small sample counts and data freshness without traffic-light quality targets.

For distribution, count effective positive and negative votes first. Both signs means mixed; one sign means its single-sign bucket. With no effective votes, ambiguous human pairs take the ambiguous-only bucket, then unidentified thumb actors take unknown-only, then no matching human ratings means unrated. Always show unknown-actor and ambiguous-pair counts separately, including when they occur on a review with effective votes.

Use publication week and format version as the trend cohort. Label the trend as current ratings of reviews published in that week, with the last refresh time. A later rating or removal can revise that cohort. Do not label this as the score observed in that historical week. Preserve existing UTC range semantics and 7/30/90-day controls.

Reuse existing cost, duration, reliability, review-round, and delivery indicators as context where available. Do not equate fixed findings, fast merges, or agent agreement with human usefulness. Start with aggregate feedback; reasons for negative votes and per-finding ratings are later extensions only if the data shows a need.

## Exact feedback data and refresh

Use a dedicated feedback interface over the existing state Worker and an in-memory implementation. Add feedback tables and routes to the existing run-state owner rather than a new service or Worker binding.

1. Return the validated native review node ID, database ID, and URL from the publication adapter using a review-specific write result. Do not widen every GitHub write abstraction.
2. Extend the publication receipt protocol with optional native review identity. Support existing receipts explicitly and keep exact target, body hash, write-state, ownership, and no-repost checks. Identity must come from validated GitHub response bytes, never a model field.
3. Keep the minimal native identity and system-authored cohort metadata in the existing durable acceptance receipt. This is the authoritative source: run ID, repository, PR number, reviewed head, publication time, verdict, finding count, model context when known, format version, and whether the invitation was present. Missing optional native feedback fields must not invalidate a response that satisfies existing native acceptance checks. Do not count uncertain writes as accepted.
4. Build the feedback publication index as an idempotent, repairable projection of those accepted receipts, keyed by repository and native review identity. Projection or enrichment failure must leave the accepted publication state intact. A bounded reconciliation pass repairs missing index rows without posting anything to GitHub. Keep the compact accepted receipts, publication index, and snapshots for 90 days independently of run-record retention; run pruning must not destroy the repair source. Use bounded cleanup in the existing state owner's maintenance path.
5. Poll registered publications with the GitHub App credential from the bot boundary. Request reaction IDs, actor IDs/types, content, pagination, and timestamps. Read all pages before replacing a review's snapshot. Check that returned nodes belong to the registered repository, PR, review, and commit.
6. Store a complete current snapshot, not counters incremented by reads. Deduplicate IDs, replace removed reactions, and reject stale overlapping writes with a durable refresh generation. A partial page, timeout, or GraphQL partial error preserves the last complete snapshot and records stale/unknown status.
7. Start with a config-driven background refresh following the existing snapshot pattern. Refresh reviews published in the last seven days hourly and cover older retained reviews daily. Define fresh as no older than two hours for the recent group and 26 hours for the older group, allowing scheduling delay. Keep those thresholds explicit in the report and in tests. Use bounded batches, persisted progress/leases, GitHub rate-limit backoff, and request limits. Put duration limits in `src/core/budgets.ts`. Verify achievable freshness under the actual cohort size; report lag when the budget cannot meet it.
8. Page loads read stored reports only. They never fan out to GitHub or block a review on feedback sync. Keep operational metrics usable when the feedback source fails; the human-feedback section reports its own unavailable or stale state.

Do not depend on a reaction webhook or on a PR's `updated_at` changing. Use polling as the baseline. No new model run, schedule-registry entry, external automation, or live feedback-triggered fix is needed.

Legacy publications before the new protocol are explicitly outside the tracked cohort. Show the collection start date. Publications in the new cohort with missing identity are unknown tracking gaps. Do not fabricate historical coverage from sampled run rows. A future bounded read-only backfill may match author, head, and exact body evidence, but it is not needed for this release.

## Execution units and effort

Effort is an engineering estimate, not a promised elapsed duration. Use Sol for implementation and review the tested diff at each unit.

| Unit | Deliverable and main seams | Estimate |
| --- | --- | --- |
| 1 | Typed current-head human explanations; submission coverage; renderer; prompts; canonical persistence/redaction; review spec and focused regression fixtures. | 1.5–2 days |
| 2 | Native identity receipt; exact repairable feedback cohort; Worker and in-memory store; complete reaction snapshots; bounded restart-safe polling; protocol rollout tests. | 3–4 days |
| 3 | Review usefulness section on the existing metrics page; shared JSON/command report; trends and drilldown links; UI fixtures, docs, and end-to-end acceptance. | 1.5–3 days |

Total: 6–9 engineering days, plus CI/review, release timing, and live acceptance. No new infrastructure account or analytics vendor is expected. The native App-token API probe and receipt migration are early risk checks, before unit 2's main build.

Each PR contains the affected spec rows and proofs. Keep structural tidying separate from behavioral changes when needed. Unit 1 may release independently; units 2 and 3 depend on the new publication cohort, not on a historical backfill.

## Real-world stress cases and proof

Use the existing focused test framework and fixtures. Test the public submission/rendering path and Worker API; do not add a broad new evaluation harness.

| Case | Expected observable result |
| --- | --- |
| Normal live connection flow fails | Human section states trigger, effect, evidence limit, and minimal fix with the agent fold closed. |
| Existing guard or intentional behavior | Reviewer drops the unsupported candidate; no manufactured finding. |
| Rare reachable security/data-loss failure | Report remains actionable despite rarity; actual conditions are stated. |
| Code trace versus unit/live reproduction | Evidence label matches the actual proof and names its environment. |
| Partial fix at a new head | Human explanation describes what remains; stable identity, old metadata, cases, and closures remain intact. |
| Clean PR or explicit repository rule | No-finding review stays rateable; rule finding identifies the rule without inventing runtime harm. |
| Multiple findings, Unicode, unsafe HTML, oversized input | Complete human findings remain visible; escaping and size refusal preserve the fold and authoritative marker. |
| Vote added, changed, removed, or both signs used | Exact actor/review counts and ratio update under the stated rules. |
| Bots, missing actors, unrelated emojis, or unrelated reviews | They do not enter human helpful-vote counts. |
| Several reaction pages or partial GraphQL failure | All pages are required; failure preserves the last complete snapshot and exposes staleness. |
| Restart after acceptance or lost response | No second GitHub publication; accepted cohort persists and is counted once. |
| Feedback projection fails after native acceptance | Publication stays accepted; tracking gap is visible; reconciliation repairs the index without posting or counting twice. |
| Old receipts, old verdicts, and short run retention | Legacy records remain readable; new feedback outlives run pruning. |
| Open/unmerged, inaccessible, or deleted PR review | Open reviews are included; inaccessible/deleted data stays distinct from no ratings. |
| No ratings, few ratings, incomplete sync, mixed formats | UI shows honest counts, coverage, cohort labels, and freshness. |

Renderer/schema tests cannot prove reviewer judgment. Replay a small frozen set of representative PR changes through a read-only review path with publication disabled, inspect actual model output against the cases above, and record correct omissions as well as correct findings. Hold code input and model/effort constant when comparing prompt changes. Keep private examples outside the public repository; use sanitized fixtures for deterministic regression tests.

Targeted verification: touched Vitest files by exact name, changed-file formatting, touched package typechecks, relevant Worker tests, `hygiene:check`, `specs:check`, `decisions:check`, and `specs:coverage` for each implementation diff. Run required generation from sources. Full test and validation suites remain with CI under the user's scope rule. Render representative comments and the dashboard in both themes and narrow layouts; use existing screenshot tooling when the UI inputs change.

## Rollout and live acceptance

1. Confirm the configured GitHub App can read actual review-body reactions and all required actor fields. A developer credential does not prove App-token access.
2. Deploy the additive state-reader/storage capability before enabling the new receipt writer. Keep old receipt reads supported. Verify upgrade and downgrade policy against in-flight runs; rollback by disabling collection/rendering rather than loading an old binary that cannot decode new state.
3. Release unit 1 and inspect an actual published review at the deployed build. Confirm its evidence wording, legacy handling, and approval marker.
4. Enable exact registration and bounded collection; verify the new cohort and its coverage before exposing percentages.
5. Use a disposable PR to publish a review, add and remove a test-account reaction, refresh, restart, and verify exact count changes on the dashboard and JSON report. Synthetic acceptance accounts/PRs are excluded from normal human-usefulness metrics.
6. Obtain one real human rating through the normal PR interface and verify it reaches the correct production cohort. This verifies ingestion, not improved satisfaction.
7. Record tested revision, deployed build, native review ID/head, durable cohort/snapshot evidence, counts, refresh timestamps, and dashboard receipt. Keep local, CI/review, merge, release, and live proof distinct.

Feedback failures must not block publication or affect approvals. Retain durable feedback rows when disabling collection. Existing release ownership and deployment authorization remain in force; planning alone does not authorize production changes.

## Definition of done

The deployed review explains what happens, why it matters, what evidence supports it, and what change is requested. Native human ratings survive restart, changes, and removals without duplicate publication or counting. The existing metrics page and JSON report show the same exact feedback counts, denominators, cohort trend, and freshness. Representative model-output cases and native end-to-end acceptance have receipts. No improvement in usefulness is claimed until humans provide enough feedback to observe a trend.
