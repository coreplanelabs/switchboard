---
title: Fix the queued follow-ups - Plan
type: fix
date: 2026-09-20
status: proposed
artifact_contract: ce-unified-plan/v1
artifact_readiness: implementation-ready
product_contract_source: ce-plan-bootstrap
execution: code
---

# Fix the queued follow-ups - Plan

## Goal Capsule

- **Objective**: Close ten queued, independently reviewable follow-ups: reviews refuse merged pull requests before a run, confirmation copy names who changes and for how long, the two web chats share one conversation engine, the checkout CLI cannot execute stale built code, `/plane` keeps a draft and scroll through a breakpoint crossing, the configured reading-diff model is preserved and failures name its setting, a Slack image reaches a coding child, the seeded sandbox carries ripgrep, a provider recovery reaches a parked live run immediately, and a restart whose process dies is bounded at the read side.
- **Authority**: the ten public records cited by the units — issues [#2050](https://github.com/coreplanelabs/switchboard/issues/2050), [#2051](https://github.com/coreplanelabs/switchboard/issues/2051), [#2061](https://github.com/coreplanelabs/switchboard/issues/2061), [#2093](https://github.com/coreplanelabs/switchboard/issues/2093), [#2087](https://github.com/coreplanelabs/switchboard/issues/2087), [#2102](https://github.com/coreplanelabs/switchboard/issues/2102), [#2103](https://github.com/coreplanelabs/switchboard/issues/2103), [#2079](https://github.com/coreplanelabs/switchboard/issues/2079) and [#2081](https://github.com/coreplanelabs/switchboard/issues/2081), plus the residual handoffs on merged pull requests [#2091](https://github.com/coreplanelabs/switchboard/pull/2091) and [#2092](https://github.com/coreplanelabs/switchboard/pull/2092). The living specs each unit names remain the behavioral authority and change with their proofs.
- **Execution profile**: ten code units in this repository, each one pull request through the plan runner's review loop and merge grant. Every unit is self-contained, has no dependency on another unit, starts with a failing test for its own behavior, and is sized to one review. The runner executes U1 through U10 in the order written so the queue is deterministic; that order is scheduling only, not a code dependency.
- **Stop conditions**: a unit hands back a deviation before changing anything if it needs a new credential, store, schema migration, cross-repository change, second implementation of an existing seam, weakened guard, or a diff that combines another unit. A unit also stops rather than guessing when its named repository prerequisite is absent, when its named test cannot be made red on the base, or when the fix would remove an existing fallback instead of preserving it.
- **Tail ownership**: the plan runner rebases each unit onto the current base, waits for its review and CI, and merges it under its own grant; no person is required to press a merge button. Every U1–U10 completion fact is available to the runner through repository tests or CI. The deployed U6 receipt is a post-plan operational follow-up, not a unit gate, so unavailable production access cannot halt the unattended run.

---

## Product Contract

### Summary

These are ten small defects left by otherwise-complete changes. Each one has a narrow user-visible promise and a natural proof; none needs to wait on another. The plan packages those promises as complete unit contracts so the unattended runner can implement, review and merge them without recovering context from an earlier pull request or private thread.

### Problem Frame

The queue mixes copy defects, web state drift, package/install drift, image composition, attachment transport and two durability races. Treating them as one implementation would make review and rollback unsafe. Treating the residual handoffs as prose-only reminders would make the runner rediscover architecture and acceptance criteria. Each unit therefore names its record, exact boundary, expected files, test scenarios and runner-accessible proof.

### Requirements

**U1 — review preflight and stop words ([#2050](https://github.com/coreplanelabs/switchboard/issues/2050))**

- R1. A review request whose resolved pull request is merged ends before admission, workspace attachment, run registration or model invocation. It answers one line: `<repo>#<n> merged at <time>; nothing to review. Say which pull request you meant.` A closed-unmerged pull request gets the parallel one-line closed answer without inventing a merge time.
- R2. A review stopped before checkout records and renders only that it was stopped. It posts no verdict, no synthetic finding, no reviewed-head mismatch and no GitHub review.

**U2 — confirmation copy names the actual setting owner ([#2051](https://github.com/coreplanelabs/switchboard/issues/2051))**

- R3. The risk line for `config set me` and the matching clear/instructions paths says the click changes the caller's own settings until that caller resets them. A channel write names the channel and everyone who asks there; an organization write names every channel. No user-facing line says `scope`.
- R4. The line is derived from the parsed command input and caller origin, not from a caller-authored label, and the same line reaches every confirmation surface.

**U3 — one conversation composable ([#2061](https://github.com/coreplanelabs/switchboard/issues/2061))**

- R5. `HomePage` and `PlaneChat` use one composable for the item union, seed fold, live-turn selection, submit, stop, input matching, ending and follow-scroll behavior. Page-only effects — mark pulse, first-send URL replacement, empty copy and follow target — are explicit options or callbacks.
- R6. The extraction changes no HTTP shape, turn ordering, stop mode, offer fill, hosted-parent rule or stream count. The composable owns the duplicated tests; each host retains only tests for its own wiring.

**U4 — the checkout CLI cannot execute stale built code ([#2093](https://github.com/coreplanelabs/switchboard/issues/2093))**

- R7. `npx @coreplane/switchboard …` inside this checkout never imports a stale `packages/switchboard/dist/cli.js`. The unit chooses one deterministic checkout policy — rebuild the bundle from the current source before it can run, or keep ignored `dist` absent/unusable and fail by name with the checkout command — and proves source changes cannot leave an older executable authoritative.
- R8. Operator how-tos consistently say: inside a checkout use `npm run --silent cli -- <command>`; outside it use an explicit published version, `npx --yes @coreplane/switchboard@<version> <command>`. Examples whose location is intentionally generic say which form they demonstrate.
- R9. The packaging gate examines the emitted `dist/cli.js` dependency imports, not only the source graph, and fails by package name when the build imports a package absent from `packages/switchboard/package.json`; declared dependency ranges still equal the root's.

**U5 — a breakpoint crossing is lossless ([#2087](https://github.com/coreplanelabs/switchboard/issues/2087))**

- R10. Crossing `/plane`'s wide breakpoint in either direction preserves the unsent composer draft and the chat's scroll anchor. A live turn keeps one stream subscription and continues without a duplicate.
- R11. The fix either moves one `PlaneChat` instance between hosts or lifts/persists exactly the state a remount would lose. It does not mount a hidden second chat and does not depend on U3 having landed.

**U6 — the configured reading-diff model is preserved and failures name its setting ([#2096](https://github.com/coreplanelabs/switchboard/pull/2096))**

- R12. An on-demand abridge passes the configured `review.readingDiff.meatModel` value `sol` to meat exactly, stores a meat-powered artifact naming `sol`, and makes the panel select the reading diff. No built-in model or fallback substitutes for it.
- R13. A failed abridge identifies `review.readingDiff.meatModel` and the configured value in its stored/user-visible reason while preserving the underlying safe error.

**U7 — a Slack image reaches the coding child ([#2102](https://github.com/coreplanelabs/switchboard/issues/2102))**

- R14. An image accepted from the Slack message that starts a hosted ship pipeline is durably associated with the generated unit and reaches its first coding child's `IncomingMessage`; normal staging puts it under `/workspace/attachments`, and `recall assets:true` can name it.
- R15. The transport reuses the coordinator's bounded thread-event attachment shape and existing staging path. Review children and later coding rounds do not receive duplicate copies; a file outside the existing cap is named as dropped rather than silently omitted.

**U8 — ripgrep is in every seeded sandbox ([#2103](https://github.com/coreplanelabs/switchboard/issues/2103))**

- R16. The sandbox image installs `ripgrep` and proves `rg` resolves at image build time. A seeded sandbox and a fresh sandbox use the same image, so the grep tool never needs an egress download fallback.

**U9 — provider recovery reaches the live inbox ([#2079](https://github.com/coreplanelabs/switchboard/issues/2079), residual handoff from [#2091](https://github.com/coreplanelabs/switchboard/pull/2091))**

- R17. The provider plane's `up` decision keeps its durable inbox write atomic and also offers a typed live-delivery effect. The state Worker pushes that effect through the existing `/plane/effects` transport; the owning generation puts the already-durable message into the live run's in-memory inbox immediately and acknowledges only after that delivery.
- R18. A draining or non-owning generation defers the effect; it stays offered for the owner or the next heartbeat/reclaim. Duplicate delivery is idempotent by the durable inbox sequence, and the harness reissues the held turn exactly once without waiting for reclaim.

**U10 — a dead restart expires at the read side ([#2081](https://github.com/coreplanelabs/switchboard/issues/2081), residual handoff from [#2092](https://github.com/coreplanelabs/switchboard/pull/2092))**

- R19. A restarting record carries or deterministically derives one persisted deadline from its close. Before that deadline, `read-record` still answers running so a valid successor can claim; after it, if no successor exists, `read-record` answers interrupted with the original recorded cause instead of waiting to the unit wall-clock cap.
- R20. A successor claimed before or after the deadline wins over the expiry, and the existing in-process `restart_died` correction remains the eager path. The deadline uses the central budget constants and injected clock; no timer or process-local state is required.

### Scope Boundaries

- No unit changes command authorization, model routing, merge policy, the plan runner's merge grant or another unit's behavior.
- No new database, Durable Object, credential or external service. U7 uses the existing coordinator event/store and attachment staging; U9 uses the existing plane effect push and durable inbox; U10 uses the existing record/read seams.
- U3 is an extraction with behavior pinned first. U5 is the breakpoint behavior and stays valid whether or not U3 has merged.
- U6 does not change production configuration in this repository and does not replace `sol`; runner-accessible tests prove the configured value or fail by its key. A production operator may add the deployed receipt after the plan completes, but that receipt is outside U6 and the unattended completion contract.
- The issue and pull-request links live in this plan, which is excluded from the public-hygiene ratchet; production comments, fixtures and user surfaces carry no private thread, person, incident date, platform id or tracker prose.

### Open Questions

None. Each unit's issue and requirements settle its user-visible outcome; implementation choices are bounded below.

---

## Planning Contract

### Key Technical Decisions

- **K1. Preflight facts end a review before admission.** U1 uses the pull-request state already resolved in repository context; checking only in the post-step is too late because a run and workspace already exist.
- **K2. Risk prose is input-aware presentation, not authority.** U2 may extend the risk renderer with caller-origin display context, but authorization and blast-radius classification remain unchanged.
- **K3. Conversation behavior has one owner.** U3's composable owns mutable conversation state and actions; hosts inject only effects that are genuinely page-specific.
- **K4. A checkout and a published package have different natural commands.** U4 makes that distinction executable, then documents it everywhere. An ignored build artifact is never trusted merely because it exists.
- **K5. One live chat subscription.** U5 prefers moving one instance; if the framework boundary makes that unsafe, it persists the draft and scroll anchor around a single conditional mount. Two mounted stream consumers are forbidden.
- **K6. The configured path is the unit contract.** U6 proves with repository tests that the command passes `sol`, records a `sol` artifact and names the controlling key on failure. A separately authorized production operator can confirm the deployed path afterward; that receipt does not close or reopen the unit.
- **K7. Attachments cross the same durable seam as unit-thread follow-ups.** U7 seeds the generated unit's bounded event list once and lets the existing child fold/staging path do the rest; no base64 field is added to a Workflow brief.
- **K8. Image tools belong in the image.** U8 installs ripgrep in the Docker layer that already installs git, curl and squashfs-tools and adds a static/build-time probe.
- **K9. Durable write plus offered live effect.** U9 never replaces the inbox row with an ephemeral push. The row is truth; the effect shortens delivery latency and remains retryable until acked.
- **K10. The read judges absence after a persisted bound.** U10 cannot rely on an in-process catch for a dead process. The record carries enough time for any later reader to decide, with a live successor always taking precedence.

### Sequencing

The runner executes U1 → U2 → U3 → U4 → U5 → U6 → U7 → U8 → U9 → U10, matching the requested queue. Every unit declares `Dependencies: none`; if an earlier unit has landed, a later unit may use its public seam but may not require it to satisfy its own tests.

### Assumptions

- The current repository context already distinguishes open, merged and closed pull requests, but the review admission path does not consume that state early enough.
- The confirmation annotation can be extended with display-only caller origin without changing the authorization input.
- The coordinator already folds bounded thread-event attachments onto coding children; the missing link is the hosted ship request's initial files.
- The state Worker already pushes plane effects to the bot and stores run inbox rows; U9 adds a live steer effect to those seams rather than a new transport.
- `finishedAt`/the restarting close and an injected reader clock are durable enough to express U10's bound; if the base lacks an unambiguous close stamp, the unit adds an explicit deadline field to the record.

---

## Implementation Units

| U-ID | Title | Trigger | Key files | Dependencies |
|---|---|---|---|---|
| U1 | A merged pull request never starts a review; an early stop says only stopped | [#2050](https://github.com/coreplanelabs/switchboard/issues/2050) | review admission, repository context, review post/settle, agent-review spec | none |
| U2 | Confirmation copy names whose setting changes and for how long | [#2051](https://github.com/coreplanelabs/switchboard/issues/2051) | config commands, command risk projection, confirmation tests/specs | none |
| U3 | Home and Plane use one conversation composable | [#2061](https://github.com/coreplanelabs/switchboard/issues/2061) | `HomePage.vue`, `PlaneChat.vue`, new composable/tests | none |
| U4 | Checkout CLI never executes stale dist | [#2093](https://github.com/coreplanelabs/switchboard/issues/2093) | package bin/build/tests, manifests, operator how-tos, packaging spec | none |
| U5 | Plane breakpoint crossings preserve draft, scroll and one stream | [#2087](https://github.com/coreplanelabs/switchboard/issues/2087) | `PlanePage.vue`, `PlaneChat.vue`, plane tests/spec | none |
| U6 | A configured abridge preserves `sol` and names failures | [#2096](https://github.com/coreplanelabs/switchboard/pull/2096) | reading-diff abridger/process/panel tests/spec | none |
| U7 | The hosted ship request's Slack image reaches the coding child | [#2102](https://github.com/coreplanelabs/switchboard/issues/2102) | ship handoff, coordinator instance/events/spawn, attachment tests/specs | none |
| U8 | Seeded sandbox image carries ripgrep | [#2103](https://github.com/coreplanelabs/switchboard/issues/2103) | sandbox Dockerfile and image/static proof | none |
| U9 | Provider-up steer is delivered to the live run immediately | [#2079](https://github.com/coreplanelabs/switchboard/issues/2079) / [#2091](https://github.com/coreplanelabs/switchboard/pull/2091) | plane decider/Worker/effects, write-through, harness integration/specs | none |
| U10 | A whole-process restart death expires at read-record | [#2081](https://github.com/coreplanelabs/switchboard/issues/2081) / [#2092](https://github.com/coreplanelabs/switchboard/pull/2092) | restart record, read-record, budgets, run-history/agent-ship specs | none |

### U1. A merged pull request never starts a review; an early stop says only stopped

- **Goal**: resolve merged/closed state at review preflight and end there; make a stop before checkout terminal without running reviewed-head or verdict machinery.
- **Requirements**: R1, R2; [issue #2050](https://github.com/coreplanelabs/switchboard/issues/2050); update the applicable rows in `docs/reference/specs/agent-review.md` and `docs/reference/specs/run-history.md` with exact proofs.
- **Dependencies**: none.
- **Files**: `src/core/repoContext.ts` and `src/core/repoContext.test.ts` if the resolved fact needs merge time; `src/core/dispatcher.ts` / `src/core/dispatch/provision.ts` and their tests for the pre-admission return; `src/core/dispatch/runLoop.ts`, `src/core/reviewRound.ts`, `src/core/reviewPost.ts` and nearest tests for stop ordering; the two specs above.
- **Approach**:
  1. Write dispatcher tests that count admission, attach, registry start, provider and GitHub-review calls, then present merged and closed PR facts.
  2. Add a pure preflight rendering from resolved state. Return its one line before `attachWorkspace`, `runStarted` or any model call.
  3. Make the review tail predicate treat a stop observed before checkout as no reviewed head and no verdict. Keep normal soft-stop findings for a review that actually began; the boundary is the checkout/review-start fact, not stop mode alone.
  4. Delete any synthetic finding path used only to explain missing checkout state; bind the spec rows to the new cases.
- **Test scenarios**:
  - A merged PR with a merge timestamp answers exactly one line containing `merged at`, `nothing to review` and the PR reference; admission, workspace, registry, provider and review-post spies stay at zero.
  - A closed-unmerged PR answers one closed line without `merged at`; the same spies stay at zero.
  - A stop before checkout ends `stopped`, emits no `submit_verdict`, no `review_not_posted` head comparison, no finding and no GitHub call; the reply contains only the stop sentence.
  - A stop after checkout and after real findings keeps the existing findings-so-far behavior, proving the fix is not a blanket deletion.
- **Verification**: run the touched Vitest files by exact path; scoped root TypeScript; prettier on changed files; `npm run specs:check`; `npm run hygiene:check`; CI runs the full suite and `npm run verify`.

### U2. Confirmation copy names whose setting changes and for how long

- **Goal**: render confirmation risk from the parsed config target and the chat's display context, with truthful duration and no internal noun.
- **Requirements**: R3, R4; [issue #2051](https://github.com/coreplanelabs/switchboard/issues/2051); update `docs/reference/specs/routing-and-config.md` item 28 and `docs/reference/specs/slack-channel.md` item 14 or their current successors.
- **Dependencies**: none.
- **Files**: `src/core/commands/config.ts` and tests; `src/core/commandRegistry.ts` / `src/core/dispatch/route.ts` only if risk projection needs caller origin; caller-construction tests on chat surfaces; confirmation/Slack snapshots and the two specs.
- **Approach**:
  1. Add a `configRisk` pure renderer over accepted input plus optional display origin. Keep `destructiveBeyondMe` as the classifier; prose does not decide authority.
  2. Thread the channel's display name through caller origin only where needed for presentation. Fall back to `this channel`, never an id or `scope`, if no safe name exists.
  3. Use the renderer for set, clear and instructions so equivalent ownership has one sentence.
  4. Regenerate only derived command snapshots/docs if the command definition changes.
- **Test scenarios**:
  - `config set me --verbosity verbose` offers `changes your own settings until you reset them` and no `everyone`, `scope` or channel.
  - Channel set/clear/instructions name the channel and `everyone who asks there`, ending with `until reset`; absent channel name says `this channel`.
  - Organization config names `every channel`; user-binding administration names the affected person's setting without implying the caller's own setting.
  - CLI/HTTP/MCP render the same risk meaning without Slack syntax; blast-radius and authorization assertions are unchanged.
- **Verification**: touched config/route/confirmation tests by path; scoped root TypeScript; prettier; regenerate/check command docs only if their source changed; specs and hygiene checks; full verification in CI.

### U3. Home and Plane use one conversation composable

- **Goal**: extract one tested `useConversation` state machine and make both hosts thin adapters.
- **Requirements**: R5, R6; [issue #2061](https://github.com/coreplanelabs/switchboard/issues/2061); update `docs/reference/specs/web-chat.md` and `docs/reference/specs/orchestration-plane.md` coverage and proof rows.
- **Dependencies**: none.
- **Files**: new `web/src/lib/useConversation.ts` and `useConversation.test.ts`; `web/src/pages/HomePage.vue`; `web/src/components/plane/PlaneChat.vue`; narrowed `web/src/pages/home.test.ts` and `web/src/pages/plane.test.ts`; both specs.
- **Approach**:
  1. Move the item type, seed fold, live selection, draft/hint/mode/sending state, submit response handling, stop, `onInput`, `onEnded` and follow-scroll decision behind one composable.
  2. Inject `now`, commands, send URL, initial turns and callbacks for Home's pulse/URL replacement and each host's follow target; keep rendering components in the hosts.
  3. Port duplicated behavioral cases to composable tests first, then leave one host-wiring case per option.
  4. Compare request bodies and item sequences before/after; no visual redesign or screenshot churn belongs here.
- **Test scenarios**:
  - Identical seeds produce identical item order and live-item choice, including hosted ship parent skipping and seeded `serverNow`.
  - 202 starts one live assistant turn; an offer fills the draft/hint; inline reply appends; steer acknowledgement appends nothing; failure marks the person turn.
  - Stop is soft and uses the current live turn's URL; input folds the matching person turn; ending clears the live turn.
  - Home alone pulses and replaces `/threads` after the first send; Plane does neither. Both follow only when already at the bottom.
- **Verification**: the new composable test plus touched home/plane tests by exact path; `tsc --noEmit -p web/tsconfig.json`; prettier on changed web/Markdown files; specs and hygiene checks; CI runs workspace/full verify.

### U4. Checkout CLI never executes stale dist

- **Goal**: make the checkout command/source boundary deterministic, fix every operator example, and prove emitted dependency closure.
- **Requirements**: R7, R8, R9; [issue #2093](https://github.com/coreplanelabs/switchboard/issues/2093); update `docs/reference/specs/packaging.md` and the affected how-tos.
- **Dependencies**: none.
- **Files**: root/package lifecycle source if rebuild-on-install is chosen; `packages/switchboard/bin/switchboard.js`, `build.mts`, `bin.test.mts`, `build.test.mts`, `smoke.test.mts`, `package.json`; `.gitignore`; `docs/how-to/operate-production.md`, `deploy.md`, `rotate-a-secret.md`, `store-run-artifacts.md` and any other checkout-facing how-to found by search; `packaging.md`.
- **Approach**:
  1. Reproduce with a sentinel stale bundle whose output differs from source, then run the workspace-resolved `npx` form.
  2. Choose one policy and state it in the spec: either installation builds a current checkout bundle with a source/build stamp the bin verifies, or checkout detection refuses/avoids `dist` and names `npm run --silent cli --`; a published package continues to execute its shipped bundle. Merely adding `dist` to `.gitignore` is insufficient if an old ignored directory can still run.
  3. Rewrite how-tos by execution location: checkout examples use the root script; published-package examples pin `@<version>` and `--yes`.
  4. Build into a temporary directory in the packaging test, parse the emitted module imports/esbuild metafile and compare external package names to package dependencies and root ranges.
- **Test scenarios**:
  - A deliberately stale checkout `dist/cli.js` is never executed; the chosen rebuild or named refusal/source path is observed.
  - A fresh checkout after the supported install has no stale-authoritative window; published tarball smoke still runs `npx`/the bin from an empty directory.
  - Injecting `import "left-pad"` into the emitted fixture fails the packaging check naming `left-pad`; a declared-but-unused dependency and a range mismatch also fail.
  - A docs assertion finds no unqualified `npx @coreplane/switchboard` in a checkout procedure and accepts explicit-version published examples.
- **Verification**: package bin/build/smoke tests by exact path and the nearest docs/reference test; scoped package and root TypeScript as touched; prettier on code and manifests; docs/specs/hygiene checks; CI builds and runs full verify.

### U5. Plane breakpoint crossings preserve draft, scroll and one stream

- **Goal**: make switching between pinned column and sheet lossless without mounting two chats.
- **Requirements**: R10, R11; [issue #2087](https://github.com/coreplanelabs/switchboard/issues/2087); update `docs/reference/specs/orchestration-plane.md` item 11.
- **Dependencies**: none.
- **Files**: `web/src/pages/PlanePage.vue`, `web/src/components/plane/PlaneChat.vue`, `web/src/pages/plane.test.ts`; if present, the shared conversation composable from U3 through its public API only; orchestration-plane spec.
- **Approach**:
  1. Test the crossing with a draft, non-bottom scroll position and a live EventSource before changing mount behavior.
  2. Prefer a single component instance moved between wide and narrow targets. If Vue ownership makes that unsafe, lift draft and scroll-anchor state to `PlanePage` and restore around the one conditional mount; never render two live `PlaneChat`s.
  3. Preserve focus when practical but do not make focus a completion gate; draft, anchor and one stream are the contract.
  4. Keep the existing sheet-close-on-wide and stored column-width behavior.
- **Test scenarios**:
  - Type an unsent draft, set a measurable scroll anchor, cross narrow→wide→narrow; the draft and anchor survive both directions.
  - A live turn receives events across both crossings with one EventSource/fetch subscription and one rendered assistant sequence.
  - Sending after a crossing clears only the sent draft and uses the same chat URL; stop still targets the live run.
  - Empty chat and blocked localStorage keep today's layout and do not throw.
- **Verification**: `web/src/pages/plane.test.ts` and any touched composable test by path; scoped web TypeScript; prettier; specs and hygiene; CI full verify. Attach before/after captures only if the implementation changes visible layout; pure state preservation needs no screenshot.

### U6. A configured abridge preserves `sol` and names failures

- **Goal**: prove through runner-accessible behavior that the configured meat model is honored and that a failure points to the setting that controls it.
- **Requirements**: R12, R13; configuration-only change [#2096](https://github.com/coreplanelabs/switchboard/pull/2096); update the unit-proof rows in `docs/reference/specs/reading-diff.md`.
- **Dependencies**: none.
- **Files**: `src/core/reviewAbridge.ts` / `.test.ts`, `src/core/meatProcess.ts` / `.test.ts`, `src/core/commands/review.ts` / `.test.ts`, panel action tests only if failure projection changes, and `reading-diff.md`. No production config file in this repository.
- **Approach**:
  1. Start with a failing command/process test that supplies configured `sol` without an override and observes the model passed to meat, the stored artifact metadata and the selected reading-diff panel state.
  2. Trace failures through the same path, preserve the exact safe cause, and make the stored/user-visible reason name `review.readingDiff.meatModel=sol`; never substitute a fallback model.
  3. Unit-test command construction and stored failure projection with `sol`, including quoting as one inert argument and the intentional explicit-override path.
  4. Bind the reading-diff spec rows to those repository tests. The unit ends after its changed-set gates, review and CI; it does not invoke a deployed command.
- **Test scenarios**:
  - Configured `sol`, no override: the meat process receives one `-model sol`; done artifact/model is `sol`, and the panel selects the reading diff.
  - Explicit `--model other` remains an intentional one-call override and names `other`; no argument/config names `review.readingDiff.meatModel` in the failure.
  - Process nonzero, malformed JSON and provider refusal each store a redacted reason that includes `review.readingDiff.meatModel=sol` and the underlying class; secrets never appear.
  - A command-level fixture starts from a finished review with a non-empty git artifact, completes an abridge with the injected meat process and exposes the stored `sol` artifact through the panel projection.
- **Verification**: touched reading-diff/process/command/web tests by exact path; scoped root/web TypeScript as touched; prettier; specs and hygiene; CI full verify.

### Post-plan U6 operational receipt (outside the unattended contract)

After U1–U10 complete, a production operator who already has deployed command access may run `review abridge <real finished review run id> --wait` without `--model`, verify that the stored meat artifact and selected Reading diff name `sol`, and post the run, pull request, deployed head and artifact facts to [#225](https://github.com/coreplanelabs/switchboard/issues/225). This is an operational confirmation only: it is not a unit, dependency, merge gate or definition-of-done criterion, and missing production access cannot stop or fail the plan runner.

### U7. The hosted ship request's Slack image reaches the coding child

- **Goal**: persist the initial accepted image once and feed it through the coordinator's existing attachment fold into the first coding child.
- **Requirements**: R14, R15; [issue #2102](https://github.com/coreplanelabs/switchboard/issues/2102); update `docs/reference/specs/agent-ship.md`, `thread-admission.md` if its event ownership row changes, and `slack-channel.md` item 5.
- **Dependencies**: none.
- **Files**: `src/core/dispatch/ship.ts`; `src/core/coordinator/handOff.ts` and tests; `src/core/coordinator/contract.ts` / `instanceStore.ts` only if the existing event shape needs a seed marker; `src/channels/adminCoordinator.ts` and tests for first-spawn consumption; existing attachment staging tests/specs.
- **Approach**:
  1. Reproduce from a ship `IncomingMessage` carrying one tiny PNG and assert the generated coding child's message currently lacks it.
  2. At handoff, convert accepted inline images/documents into the existing `ThreadEventAttachment` shape and append one seed event to the generated unit after its row is durable and before the Workflow starts. Use a stable id/mode so handoff retries do not duplicate it.
  3. Let the first coding spawn's existing `foldThreadAttachments` produce `IncomingMessage.images/documents`; mark the seed consumed only after the child registers, exactly like a thread follow-up.
  4. Do not seed review spawns. A later coding spawn sees no consumed seed; an over-cap seed keeps the existing dropped count and a prompt note.
- **Test scenarios**:
  - Slack ship ask with one PNG → handoff instance/unit event → first coding dispatch carries the same media type/data → staging writes `/workspace/attachments/0-<name>` and the prompt/asset catalogue names it.
  - A replayed handoff or spawn creates no duplicate event/file; review spawn gets none; round-two coding gets none after successful consumption.
  - Spawn failure before registration leaves the event unconsumed so retry still carries it.
  - Unsupported/over-cap attachment is named as skipped/dropped, never silently absent; a ship ask without attachments is byte-equivalent.
- **Verification**: handoff, coordinator spawn/instance and staging tests by exact path; scoped root TypeScript; prettier; specs and hygiene; CI full verify.

### U8. Seeded sandbox image carries ripgrep

- **Goal**: make `rg` an image invariant for seeded and fresh cloud sandboxes.
- **Requirements**: R16; [issue #2103](https://github.com/coreplanelabs/switchboard/issues/2103); update `docs/reference/specs/execution.md` seeded-image row.
- **Dependencies**: none.
- **Files**: `deploy/cloudflare-sandbox/Dockerfile`; `src/deploy/sandboxDocker.test.ts` or `src/deploy/imageToolchain.test.ts`; `src/execution/seedPlan.test.ts` only if that is where seeded-image tools remain bound; `execution.md`.
- **Approach**:
  1. Add `ripgrep` to the existing deterministic apt install layer and `command -v rg` beside the other build-time probes.
  2. Extend the image static test to require both package and probe and to reject a download-at-runtime substitute.
  3. State in the spec that seed restore changes disk contents, not image tools; both sandbox paths inherit the same binary.
- **Test scenarios**:
  - Dockerfile package extraction includes `ripgrep`; the build layer contains `command -v rg` after install and before cleanup.
  - Static image/toolchain tests still pin Node, git, gh, squashfs and the sandbox base; no package is removed.
  - The seeded-sandbox contract test names `rg` as image-provided, not downloaded by the agent.
- **Verification**: exact image/static tests by path; prettier on changed TypeScript/Markdown; specs and hygiene; no local Docker build (CI's image gate owns it) unless the environment explicitly provides Docker; CI full verify/image build.

### U9. Provider-up steer is delivered to the live run immediately

- **Goal**: close the latency gap left by #2091: a provider-up decision wakes the held turn through the live inbox, not only the durable row a reclaim later reads.
- **Requirements**: R17, R18; [issue #2079](https://github.com/coreplanelabs/switchboard/issues/2079) and merged [#2091](https://github.com/coreplanelabs/switchboard/pull/2091); update `docs/reference/specs/orchestration-plane.md`, `run-history.md` inbox item 40 and `model-proxy.md` item 12a.
- **Dependencies**: none.
- **Files**: `src/core/plane/decide.ts` / `.test.ts`; `deploy/cloudflare-memory/worker.ts` / `runLedger.test.ts`; `src/channels/planeEffects.ts` / tests; `src/core/runLedger/writeThrough.ts` / `.test.ts`; `src/index.ts` effect executor; pi harness integration test and the three specs.
- **Approach**:
  1. Extend the closed plane effect union with a steer carrying effect id, run id, durable inbox sequence and typed message. A provider-up decision emits it beside the inbox push in the same transaction and stores it in `plane_effects`.
  2. Return/push steer effects through the existing service-binding route and heartbeat fallback. The bot executor delivers only to a registry run it owns, using the sequence to suppress a duplicate; no durable write is repeated.
  3. Ack `done` only after local inbox delivery, `skipped` when the sequence is already consumed, and `deferred` while draining or when this generation does not own the run. Deferred effects remain offered.
  4. Drive the real pi harness hold in an integration test: park, provider-up, pushed effect, inbox drain, one reissue at settle. Reclaim remains a fallback, not the normal wake.
- **Test scenarios**:
  - Provider down + parked live run + provider up writes one durable inbox row and one offered steer atomically; failed transaction writes neither.
  - Owning active generation receives the push and the harness reissues before any reclaim/heartbeat; effect ack is done.
  - Push to draining/non-owner generation defers; owner heartbeat later delivers and acks. Push failure leaves the offer and durable row intact.
  - Duplicate push/heartbeat/reclaim of the same sequence causes one harness reissue; a sealed run produces no steer.
  - Existing admit/probe effects and queued `provider_up` admission behavior stay unchanged.
- **Verification**: plane decider, Worker ledger, plane-effects, write-through and focused pi harness tests by exact path; scoped root and Worker TypeScript; prettier; specs and hygiene; CI full verify.

### U10. A whole-process restart death expires at read-record

- **Goal**: bound the one restart gap #2092 could not observe in-process, without shortening a legitimate successor claim.
- **Requirements**: R19, R20; [issue #2081](https://github.com/coreplanelabs/switchboard/issues/2081) and merged [#2092](https://github.com/coreplanelabs/switchboard/pull/2092); update `docs/reference/specs/run-history.md` item 47a and `agent-ship.md` item 15.
- **Dependencies**: none.
- **Files**: `src/core/budgets.ts`; `src/core/dispatch/admission.ts` / `reattach.ts` and tests if an explicit deadline is persisted; `src/core/runRecord.ts` / tests for normalization; `src/channels/adminCoordinator.ts` / `.test.ts`; coordinator driver test for the resulting ending; the two specs.
- **Approach**:
  1. Add a central restart-claim grace duration and persist `restartUntil` on a `restarting` close, or derive it from an unambiguous persisted close stamp if the record schema already guarantees one. Older restarting records without the field retain today's behavior unless a safe derivation exists.
  2. In `read-record`, search for a live/restarted successor first. Only with none: before the deadline answer running; at/after it answer the original record as interrupted with `restarting` suppressed in the projection and its existing interruption cause.
  3. Keep `recordRestartDeath` as the eager correction when the process survives. Do not mutate the store from the read unless the existing writer seam makes that idempotent and tested; the runner needs a truthful answer, not a timer.
  4. Pin boundary equality and clock skew behavior with the injected clock and central constant.
- **Test scenarios**:
  - Restarting record, no successor, one millisecond before deadline → running; exactly at and after → interrupted with original cause, never `wall_clock_cap`.
  - Successor row exists before the deadline or appears before a later read after it → `restartedAs`/live wins.
  - In-process restart death still drops `restarting` immediately through `restart_died`; normal same-id restart remains running/completes.
  - A whole-process death simulation writes only the restarting record, constructs fresh read-side dependencies and advances the clock; the fresh process ends the unit on the interruption note.
  - Legacy record without a deadline follows the documented compatibility rule; malformed/future deadlines fail closed without hiding a live successor.
- **Verification**: reattach/admission/run-record/admin-coordinator/driver tests touched by exact path; scoped root TypeScript; prettier; specs and hygiene; CI full verify.

---

## Verification Contract

| Proof | Command or procedure | Units |
|---|---|---|
| Behavior tests red then green, scoped to touched files | `npx vitest run <each touched test file by exact path>` — never `--changed`, never a directory | U1–U10 |
| Scoped TypeScript | `NODE_OPTIONS=--max-old-space-size=6144 npx tsc --noEmit -p <touched tsconfig>` | U1–U10 as applicable |
| Changed files are formatted | `npx prettier --check <changed files>` | U1–U10 |
| Spec proof paths/titles resolve | `npm run specs:check` | U1–U10 |
| Public tree gains no imprint | `npm run hygiene:check` | U1–U10 |
| Changelog title is valid | `npm run check:pr-title -- "<unit pull request title>"` | U1–U10 |
| Derived command docs stay current | `npm run docs:gen` followed by `npm run docs:check` only when a command definition/surface changes | U2, U6 if applicable |
| Package behavior and emitted dependency closure | package bin/build/smoke tests; run the emitted-import assertion against the temporary build | U4 |
| Web state and one-subscription behavior | focused composable/home/plane tests; browser capture only for a visible layout change | U3, U5 |
| Sandbox binary in the built image | Dockerfile/static image test locally; CI's image-build gate is authoritative because the agent has no Docker | U8 |
| Plane live delivery | provider-up integration reaches the pi hold through `/plane/effects` before reclaim and reissues once | U9 |
| Fresh-process deadline | read a persisted restarting record through fresh dependencies before/at/after the deadline | U10 |
| Whole gate | CI runs the full suites, full typecheck, image/package builds and `npm run verify` after each pushed unit head | U1–U10 |

For every unit, the coding child pushes after the changed-set gates, the runner waits on CI, and any fix is a further commit and push after rebasing onto the current base. A local full suite, full typecheck or `npm run verify` is not a unit criterion; those are CI's gate.

---

## Definition of Done

- Ten independently reviewable pull requests have merged in U1–U10 order under the runner's merge grant; each carries only its unit and the living spec/proofs it changes.
- Every issue's user-visible failure is pinned by a test that failed before the fix, and no existing fallback or guard was weakened.
- U6's repository tests prove configured `sol` reaches meat, labels the stored artifact and names the controlling key on failure; U8's CI image build contains `rg`; U9 wakes a held live turn without reclaim; U10 attributes the whole-process gap to the recorded interruption before the unit wall clock.
- The checkout and published CLI forms are unambiguous in code and docs, and the emitted package imports only declared dependencies.
- Public hygiene, spec bindings, scoped formatting/types/tests and title checks pass on every unit; CI's full verification is green at every merged head.
