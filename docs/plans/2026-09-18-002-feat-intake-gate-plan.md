---
title: A thread reply is read before it is answered - the gate, the receipt, the catch-up, the thread scope, the replay row - Plan
type: feat
date: 2026-09-18
status: proposed
artifact_contract: ce-unified-plan/v1
artifact_readiness: implementation-ready
product_contract_source: ce-plan-bootstrap
execution: code
extends: ../decisions/0058-a-thread-reply-is-read-before-it-is-answered-intake-decides-whether-the-bot-was-addressed.md
---

# A thread reply is read before it is answered - the gate, the receipt, the catch-up, the thread scope, the replay row - Plan

## Goal Capsule

- **Objective**: Build [record 0058](../decisions/0058-a-thread-reply-is-read-before-it-is-answered-intake-decides-whether-the-bot-was-addressed.md): an unmentioned reply in a channel thread the bot is part of gets a verdict, `addressed` or `silent`, from one cheap model turn ahead of the door, before the 👀; a silent reply gets no reaction, no card and no run; the verdict is claimed once per process and written first-writer-wins on the run ledger so the reconnect catch-up reads it instead of deciding again; the mode is a setting on org, channel, user and a new thread scope, default `classify`, and `always` restores today byte for byte.
- **Authority**: record 0058 (accepted with this plan) over [record 0057](../decisions/0057-the-operator-is-the-one-door-a-model-binds-every-chat-input-and-deterministic-code-authorizes-fences-and-executes.md) (the gate runs ahead of the operator and binds nothing; no code reads chat words to decide; the destructive class over the bound input and the chat-text lint rule are that record's plan's), [record 0051](../decisions/0051-a-thread-has-one-owner-for-its-life-a-message-is-one-event-in-a-chosen-mode-and-a-pipeline-idles-instead-of-ending.md) (amended by U4: an addressed plain reply is steered), [record 0044](../decisions/0044-a-routed-write-is-confirmed-in-proportion-to-its-blast-radius.md) (the confirmation store and the button, reused; its built-in `write` confirm default), [record 0012](../decisions/0012-reconnect-catch-up-as-recovery.md) (Slack stays the record of what was handled; the receipt is the record of what was decided). The living specs named per unit are updated in the unit's pull request.
- **Execution profile**: eight units, each one pull request through the review loop, in dependency order. Tests first in every unit. U1, U2 and U3 are additive and change no behavior: the verdict module and the setting, the receipt store, the pending-by-thread read. U4 is the first visible change and carries the 0051 amendment. U5 makes the catch-up read the receipt. U6 adds the thread scope. U7 renders silent receipts on the thread view. U8 adds the replay row and the live ratio. U1 to U6 are the first release, the one the maintainer's channels run `classify` on with the thread scope as the escape; U7 and U8 follow.
- **Stop conditions**: a unit that cannot pass `npm run verify` within its listed files hands back a deviation. A unit stops and asks if it would: add a reaction, a card or a run for a message whose verdict is `silent`; gate a mention, a direct message or a top-level post; decide a verdict from the words in code (a regex or a keyword over chat text); fire the 👀 before the receipt's write attempt in `classify` or `mention`; silence any message because the ledger is missing or unreachable; decide a message twice in one process; touch the operator, the router's prompt or the sticky rule; flip `config set`'s `destructive` boolean; or check a labelled reply's text into the repository.

---

## Product Contract

### Summary

Today any reply in a channel thread the bot has posted in becomes a run, so a thread the bot was once mentioned in is a place people cannot talk. Record 0058 decides that such a reply is read before it is answered: a cheap gate decides whether the person addressed the bot, silence is a legal outcome, and the verdict survives a bot restart. This plan lands that decision in eight units.

### Problem Frame

In the newest 200 runs at the record's survey, 64 of the 166 a person started were replies inside an existing thread, and nothing records whether the person mentioned the bot or was answering a colleague. The adapter's trigger rules handle every unmentioned reply in a thread the bot is part of; the router runs inside `dispatch()` after the 👀 and is skipped for a live thread; the reconnect catch-up re-dispatches every such reply that shows no bot reply after it and no 👀 under 30 seconds old. Silence therefore has no place to happen and no place to be remembered.

### Prior art, and what each changed here

| Prior art | What it does | What it changed here |
|---|---|---|
| Devin's Slack harness: silence is the default and a legal exit of the loop; a harness gate decides which messages reach the model | A gate ahead of the model, not a note to it | The verdict is its own turn ahead of the door (R1); the answering model is never asked to stay quiet. |
| The shouldReply pattern (Matt Webb, multiplayer chat): a cheap call decides whether to speak, then the expensive call runs | Two tiers | Intake is the cheap tier and never becomes the door (R2); two calls per addressed unmentioned reply is the shape, by design. |
| The 2025 addressee-recognition benchmark: a frontier model at 80.9 percent against an 80.1 percent majority baseline | Text alone is weak | Five facts computed by code enter the turn (R4); the offline set is a smoke test and the live ratio is the gate (R21, R22). |
| Anthropic's Slack app: mention-only with a per-channel "respond automatically" toggle | A per-channel setting | The mode on the existing scopes plus the thread (R9 to R12). |
| Record 0012: Slack is the durable record of what was handled | An external system as the record | The receipt records what was decided, beside the ledger's live rows, because a silent decision leaves nothing in Slack (R13 to R18). |

### Requirements

**The verdict**

- R1. `decideIntake(input, deps)` in `src/core/intake.ts` returns `{ verdict: "addressed" | "silent"; reason: string; source: "model" | "mode" | "error" | "timeout"; receipt: "inserted" | "existing" | "failed" | "absent" }`. Its input is the message, the thread's newest twelve turns each labelled `bot`, `requester` or `person`, and five facts computed by code: `liveRun` (agent and seconds in flight, or none, from the thread's runs page), `replierIsRequester`, `botLastSpokeSeconds`, `mentionsOther`, `pendingConfirmation` (none, or the person it waits on). Its deps are the model seam, the ledger or null, and a clock. It reads the receipt first; on none it makes one forced tool call answering addressed, silent or unsure, then inserts the receipt and returns the stored verdict. `unsure`, a timeout and a provider error are `silent` with `source` naming which. The model is `intake.model`, else `routing.model`, else `defaults.models.general`, through the router's seam (`providerRouteModel`, `RouteModel`, `RoutePrompt`) under `ROUTE_TIMEOUT_MS`; a card without tool choice takes the router's `routing.answer` text contract.
- R2. Intake binds nothing, routes nothing and steers nothing. An `addressed` reply enters `dispatch()` exactly as any message does today, with the thread's runs page handed on through a new `DispatchOptions.thread` so the eight-run page is read once.
- R3. No code under `src/core/intake.ts`, `src/core/dispatch` or `src/channels` decides the verdict from the words: the facts are inputs to the turn. The lint rule that enforces this over chat text is record 0057's plan's; until it lands, review holds the line and the trigger module's `<@…>` entity scan is the one scan allowed, as channel encoding.
- R4. The **requester** is the person (`RunView.userId`) of the thread's newest run a person addressed (the `addressed` predicate in `src/core/dispatch/thread.ts`), whether that run is live, finished or refused; a page with no such run yields no requester. The bot's own turns are the ones whose `user` is the bot's user id; an app's relayed post is a person's turn. A thread whose parent is the bot's own post carries `threadStartedByBot: true` in the facts.
- R5. The turns enter the call inside record 0037's untrusted fence, as a quoted thread does.

**The gate**

- R6. `intake.threadReplies` takes `mention`, `classify` or `always`; the code's default is `classify`. `always` means the adapter never calls intake and never touches the ledger for that reply: today's path byte for byte. `mention` means `silent` with `source: "mode"`, no model call, and a receipt. A mention, a direct message and a top-level post never pass through the gate in any mode.
- R7. Intake runs in `receiveSlackMessage` after `dedupeDelivery` has claimed the message and before the 👀 and the file downloads, only for events whose `trigger` is `thread-follow-up` and whose `intakeDecided` is unset. In `classify` and `mention` the 👀 and the downloads happen only after the verdict is `addressed` and the receipt's write was attempted; on `silent` neither `fetchImages` nor `fetchDocuments` runs.
- R8. The verdict sees the thread's newest turns: for a thread of 50 replies or fewer, the page `threadIfBotInIt` already fetched; past that, a second `conversations.replies` page for the newest turns. The catch-up hands intake the tail of the thread it already paged.

**The setting and its scopes**

- R9. `Scope.intake?: { threadReplies?: IntakeMode }` on user and channel, and a top-level `intake: { threadReplies?, model? }` block as the defaults layer (in `CONFIG_KEYS`, validated by `validateIntake` beside `validateRouting` and by `validateScopeBlocks` on the scopes, by name); `intake.model` is a `<provider>/<model>` ref whose provider the config declares, and a card that supports neither tool choice nor the text contract is refused at load when the effective default mode is `classify`.
- R10. A **thread scope**: `config set thread --intake.threadReplies <mode>` and `config clear thread`, stored as `Overrides.threads[threadKey]` beside `channels` and `users` in the one overrides document (no migration), read by `intakeModeFor(threadKey, userId, channelId)` which consults the thread layer for `intake.threadReplies` only. Precedence: thread, then user, then channel, then defaults. The user scope is the replier's.
- R11. `config set thread` is authorized by `config-scope` rows with `resourceKind: "thread"` carrying the channel scope's grant, so whoever may set the channel may set a thread in it. Its class today is `write`, like every `config set`: `annotations.destructive` is a boolean read from the definition alone, and under record 0044's built-in `write` confirm default a routed `config set` of any scope already shows the button while a typed line runs at once. Record 0057's plan owns the class-over-input predicate under which `scope: thread` and `scope: channel` become destructive and `me` does not; this plan flips no boolean.
- R12. The catch-up reads the same mode from the same config for each candidate, so `always` replies are replayed exactly as today.

**The receipt**

- R13. `RunLedger.recordIntake(key, receipt)` writes one row to `intake_receipts` on the run history Durable Object, keyed by `<channel>:<ts>`, as insert-if-absent, and answers `{ inserted: boolean; stored: IntakeReceipt }`; the row holds `verdict`, `reason`, `source`, `mode`, `model`, `gen`, `threadKey`, `decidedAt`. `RunLedger.readIntake(key)` answers the row or none; `RunLedger.listIntake({ threadKey? , since? })` answers rows for a thread or since an instant. The routes `POST /runs/intake`, `/runs/intake/read` and `/runs/intake/list` carry `storeKey` like every run route; the insert runs inside the object's transaction; the write-through retries a lost response with `RETRY_MS` as the claim does, and the retry reads the same row. The in-memory ledger implements all three with a failure toggle for tests.
- R14. Only the caller whose insert answered `inserted: true` acts on `addressed`; a caller that finds a row already there marks the message seen and takes the stored verdict, which for `addressed` means doing nothing. The seen-set claim in `dedupeDelivery` stays before its first await, asserted by a test.
- R15. Rows are pruned after the larger of 24 hours and the configured catch-up window plus the drain deadline, on the object's alarm.
- R16. Without a ledger the design degrades and never falls silent: when the write or the read fails, or the deployment runs the null ledger, intake calls the model anyway, acts on `addressed` with `receipt: failed` or `absent`, stays silent on `silent`, and the startup log prints `degradedIntakeLine()` once, a pure function.
- R17. Every verdict sets `intake` (`addressed` or `silent`), `intakeSource` and `intakeReceipt` on the `slack.receive` span, three identifier-valued keys in the closed attribute table; the reason is free text and lives on the receipt row and the log line, never on a span.
- R18. `pendingByThread(threadKey)` on the confirmation store answers the unexpired row for a thread, or none, on all three implementations (in-memory, file, Worker) and the ConfigDO route; expiry is checked by the reader.

**The catch-up**

- R19. For every unmentioned candidate in a bot thread that `findMissed` selects, `onMissed` in the adapter reads the receipt before `handle()`: a `silent` row marks the message seen and counts it under `silenced` (a closed attribute) on the `slack.catch_up` root; an `addressed` row with no bot reply after it and no 👀 inside the grace dispatches the message as caught up with `intakeDecided` set, so `receiveSlackMessage` never decides it again; no row runs `decideIntake` on the paged thread's tail and proceeds by its verdict. The seen-set is re-checked after the read, as `onMissed` does today; a live claim that landed between the scan and the act is skipped.
- R20. An edit that adds a mention arrives as a subtype the live path skips and is handled by the catch-up inside the window; a `thread_broadcast` reply and a deleted message never enter either path.

**The replay row and the live ratio**

- R21. `npm run load -- intake --fixtures <path>` replays labelled unmentioned replies through `decideIntake` against a live model and prints the false-silence rate over the addressed replies, the false-answer rate over the silent ones, each with its Wilson interval, the `unsure` and timeout shares, the model ref it ran, and the p50, p95 and p99 of the call. The labelled set lives outside the repository under `load-results/` (already ignored); a small synthetic set for the pending-confirmation stratum and the fail-closed paths is checked in as `src/load/intakeFixtures.ts` and is exercised in CI by `src/load/intakeReplay.test.ts` over a scripted `RouteModel`, since the load op itself needs a provider key.
- R22. `npm run load -- intake --live --since <date>` reads the receipts through `listIntake({ since })` and prints the live false-silence ratio: `silent` receipts followed within ten minutes by a mention from the same person in the same thread, over all `silent` receipts, per week.
- R23. The chat home's thread view (`/threads/<key>`, `src/channels/web.ts`) renders a `silent` receipt as a read-not-answered turn with its reason, from a new turn variant in the seed.

**Specs and records**

- R24. Every unit updates the spec items it changes in its own pull request; the new items take the next free numbers at the time of writing: slack-channel 15, routing-and-config 27, run-history 59, load-harness 20. A bound test title carries no backticks; a spec table cell carries no bare pipe.
- R25. U4 appends the dated re-evaluation section to record 0051, after the section #1740 appended, dated by the merge, containing the word "re-evaluation", covering criteria 1, 3, 4 and 5 as record 0058 words it and the warm-window sentence of the #1740 section ("a plain reply in the window" becomes an addressed one). This plan's pull request flips record 0058 to `accepted` and rebinds its validation rows to the unit ids and test files below.

### Scope Boundaries

- Not here: the operator (record 0057) and its plan, including the chat-text lint rule and the class-over-input predicate; the router's prompt; multi-bot arbitration; any change to which agent runs or who owns a thread; the settings page's rendering of the thread scope (set and cleared by command only).
- Deferred, with owners: appending silent replies to record 0057's thread session once it exists (0057's plan; without it 0057's criterion 2 does not reach a colleague's silenced message); counting in-flight verdicts in the drain's hold (a wasted call, not a correctness hole; a follow-up issue); using the `addressed`-with-no-run row to tighten the catch-up's "bot replied after" mask (a known limit named in the record; a follow-up issue).

---

## Planning Contract

### Key Technical Decisions

- KTD1. **Intake is a core module the Slack adapter calls, not a dispatcher stage, and it owns the receipt.** The dispatcher begins after the 👀 and the downloads; the verdict must precede both. `decideIntake` reads the receipt, calls the model and inserts, so there is one writer and the adapter only acts on what it returns. The adapter labels the page and computes the facts it alone can (mentions, bot turns); the core computes the rest from the runs page and the pending row. Governs R1, R2, R7, R13, R14.
- KTD2. **The model seam is the router's.** `providerRouteModel`, `RouteModel` and the generic `RoutePrompt` already wrap a provider for a forced tool call outside a run loop with the text-answer fallback, and the verifier already reuses them; intake imports them and tests script a `RouteModel`. Governs R1, R21.
- KTD3. **One decider per process by the guard's claim; one verdict across processes by the insert.** `dedupeDelivery` marks the seen-set before its first await, which is why a catch-up dispatch and a live redelivery never both run; the claim stays, and the insert's `inserted` answer covers the cross-process case and a lost claim. A caught-up event carries `intakeDecided` so the live path never decides it twice. Governs R7, R14, R19. (session-settled: user-approved — chosen over marking the seen-set after the verdict: the first draft opened the window it claimed to close.)
- KTD4. **The receipt lives beside `live_runs` on one object, reached through the store key.** `RunHistoryDO` is one object per store key and every `/runs/*` route carries `storeKey`; the insert is atomic inside `transactionSync` like the claim; the retry is the write-through's, not the Worker client's. Governs R13, R15.
- KTD5. **Degrade, never fail closed, when the ledger is missing.** Silence needs a receipt to be stable, not to be safe; an addressed reply needs none. Today a refused durable push still steers in memory; intake matches, and the ledger dep is typed `RunLedger | null` as the wiring already is. Governs R16.
- KTD6. **No code rule reads the words, and the lint rule is 0057's.** The first draft had three rules (typed command, pending confirmation, mentions another person); record 0057 deletes readers of that kind, so they are facts in the turn. The one exception is the mention entity, which is channel encoding the trigger module already scans. Governs R3, R4.
- KTD7. **The thread scope is a third `config set` target in the one overrides document.** `Overrides` already holds channels and users as maps in one stored document behind the file and Worker backings; `threads` is a third map, additive like `org`, so no migration. `resolve()` keeps its shape; `intakeModeFor` reads the thread layer for the one setting, so no other setting gains a scope by accident. Governs R10, R11. (session-settled: user-directed — chosen over a keyword in the thread: record 0051 rules out typed words in prose.)
- KTD8. **The labelled set is a file outside the repository; the checked-in set is synthetic.** Real people's words are forbidden in the tree by public hygiene; the replay takes a path under `load-results/`, CI runs the synthetic set through a scripted model in a vitest test, and only the counts are published. Synthetic ids follow the fixture conventions: users `U_ALICE`, `U_BOB`, `U_BOT`; channels `C_BACKEND`; thread keys `slack:C_BACKEND:1000.000100`; timestamps as Slack numerics; `decidedAt` as epoch milliseconds; repositories `acme/api`. Governs R21. (session-settled: user-directed — the maintainer and the author label, the maintainer adjudicates.)
- KTD9. **The live ratio is a load op over the receipts, not a dashboard.** `listIntake({ since })` lists receipts; the op joins them to the thread's later mentions read from Slack and prints the ratio; a page for it is deferred until the ratio is read weekly. Governs R22.
- KTD10. **The class of `config set thread` is not this plan's to change.** Flipping the definition's boolean would make `config set me` destructive, contradicting 0057's trace; under record 0044's current `write` default a routed call already gets the button. Governs R11.

### High-Level Technical Design

```mermaid
sequenceDiagram
  participant S as Slack
  participant A as adapter (receiveSlackMessage)
  participant I as intake (core)
  participant L as RunHistoryDO
  participant M as fast model
  participant D as dispatch()
  S->>A: unmentioned reply in a bot thread (trigger: thread-follow-up)
  A->>A: dedupeDelivery claims channel:ts (before any await)
  A->>A: mode = intakeModeFor(thread, user, channel)
  alt always
    A->>A: 👀, downloads
    A->>D: as today
  else mention or classify
    A->>A: label the newest 12 turns; read the runs page; read the pending row
    A->>I: decideIntake(input, deps)
    I->>L: readIntake(channel:ts)
    L-->>I: none
    opt classify
      I->>M: forced tool: addressed, silent or unsure (8 s)
      M-->>I: verdict, reason
    end
    I->>L: recordIntake → {inserted, stored}
    I-->>A: stored verdict, source, receipt
    alt addressed and inserted
      A->>A: 👀, downloads
      A->>D: with DispatchOptions.thread handed on
    else silent, or not the inserter
      A->>A: span intake=silent; no 👀, no downloads, no card, no run
    end
  end
```

The catch-up (U5) enters at `readIntake` for each candidate `findMissed` selects: a stored `silent` skips, a stored `addressed` dispatches with `intakeDecided` set, none runs `decideIntake` over the paged tail.

### Sequencing

U1, U2 and U3 are independent and additive; they may land in any order and in parallel. U4 needs all three and is the first visible change; it ships with `classify` as the default and the maintainer's channels set to it. U5 needs U4. U6 needs U1 only and lands beside U4 or U5 so the first release carries the thread escape. U7 needs U2 and U4. U8 needs U1, U2 and U5. The first release is U1 to U6; U7 and U8 follow.

### Risks and Dependencies

- The verdict's latency sits before the 👀 on unmentioned replies; U1 quotes the router's `load -- route` p50 and p95 on the fast model as the estimate, and record 0058 names a 3 second p95 as the line that moves the 👀 earlier.
- The offline labelled set cannot prove a 5 percent rate at 150 rows; the live ratio (U8) is the gate, and it needs U5's receipts in production for two weeks before it says anything.
- Record 0057's plan does not exist yet; two deferrals (the lint rule, the class predicate) depend on it and are named as its rows.
- The chat home's turn seed is one turn per run; a receipt row is a new variant and the page loop changes (U7), a visual change with screenshots.

### Assumptions

- About 130 unmentioned replies a day at the survey's rate; under half a dollar a day on the fast card.
- The maintainer's channels run `classify` from the first deploy of U4; other deployments get `classify` as the code's default.

---

## Implementation Units

### U1. The verdict module and the setting

- **Goal**: `decideIntake` exists with its facts, tool, receipt handling against a ledger or null, and fail-closed rules; `requesterOf` exists; the `intake` block and `Scope.intake` validate; the three span keys are in the closed table; `degradedIntakeLine` exists. Nothing calls intake yet.
- **Requirements**: R1, R3, R4, R5, R9, R16 (the line), R17, R24 (routing-and-config item 27: the `intake` block, the scope field, default `classify`; configuration.md).
- **Dependencies**: none.
- **Files**: `src/core/intake.ts` (new), `src/core/intake.test.ts` (new); `src/core/dispatch/thread.ts` and `src/core/dispatch/thread.test.ts` (`requesterOf(runs)` reusing `addressed`); `src/config.ts`, `src/config/validate.ts`, `src/config.test.ts` (`IntakeMode`, the block, `CONFIG_KEYS`, `validateIntake`, the scope field in `validateScopeBlocks`); `src/core/trace/attrs.ts` and `src/core/trace/streamSpans.test.ts` (`intake`, `intakeSource`, `intakeReceipt`); `docs/reference/specs/routing-and-config.md`, `docs/reference/configuration.md`, `config/config.example.yaml`.
- **Approach**:
  1. Tests first, red: `intake.test.ts` scripts a `RouteModel` (the `scripted` helper in `route.test.ts`) and a minimal ledger double; asserts each tool answer's verdict and source, the three fail-closed paths, the receipt-first read (an existing row short-circuits the model), `inserted` versus `existing`, the null ledger and a throwing ledger as `absent` and `failed` with the model still called, the fence markers around every turn, the requester definition on a page whose newest addressed run is live, refused, a coordinator child, or absent, and the bot-turn rule by user id.
  2. Write `src/core/intake.ts`: the input, deps and output types; the prompt with the turns quoted inside the fence and the facts as a structured block; the forced tool; the model resolution order; the timeout; the read, the call, the insert; `degradedIntakeLine`.
  3. The config: `IntakeMode`, the block, the scope field, validation by name with the routing block's provider check for `intake.model`, and the load-time refusal for a card that supports neither answer shape when the default is `classify`.
  4. The three attribute keys.
  5. Spec rows: routing-and-config item 27; configuration.md.
- **Execution note**: no behavior changes; the diff is additive. Quote the current `load -- route` p50 and p95 for the fast model in the pull request as the latency estimate the record names.
- **Patterns to follow**: `routeRequest`'s model resolution and `providerRouteModel` in `route.ts`; `verifierPrompt` for a second use of the seam; `validateRouting` and `validateScopeBlocks` for the `review` and `ship` blocks; `stickyAgentOf` and `addressed` in `thread.ts`; the `AttrDomain` table in `attrs.ts`.
- **Test scenarios**:
  - `intake.test.ts`: `addressed`, `silent`, `unsure` each map to a verdict with `source: model`; a timeout and a thrown provider error yield `silent` with `source: timeout` and `source: error`; an existing receipt returns its verdict with `receipt: existing` and no model call; a first insert returns `receipt: inserted`; a null ledger returns `receipt: absent` and still calls the model; a throwing ledger returns `receipt: failed` on write and treats a failing read as none; the prompt carries the fence markers around every turn and never a raw turn outside them; `mentionsOther` true and `pendingConfirmation` naming the replier reach the prompt as facts and decide nothing in code; `degradedIntakeLine` names the shape.
  - `thread.test.ts`: `requesterOf` returns the newest addressed run's user when that run is live, finished or refused; skips a coordinator child; returns none on an empty page.
  - `config.test.ts`: an unknown mode is refused by name; `intake.model` with an undeclared provider is refused; a card with neither tool choice nor text under default `classify` is refused; a config without an `intake` block resolves `classify`.
  - `streamSpans.test.ts`: the three keys have a class.
- **Verification**: the test files green, red first; `npm run specs:check`; `npm run build -w docs`; `npm run verify`.

### U2. The receipt store

- **Goal**: the ledger has `recordIntake`, `readIntake` and `listIntake` on all implementations, the Worker has the `intake_receipts` table, the three routes and the prune, and the write-through retries a lost response. Nothing writes a receipt yet.
- **Requirements**: R13, R15, R24 (run-history item 59: the table, the routes, insert-if-absent, the prune, the retry).
- **Dependencies**: none.
- **Files**: `src/core/runLedger/ledger.ts`, `src/core/runLedger/types.ts` (`IntakeReceipt`); `src/core/runLedger/inMemory.ts` and `src/core/runLedger/inMemory.test.ts` (the three methods and a failure toggle); `src/core/runLedger/writeThrough.ts` and its test (the retry with `RETRY_MS`); `src/core/runLedgerWorker.ts` and `src/core/runLedgerWorker.test.ts` (the three posts); `deploy/cloudflare-memory/worker.ts` and `deploy/cloudflare-memory/runLedger.test.ts` (the table, the routes, the prune on the alarm); `docs/reference/specs/run-history.md`.
- **Approach**:
  1. Tests first, red: `inMemory.test.ts` and the Worker test assert two inserts for one key answer `inserted: true` then `false` with the same stored row; `readIntake` before any write answers none; `listIntake` by thread and by since; the prune with both arms of the bound (a 30 minute window keeps rows 24 hours; a two day window keeps them window plus drain); `runLedgerWorker.test.ts` scripts a lost response through `stubWorker` and the write-through's retry reads the stored row.
  2. The interface and types; the in-memory implementation with the toggle; the Worker table and routes inside `transactionSync`; the client posts; the write-through retry.
  3. Spec row: run-history item 59.
- **Patterns to follow**: `decideClaim` in `runLedger/decisions.ts` and the `/runs/claim` route; `live_runs` and `run_inbox` in `worker.ts`; `RETRY_MS` in `writeThrough.ts`; `stubWorker` in `runLedgerWorker.test.ts`; `runDurableObjectAlarm` in the Worker tests.
- **Test scenarios**: first-writer-wins on one key; read-before-write; list by thread and since; both prune arms; the lost-response retry; the toggle makes a write throw and a read throw on demand.
- **Verification**: the test files green, red first; `npm run specs:check`; `npm run build -w docs`; `npm run verify`.

### U3. The pending-by-thread read

- **Goal**: `pendingByThread(threadKey)` on the confirmation store's three implementations and the ConfigDO route, with expiry checked by the reader.
- **Requirements**: R18, R24 (routing-and-config item 25 gains the read).
- **Dependencies**: none.
- **Files**: `src/core/confirmations.ts` and `src/core/confirmations.test.ts` (the interface method on the in-memory, file and Worker stores; the fake route table); `deploy/cloudflare-memory/worker.ts` and `deploy/cloudflare-memory/config.test.ts` (the route over the `confirmations` table's `thread_key` and `expires_at`); `docs/reference/specs/routing-and-config.md`.
- **Approach**: tests first on all three stores (a row inside its ten minutes is returned with the person it waits on; an expired row is none; a thread with no row is none); the method and the route; the spec row.
- **Patterns to follow**: `consume` and `cancel` by id on the three stores; the Worker's `confirmations` routes.
- **Test scenarios**: as above, per store; the Worker route with an expired row present.
- **Verification**: the test files green, red first; `npm run specs:check`; `npm run build -w docs`; `npm run verify`.

### U4. The live path: the gate before the 👀, the seam, the newest turns, and the 0051 amendment

- **Goal**: an unmentioned reply in a bot thread gets its verdict before the 👀; `silent` produces nothing visible and downloads nothing; `addressed` proceeds exactly as today with the runs page handed on; `always` is byte-identical to today; the ledger's absence degrades; the span says what happened; record 0051 carries its dated re-evaluation.
- **Requirements**: R2, R6, R7, R8, R12, R14, R16, R17, R24 (slack-channel item 1(c) rewritten; item 15 for the gate; thread-admission item 1: an addressed plain reply), R25.
- **Dependencies**: U1, U2, U3.
- **Files**: `src/channels/slack.ts` and `src/channels/slack.test.ts` (`SlackEvent.trigger: "mention" | "dm" | "thread-follow-up"` and `intakeDecided?`; `receiveSlackMessage` exported with an injectable deps object carrying `intakeModeFor`, `decideIntake`, the runs service, the confirmation store and the ledger; `handle` passes them; the newest-turns fetch past 50; the labels and the adapter's facts; the 👀 and the downloads under the `addressed` branch for this trigger only); `src/channels/slack/dedupe.ts` and `src/channels/slack/dedupe.test.ts` (a test that the mark precedes the fetch); `src/channels/slack/threadTurns.ts` (no role change: the labeller compares `user` to the bot's user id); `src/core/dispatcher.ts` and `src/core/dispatcher.test.ts` (`DispatchOptions.thread?: RunView[]`, used in place of `readThread` when present); `src/index.ts` (the wiring of the deps and the degraded line at startup); `docs/reference/specs/slack-channel.md`, `docs/reference/specs/thread-admission.md`; `docs/decisions/0051-a-thread-has-one-owner-for-its-life-a-message-is-one-event-in-a-chosen-mode-and-a-pipeline-idles-instead-of-ending.md` (the appended re-evaluation section).
- **Approach**:
  1. Tests first, red, in two steps. First the seam and the golden sequence: export `receiveSlackMessage` with deps, add a call-order recorder on the fake client (the `calls: string[]` shape `handleConfirmClick`'s tests use), and pin today's sequence for a thread follow-up, a mention and a DM (dedupe, `reactions.add`, the delay note when caught up, `fetchImages` and `fetchDocuments`, `dispatch`) as the `always` golden. Then the gate: in `classify` no `reactions.add` and no download before `recordIntake`; none at all on `silent`; `dispatch` once with `thread` on `addressed`; a mention and a DM never call `decideIntake` in any mode; a caught-up event with `intakeDecided` never calls it; `always` matches the golden byte for byte; a thread of 60 replies fetches the newest page; the ledger throwing on write still dispatches an `addressed` reply with `intakeReceipt: failed`; the null ledger yields `absent`; `dedupe.test.ts` asserts the mark lands before the fetch through the injectable `state`.
  2. Wire the adapter: after `dedupeDelivery`, resolve the mode; for `always` fall straight through; otherwise label, compute the adapter's facts, read the runs page and the pending row, call `decideIntake`, act on the stored verdict.
  3. `DispatchOptions.thread` in the dispatcher, used when present.
  4. The startup line where the ledger is wired.
  5. Spec rows: slack-channel item 1(c) becomes "a thread follow-up in a thread the bot participates in, when the gate admits it"; item 15 describes the gate, the position, the modes, the receipt and the degraded shape, bound to the tests above; thread-admission item 1 gains "addressed" with a pointer to item 15.
  6. The 0051 amendment: a `## Amended <merge date>` section appended after the #1740 section, containing the word "re-evaluation", restating why 0051 was accepted, the change (criteria 1 and 3 and the warm-window sentence read "an addressed plain reply"; criterion 4 unchanged for addressed messages with the false-silence cost named; criterion 5's rejected alternative distinguished from a call that routes nothing), and the regression check (the live false-silence ratio with the mention as recovery).
- **Execution note**: the first visible change. The golden `always` sequence is written and green against today's code before any gate code exists. Land with `classify` as the default and set the maintainer's channels to `classify` on deploy; `always` at the defaults layer is the rollback.
- **Patterns to follow**: `receiveSlackMessage`'s ordering comments; `dedupeDelivery`'s claim-before-await and its injectable `state`; `threadIfBotInIt`; `handleConfirmClick`'s call recorder in `slack.test.ts`; the `slack.receive` span attributes; record 0051's `## Amended` section from #1740.
- **Test scenarios**: the golden sequence for three triggers; order of effects per mode; a mention, a DM and a top-level post never reach `decideIntake`; a caught-up event with `intakeDecided` never does; `silent`: no reaction, no downloads, no card, no `dispatch`, the span carries the verdict; `addressed`: one `dispatch` with `thread`, the 👀 after the receipt; a second live delivery of the same event is dropped by the guard with no second model call; not the inserter: a stored `addressed` from another caller yields no action here; degraded: write throws, read throws, null ledger, each with the span value; the startup line printed once when the ledger is null; long thread fetches the newest page, short thread does not; `dedupe.test.ts`: mark before fetch.
- **Verification**: the test files green, red first; `npm run specs:check`; `npm run decisions:check` (the appended section on an accepted record); `npm run build -w docs`; `npm run verify`.

### U5. The catch-up reads the receipt

- **Goal**: a restart never re-decides a decided message: `onMissed` reads the receipt per candidate before `handle()`, skips `silent`, dispatches `addressed` with `intakeDecided`, and decides receipt-less candidates with `decideIntake` over the paged thread's tail.
- **Requirements**: R8 (the catch-up half), R12, R19, R20, R24 (slack-channel item 7: the receipt read before `handle()` and the `silenced` count; item 15's catch-up half).
- **Dependencies**: U4.
- **Files**: `src/channels/slackCatchUp.ts` and `src/channels/slackCatchUp.test.ts` (`MissedMessage` carries the paged thread; `findMissed` stays pure); `src/channels/slack.ts` and `src/channels/slack.test.ts` (`onMissed`: the mode, the seen-set re-check, the receipt read, the verdict, `intakeDecided` on the event; the `slack.catch_up` root gains `silenced`); `src/core/trace/attrs.ts` and `streamSpans.test.ts` (`silenced`); `docs/reference/specs/slack-channel.md`.
- **Approach**:
  1. Tests first, red: the runner over a fixture with three unmentioned candidates in a bot thread: one with a `silent` receipt, one with an `addressed` receipt and no bot reply after it, one with none; assert one skip counted `silenced`, one `handle()` with `intakeDecided` and no model call, one `decideIntake` over the thread's tail; a candidate whose receipt read throws is decided as receipt-less; an `always` thread is dispatched exactly as today with no read; a live claim that landed between the scan and the act is skipped after the read; a thread of 60 replies hands the newest twelve to the verdict.
  2. Thread the paged replies into `MissedMessage`; the read and the verdict in `onMissed`; the attribute.
  3. Spec rows: slack-channel items 7 and 15.
- **Execution note**: `findMissed` stays pure and synchronous; every async step lives in the act phase.
- **Patterns to follow**: `onMissed`'s `wasHandledHere` re-check; `mockClient` with paged `replies` in `slackCatchUp.test.ts`; `withProcessRoot` attrs.
- **Test scenarios**: the three candidates; the throwing read; the `always` thread; the between-scan-and-act claim; the long thread's tail; an edited message now carrying a mention is a candidate through `mentionsBot` regardless of a `silent` receipt; a `thread_broadcast` reply is never a candidate.
- **Verification**: the test files green, red first; `npm run specs:check`; `npm run build -w docs`; `npm run verify`.

### U6. The thread scope and its policy row

- **Goal**: `config set thread --intake.threadReplies <mode>` and `config clear thread` exist, resolve above user and channel for this setting, and are authorized by a `config-scope: thread` row; a routed `config set thread` shows the button under record 0044's current default and a typed line runs.
- **Requirements**: R10, R11, R24 (routing-and-config item 12: the overrides document gains `threads`; command-registry: the third scope target; authorization.md: the row).
- **Dependencies**: U1.
- **Files**: `src/core/commands/config.ts` and `src/core/commands/config.test.ts` (`scope` enum gains `thread`; the target is the caller's thread; `--thread <key>` for a machine surface); `src/config.ts`, `src/config/validate.ts`, `src/config.test.ts` (`Overrides.threads`, `setThreadOverride`, `clearThreadOverride`, `intakeModeFor`, the thread layer in `validateScopeBlocks`); `src/core/authz/policy.ts` and `src/core/authz/policy.test.ts` (the `thread` rows); `src/core/dispatch/confirm.test.ts` (the routed button); `docs/reference/specs/routing-and-config.md`, `docs/reference/specs/command-registry.md`, `docs/reference/specs/authorization.md`, `docs/reference/slack-commands.md` (generated by `docs:gen`).
- **Approach**:
  1. Tests first, red: `config.test.ts` sets a thread mode through `InMemoryOverridesBacking` and `intakeModeFor` resolves it above a user `classify` and a channel `always`; clears it; refuses a bad value by name. `commands/config.test.ts`: `config set thread` from a thread targets that thread; from a machine surface needs `--thread`. `policy.test.ts`: the thread row grants whoever holds the channel's `config:write` and refuses others. `confirm.test.ts`: a routed `config set thread …` is offered as a button; the typed line runs.
  2. The document field, the setters, `intakeModeFor`, the validation; the command; the policy rows.
  3. Spec rows and `npm run docs:gen`.
- **Execution note**: `annotations.destructive` on `config set` stays `false`; the class-over-input predicate is record 0057's plan's row, noted on the command's definition.
- **Patterns to follow**: `setChannelOverride` and the `channel` target in `commands/config.ts`; `InMemoryOverridesBacking` in `config.ts`; the `config-scope/channel` rows in `policy.ts`; the routed `config set channel` cases in `confirm.test.ts`.
- **Test scenarios**: precedence across four scopes; the button on a routed call and none on a typed line; the policy row's grant and refusal; `config clear thread`; an unknown value refused by name.
- **Verification**: the test files green, red first; `npm run docs:gen`; `npm run specs:check`; `npm run build -w docs`; `npm run verify`.

### U7. Silent receipts on the thread view

- **Goal**: the chat home's conversation for a Slack thread shows each `silent` receipt as a read-not-answered turn with its reason, in order among the runs.
- **Requirements**: R23, R24 (live-view.md: the seed's new turn variant; web-chat.md if it owns the home seed).
- **Dependencies**: U2, U4.
- **Files**: `src/channels/webSeed.ts` (a receipt turn variant beside `HomeTurnSeed`); `src/channels/web.ts` and `src/channels/web.test.ts` (`WebChatDeps` gains the ledger; `turnsOf` and `seedFor` interleave receipts by `decidedAt`); `web/src/pages/HomePage.vue`, `web/src/components/home/*`, `web/src/pages/home.test.ts` (the read-not-answered turn); `docs/reference/specs/live-view.md` or `docs/reference/specs/web-chat.md`; the screenshot fixtures (`screenshots:gen`).
- **Approach**: tests first (a thread with two silent receipts seeds two turns in order with their reasons; a thread the viewer cannot see seeds none; a null ledger seeds runs only); the variant, the dep, the interleave; the page; the spec row; before and after screenshots in the pull request.
- **Execution note**: a visual change; `npm run screenshots:check` after the page change, regenerated with `screenshots:gen`.
- **Patterns to follow**: `turnsOf` and `seedFor` in `web.ts`; the home page's turn loop; the seed fixtures in `home.test.ts`.
- **Test scenarios**: zero, one and two receipts; ordering against runs; the viewer without access; the null ledger.
- **Verification**: the test files green, red first; `npm run screenshots:check`; `npm run specs:check`; `npm run build -w docs`; `npm run verify`.

### U8. The replay row and the live ratio

- **Goal**: `npm run load -- intake --fixtures <path>` scores the verdict on a labelled file against a live model and prints both conditional rates with intervals, the abstention shares, the model ref and the latency percentiles; `npm run load -- intake --live --since <date>` prints the live false-silence ratio; the synthetic set runs in CI through a vitest test over a scripted model.
- **Requirements**: R21, R22, R24 (load-harness item 20).
- **Dependencies**: U1, U2, U5.
- **Files**: `src/load/intakeReplay.ts` (new) and `src/load/intakeReplay.test.ts` (new); `src/load/intakeFixtures.ts` (new, synthetic, under the fixture conventions); `scripts/load.ts` (the `intake` op in the usage text, the function and the `commands` map; `--fixtures`, `--live`, `--since`); `src/load/aggregate.ts` (the Wilson interval helper); `docs/reference/specs/load-harness.md`.
- **Approach**:
  1. Tests first, red: `intakeReplay.test.ts` over the synthetic set with a scripted `RouteModel` asserts the two rates, the intervals at a known n, the abstention shares and the model ref line; zero addressed replies prints a stated no-denominator line, not NaN; the live op over an in-memory ledger with two silent receipts, one followed by the same person's mention within ten minutes, prints one half; zero silent receipts prints zero over zero as such.
  2. The op; the fixture file format (one reply per row: the labelled turns, the facts, the label, the stratum); the synthetic set; the default path under `load-results/`.
  3. The live join: `listIntake({ since })`, then `conversations.replies` for each thread's later mentions.
  4. Spec row: load-harness item 20.
- **Execution note**: the labelled file is built by the maintainer and the author outside the repository; the unit ships the tool and the synthetic set, and the first real run's counts are posted on the tracker, never the rows. The op needs a provider key like `load -- route`; CI proves the scoring through the test.
- **Patterns to follow**: `routeReplay.ts` and its test's "checked-in set through a scripted model"; the `route` op in `scripts/load.ts`; `summarize` and `percentile` in `aggregate.ts`; `routeCommandFixtures.ts` for synthetic ids.
- **Test scenarios**: rates and intervals on a known set; no denominator; abstention shares; the model ref line; the live ratio with and without silent receipts; the synthetic set passes `hygiene:check`.
- **Verification**: the test files green, red first; `npm run hygiene:check` on the fixture file; `npm run specs:check`; `npm run build -w docs`; `npm run verify`.

---

## Verification Contract

| Proof | Command or procedure | Units |
|---|---|---|
| Unit tests red before, green after | the unit's named test files | all |
| The whole gate | `npm run verify` | all |
| Spec rows bound to real test titles, no backticks in titles, no bare pipes in cells | `npm run specs:check` | all |
| The docs site builds (every unit edits a spec) | `npm run build -w docs` | all |
| Records valid; the 0051 section is an appended amendment | `npm run decisions:check` | U4 |
| The command table regenerated | `npm run docs:gen` | U6 |
| Visual change with screenshots | `npm run screenshots:check`, `screenshots:gen`, before and after in the pull request | U7 |
| Fixtures pass public hygiene | `npm run hygiene:check` | U8 |
| Title under the cap | `npm run check:pr-title` | all |
| Live: a silent verdict survives a roll | on a staging channel set to `mention` (deterministic `silent` with a receipt, no model), a person types an unmentioned reply in a bot thread; an agent POSTs `/admin/crash` with the `deploy:write` bearer inside the 30 minute window and reads the next generation's `slack.catch_up` line for `silenced: 1` and no run; recorded on the tracker | U5, human-gated half: the reply |
| The measurement receipts | `load -- route` p50 and p95 quoted in U1's pull request; the first `load -- intake` counts and the first weekly live ratio on the tracker | U1, U8 |

## Definition of Done

- Global: all eight units merged; record 0058 `accepted` with its validation rows bound; record 0051 amended; the maintainer's channels running `classify`; the live receipt posted; no dead code from abandoned approaches in the diff.
- U1: the module, setting and keys exist and are covered; nothing calls them.
- U2: the store exists on all implementations with the retry and the prune; nothing writes to it.
- U3: the read exists on all three stores and the route.
- U4: a silent reply in `classify` produces no reaction, download, card or run in production; `always` byte-identical to the golden; the 0051 amendment passes `decisions:check`.
- U5: a receipt-bearing message is never re-decided by the next generation; `silenced` appears on the `slack.catch_up` root.
- U6: `config set thread` works from a thread, resolves above the other scopes, is authorized by its row, and shows the button when routed.
- U7: silent receipts render on the thread view; screenshots in the pull request.
- U8: `load -- intake` and `load -- intake --live` run; the synthetic set runs in CI; the first counts are on the tracker.
