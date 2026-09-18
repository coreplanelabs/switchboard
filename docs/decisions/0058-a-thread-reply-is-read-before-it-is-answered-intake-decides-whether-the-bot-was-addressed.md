---
title: A thread reply is read before it is answered; the door may decide it was not addressed, and that verdict survives a restart
status: proposed
date: 2026-09-18
pattern: A two-tier gate (a cheap decision ahead of the expensive loop, the shouldReply pattern) with silence as a legal outcome of the one door; the verdict written first-writer-wins beside the run ledger so a replay reads the decision instead of re-deciding it; the mention as the always-on override
---

# A thread reply is read before it is answered; the door may decide it was not addressed, and that verdict survives a restart

**The ask.** Decide (the maintainer, before the plan is written): a reply without a mention, in a channel thread the bot is part of, is no longer answered by default. The door's one model turn, [record 0057](0057-the-operator-is-the-one-door-a-model-binds-every-chat-input-and-deterministic-code-authorizes-fences-and-executes.md)'s operator, gains a sixth outcome, **silent**: the person was not talking to the bot, so no 👀, no card and no run. Until the operator ships, an **intake** turn built in its shape returns the same verdict at the same place, and folds into the operator when it lands. A mention and a direct message are never gated. The verdict is written durably so a bot restart replays the decision rather than making it again. Reader: an engineer who knows the Slack adapter's trigger rules and the reconnect catch-up and has read record 0057. The maintainer's frame, 2026-09-17: every reply in a thread the bot was once mentioned in makes it chime in, wrong when other people are talking there; require a mention or let a small model decide, always answer a direct mention, and work with the crash-recovery paths built for the Workers and the bot. The maintainer also decided that no rule answers a reply because it came from the requester, who is as likely as anyone to be talking to a colleague in their own thread, and that the default mode is `classify`.

Success criteria: (1) a mention or a direct message always starts a run, in every mode; (2) in the default mode, a reply between two people in a bot thread gets no reaction, no card and no run; (3) a bot restart inside the catch-up window never turns a silent verdict into an answer, nor an addressed one into silence; (4) the behavior is a setting on the existing scopes plus the thread, and `always` restores today byte for byte; (5) every silent verdict is readable somewhere, with its reason; (6) when the operator takes the door, an unmentioned reply costs one model call, not two.

## TL;DR

In the newest 200 runs, 64 of the 166 a person started (39 percent) were replies inside an existing thread, and nothing records whether the person mentioned the bot or was answering a colleague. The bet is that silence is an outcome of the one door: for an unmentioned reply in a bot thread the door's turn may answer `silent`, the verdict is written first-writer-wins on the run ledger before the 👀 fires, and the catch-up after a restart reads the verdict instead of asking again. It costs one fast-model call per unmentioned reply until the operator absorbs it, a read of the thread's runs and of the pending confirmation, and one ledger write; a silent reply is never steered into a live run, which record 0057 and this record together amend in record 0051. Decided: the outcome, its position before the ack, the receipt, the three modes with `classify` default, the mention as the override, the 👀 after the verdict, no code rule that reads the words. Doing nothing keeps every bot thread a place people cannot talk in.

## Today at `3a825757`

The delta from what a veteran expects; every claim names its file.

| You would expect | What is true | Proof |
|---|---|---|
| A bot answers when mentioned | Any reply in a channel thread is handled once the bot has posted in it or been mentioned anywhere in it | [`src/channels/slackTriggers.ts`](../../src/channels/slackTriggers.ts) `classifyMessage`, `threadIncludesBot`; [slack-channel.md](../reference/specs/slack-channel.md) item 1(c) |
| The door can decline to answer | Record 0057's operator returns binds, a steer, an answer, a question or a refusal; every event gets one. The operator is proposed and not built; today's router runs inside `dispatch()`, after the 👀, and is skipped for a thread with a live run | [record 0057](0057-the-operator-is-the-one-door-a-model-binds-every-chat-input-and-deterministic-code-authorizes-fences-and-executes.md) "The shape"; [`src/channels/slack.ts`](../../src/channels/slack.ts) `receiveSlackMessage`; [routing-and-config.md](../reference/specs/routing-and-config.md) item 21 |
| A restart replays from a durable cursor | Slack is the record: each reconnect scans member channels 30 minutes back and re-dispatches every message that would have started a run live and has neither a bot reply after it nor a 👀 under 30 seconds old; an unmentioned reply in a bot thread qualifies | [`src/channels/slackCatchUp.ts`](../../src/channels/slackCatchUp.ts) `findMissed`; slack-channel.md item 7 |
| The thread page is the newest turns | `conversations.replies` with `limit: 50` and no cursor returns the OLDEST 50; the catch-up pages a whole thread but hands `handle()` no thread | slack.ts `threadIfBotInIt`, `onMissed` |
| A reply during a live run is a new request | It is steered into the live run's durable inbox, unconditionally; the harness drains the inbox and never re-reads the thread | [thread-admission.md](../reference/specs/thread-admission.md) items 1 and 5; [record 0051](0051-a-thread-has-one-owner-for-its-life-a-message-is-one-event-in-a-chosen-mode-and-a-pipeline-idles-instead-of-ending.md) criterion 3 |
| The bot knows what it is waiting on | The confirmation store ([record 0044](0044-a-routed-write-is-confirmed-in-proportion-to-its-blast-radius.md)) keeps one row per thread for ten minutes on the config Durable Object, readable by offer id only | [`src/core/confirmations.ts`](../../src/core/confirmations.ts); [`src/core/budgets.ts`](../../src/core/budgets.ts) `CONFIRMATION_TTL_MS` |
| Settings have a thread scope | User, channel and defaults only; `config set` takes `me` or `channel` | [`src/config.ts`](../../src/config.ts) `Scope`; [`src/core/commands/config.ts`](../../src/core/commands/config.ts) |

The number nobody has: how many of those 64 replies mentioned the bot, and how many of the unmentioned ones were for it. The run record keeps the permalink and the thread key, not the mention. The receipt makes both countable.

## The shape

Think of the shouldReply pattern from multiplayer chat bots: a cheap decision on whether to speak at all, ahead of the expensive call. The closest known system is Devin's Slack harness, where silence is the default and a legal exit of the loop. The one way this differs is that the verdict is written durably and first-writer-wins, because our bot is replaced on every deploy and replays Slack from a window rather than from a cursor.

Three pieces:

1. **The gate.** The **mode**, `mention`, `classify` or `always`, decides which unmentioned replies in a bot thread enter the door at all. `always` is today: the reply takes today's path and no verdict exists. `mention` never enters: silent by setting, no model call. `classify`, the default, enters the door for a verdict. A mention, a direct message and a top-level post never pass through the gate; they are the door's as they are today.
2. **The verdict.** The door's turn may answer `silent`. Under record 0057 that is the operator's sixth decision kind, taken from the same turn that binds, steers or answers, so an unmentioned reply costs one call. Until the operator ships, intake is that turn in the operator's shape: one fast-model call in the core, called by the Slack adapter between the redelivery guard and the 👀, with the operator's inputs as far as they exist today: the thread's newest turns each labelled `bot`, `requester` or `person`, the thread's runs (the page the dispatcher reads later, handed on so it is read once), the pending confirmation of the thread, and whether the reply mentions anyone. One forced tool call answers `addressed`, `silent` or `unsure` under the router's 8 second timeout; `unsure`, a timeout and an error are all `silent`. No code reads the words: record 0057 deletes the chat-side readers, so a typed command line, a mention of a colleague and an answer to a pending question are facts in the turn, never rules ahead of it.
3. **The receipt.** Every verdict is one row on the run ledger's Durable Object, keyed by the message's channel and timestamp, written as insert-if-absent with the stored row returned, so two deciders of one message act on one verdict. The live path writes it before the 👀; the catch-up reads it before deciding anything about an unmentioned reply. Once record 0057's thread session exists, a silent reply is also appended to it as an observed turn, because the operator reads the session and never the channel, and a later "the above" may name what a colleague said.

## One trace: silent, then the bot rolls

A release deploys while a team is discussing in a thread the bot reviewed a pull request in an hour ago. Channel `C_BACKEND`, thread `1700000000.000100`, mode `classify`, the operator not yet shipped.

1. At 12:00:00 a teammate replies to the requester, unmentioned: "I'd rather we hold the rollout until the migration is verified."
2. The trigger rules return `handle-if-bot-in-thread`; the thread's one page (12 replies) holds the bot's card from an hour ago and is also its newest turns.
3. The adapter labels the turns, reads the thread's runs and the pending confirmation (none), and calls intake.
4. Intake reads the ledger: no receipt for `C_BACKEND:1700000900.000200`.
5. Intake calls the fast model with the last twelve turns, the message, and the facts `botAskedLast: false`, `liveRun: none`, `replierIsRequester: false`, `botLastSpoke: 3600 s`, `mentionsOther: false`, `pendingConfirmation: none`. The answer: `silent`, "a teammate answering the requester about the rollout".
6. Intake inserts the receipt `{ verdict: silent, reason, mode, model, gen: g41 }`; the insert returns its own row, so `silent` stands. The adapter marks the message seen and sets `intake: silent` on the `slack.receive` span. No 👀, no card, no run.
7. At 12:00:20 the deploy sends SIGTERM to g41. The drain closes the socket; the container exits; g42 boots.
8. At 12:01:10 g42 connects and the catch-up scans `C_BACKEND` 30 minutes back; the thread's `latest_reply` is inside the window, so its replies are paged in full.
9. `findMissed` sees the reply: a person's message, unmentioned, in a bot thread, no bot reply after it, no 👀. Today that is a missed message.
10. The catch-up reads the receipt first: `silent`, by g41. It marks the message seen, counts it under `silenced` on the `slack.catch_up` root, and moves on.
11. Variant: g41 died at step 5 and wrote nothing. g42 finds no receipt and runs the same intake on the paged thread. Slack redelivers the same event live to g42 at that moment; both call the model; the first insert wins and the second decider acts on the stored row. One verdict.
12. Variant: g41's verdict was `addressed` and it died between the receipt and the 👀. g42 reads `addressed`, sees no bot reply after the message, and dispatches it as caught up, without a second model call.

A verdict, once made, is made once. The catch-up re-decides only a message nobody decided, which is the one case where deciding now is right.

## The difficulty map

Ranked by risk of being wrong, each pointing at its section.

1. **The verdict's error rates on our own threads** (most work). A frontier model barely beats the majority baseline on addressee recognition; structural facts in the turn are what make it work, and only a labelled set from our threads says whether it does. "The verdict and its gate".
2. **The receipt against the rule that Slack is the durable record, and its own races.** A silent verdict is invisible in Slack by design, so the one place it can live is the ledger; two deciders in one generation and a write failure decide whether a restart can flip it. "The receipt survives the bot".
3. **What this does to a live run.** Record 0051 says every plain reply is steered; record 0057 makes the steer the door's decision; this record adds an outcome that delivers nothing. "The live run, and what this amends".
4. **The first thread-scoped setting.** "The mode is a setting".

## The verdict and its gate

The constraint is that the question is hard and looks easy. On a 2025 benchmark of addressee recognition in three-party dialogue a frontier model scored 80.9 percent against a majority baseline of 80.1 percent, and only about one turn in five names its addressee explicitly. A prompt that sees only the words will look fine on a demo and be wrong on the case the maintainer described: the requester replying to a colleague in the thread their own run lives in.

So the turn sees structure, not only text. Each of the last twelve turns carries a role, where the requester is the person who started the thread's newest run a person addressed, the read the sticky-agent rule already makes. Beside the turns the call carries six facts computed by code, none of which decides anything alone: whether the bot's last post was a question, whether a run is live in the thread and for how long, whether the replier is that run's requester, how long since the bot last spoke, whether the reply mentions anyone, and whether a confirmation is pending in the thread and on whom. The tool has three answers, and `unsure` is silent, because a person who was ignored can mention the bot and a person who was answered by mistake cannot un-ring the bell. The model is the deployment's fast one, resolved as the router's is, `intake.model`, else `routing.model`, else `defaults.models.general`, through the provider seam the router uses for a call outside a run loop, under the router's 8 seconds. When the operator takes the door these facts join its turn and the tool's `silent` becomes its decision kind; the prompt text moves, the facts and the fixtures do not.

The newest turns are a separate read from the participation check. `conversations.replies` with a limit and no cursor returns the oldest replies, which is what participation needs, since the mention that made the bot part of the thread is old, and the opposite of what the verdict needs. For a thread of 50 replies or fewer the one page is both; past that the adapter fetches the newest page as well, and the catch-up, which pages the whole thread already, hands intake the tail of what it paged. Under record 0057 the thread session replaces this read. Twelve turns is a design choice, revisable on the labelled set.

The gate before the default is trusted is an evaluation on our own threads, a row of the door's replay in the sense record 0057 gives it: a prompt change ships only when the rows hold. The plan's first unit labels at least 150 unmentioned replies from the last 30 days of bot threads in our workspace, stratified three ways (a run live in the thread, a confirmation pending, neither) so the easy cases do not carry the score; the replies and their turns come from the threads themselves, the live-run stratum from the run records' start and end times per thread, and the pending-confirmation stratum from fixtures, since those rows live ten minutes; two people label each reply under one rubric, "a teammate reading the thread would expect the bot to answer this", and a third adjudicates disagreements, so the hard cases stay in. The row publishes two conditional rates on the tracker, so the unknown base rate of addressed replies cannot flatter them: the false-silence rate over the addressed replies and the false-answer rate over the silent ones. The targets, 5 percent and 10 percent, are design choices and are not symmetric: a false silence costs the person one mention, a false answer is the noise this record removes, and the false-silence target is the tighter because that is the failure the person cannot see coming. The code's default is `classify`, the maintainer's decision, on this argument: the noise is the observed problem, and the two defaults fail asymmetrically, since a wrong `classify` costs one mention while a wrong `always` has no recovery at all. The targets gate the release, not the default: a miss changes the prompt, the facts or the model before anything ships. The labelled set stays private; the counts are the receipt.

Invariants: a mention or a direct message never reaches the verdict; `unsure`, a timeout and a provider error are `silent` with a reason naming which; the receipt carries the reason, so every silent verdict reads back with its why; no module under the dispatch or channel directories decides the verdict from the words, which is record 0057's lint rule. Failure mode: a channel finds the verdict too quiet, sets `always`, and is back to today, with the receipts saying which replies were silenced and why.

The alternative this beat is a heuristic gate ahead of the model: a question mark, a second-person pronoun, the requester replying, the bot having spoken recently, a colleague mentioned. Each fires on the requester answering a colleague, the case the maintainer named, and each is a reader record 0057 deletes. The heuristics are facts in the turn, not the decision.

## The receipt survives the bot

The constraint is invariant 6 of the agent guide as the Slack channel spec applies it: no persisted cursor, "was this handled" re-derived from Slack on every reconnect. A silent verdict leaves nothing in Slack, so a reconnect inside the window would re-classify every silent reply in every bot thread, and a model asked twice does not answer twice the same way: a teammate's remark, correctly ignored at 12:00, answered at 12:01 by the next generation.

The design keeps the invariant's purpose and moves its store. The purpose was never "Slack only"; it was "nothing in the ephemeral container". The run history Durable Object already outlives generations and already holds `live_runs` and the durable inbox `run_inbox`, and the catch-up already tells a live card from an orphaned one off a snapshot of its live rows. The receipt adds one table beside those two, `intake_receipts`, keyed by `<channel>:<ts>`, one row per verdict, pruned 24 hours after it was written: the window is 30 minutes, 24 hours covers a 15 minute drain and clock skew, and the survey's rate is about 130 rows a day.

The write is insert-if-absent and returns the stored row, and every decider acts on the returned verdict, not its own. This matters inside one generation, not only across two: the adapter marks the seen-set on every verdict, but only once the verdict is in hand, and the catch-up runs the verdict on a candidate while Slack can redeliver the same event live to the same process, so two calls can be in flight for one message with neither yet marked. Without first-writer-wins the two calls could store one verdict and act on another, and the next reconnect would honour a row that never matched what happened.

The catch-up reads before it decides: the receipt lookup comes first for every unmentioned candidate in a bot thread, only a missing receipt runs the verdict, and a skipped message is marked seen exactly as a handled one is. Both paths call the same function against the same store, so they agree by construction, the way the trigger rules are one module today.

Invariants, stated so a test can check them:

- An unmentioned message with a `silent` receipt is never dispatched by any generation while the receipt exists. An edit that adds a mention is a mention and is handled; the receipt does not gate it.
- A message with an `addressed` receipt, no bot reply after it and no 👀 inside the grace is dispatched by the catch-up without a model call.
- A message with no receipt is decided by exactly the function the live path uses, and the verdict acted on is the one the insert returned.
- In `classify` and `mention` modes, no 👀 precedes the receipt. In `always` mode the verdict and the ledger are never touched.

Failure modes. The write fails on `addressed`: the adapter proceeds, since the 👀 and the card become the receipt within seconds, and the span says `receiptWrite: failed`. The write fails on `silent`: the message stays silent, the span says so, and a restart inside the window may ask the model once more, bounded by one call per reconnect. The read fails in the catch-up: the candidate is undecided, the same bound. The ledger is down entirely: the verdict fails closed to `silent`, reason `intake_error`; a mention and an `always` scope are unaffected, because neither reaches it.

The alternative this beat is re-classifying on replay and accepting the flips. Temperature zero narrows the flip and does not remove it, and the cost of a flip is a late answer in a thread that moved on, the exact failure this record exists to remove.

## The live run, and what this amends

Position. The verdict runs after the redelivery guard, so a duplicate costs no model call; before the 👀 and the file downloads, so silence is silent and a silent reply's attachments are never read. The 👀 fires after the verdict, decided: the delay is the model's latency on unmentioned replies only. Nothing measures it today, and the comparable, the router's call on the same model, is unmeasured in its spec too; the `slack.receive` span carries the verdict's duration from the first deploy, and the 8 second timeout is its ceiling.

**The amendment to record 0051.** Its accepted criterion 3 says a plain reply during a live run is steered, unconditionally, and thread-admission item 1 implements it. Record 0057 already moves that steer into the operator's decision, beside binds and answers; this record adds the one outcome that delivers nothing. Under `classify` a plain unmentioned reply during a live run is steered only when the verdict is `addressed`; a silent one is not delivered to the run, which drains an inbox and not the thread, and reaches the door's memory as an observed turn of the thread session. That is a change to an accepted record and takes the dated re-evaluation the documentation rules require, written in the pull request whose code first changes the steer, this record's plan or 0057's, whichever lands first. The re-evaluation as this record sees it: 0051 was accepted so that what a person says to a thread reaches its owner instead of a fresh route or a by-hand re-issue; the verdict narrows "what a person says to a thread" to what they said to the bot, which is what the owner was meant to receive; the regression to check is whether a reply meant for the owner stops reaching it, and that is the false-silence rate on the labelled set's live-run stratum, with the mention as the recovery; 0051's own measurement, the share of plain replies into owned threads that end in a by-hand re-issue, then counts addressed replies. Nothing 0051 built moves: the owner rule, the modes and the idle unit stay, behind the verdict.

**The pending question.** Record 0044's confirmation and record 0054's question wait on a specific person in a specific thread, and 0057 reads the answer as the operator's `answer` decision, from the pending row in its turn. This record adds nothing ahead of that: the pending row and the person it waits on are facts in the verdict's turn, and a wrong `silent` on a "yes, on staging" is a false silence the live-run and pending strata of the labelled set are there to count. The store needs a pending-by-thread read for this, which 0054 already names as its own cost and 0057's operator needs for the same reason.

The alternative this beat is a code rule for the requester of the live run, which a cold reading of this record proposed as the obvious exemption. The maintainer rejected it: the requester is the person most often talking to a colleague in their own thread, so the rule would answer exactly the case that prompted the record; and record 0057 deletes readers of this kind. The other alternative, letting today's router answer `none`, fails on position: the router runs inside `dispatch()`, after the 👀 and the downloads, and is skipped for a thread with a live run, which is where most unmentioned replies land.

## The mode is a setting

`intake.threadReplies` takes `mention`, `classify` or `always` and lives on the existing scopes, a top-level `intake` block as the defaults layer, the channel, the user, and, new here, the thread. The thread scope exists because "be quiet in this thread" is what a person wants when a discussion outgrows the bot, and record 0051 rules out a typed word in prose for it. The mechanism is `config set thread --intake.threadReplies mention`, a registry command like `config set channel`, bound by the operator from words once it exists, stored in the runtime overrides keyed by the thread key, read by `resolve()` for this setting only, removed by `config clear thread`; a row for a thread nobody writes in again is inert. Precedence is thread, then user, then channel, then defaults; a thread setting beats a user's because it is the scope nearest the conversation it describes. The user scope is the replier's. `always` at the winning scope means the adapter never asks for a verdict: no model call, no receipt, the 👀 as today, and the catch-up reads the same mode from the same config, so it treats the reply exactly as it does now. Under `mention`, the line that turns a thread back on needs a mention, which is what the person asked for when they set it.

Invariant: with `always` at the defaults layer and no narrower setting, every adapter and catch-up test that passes today passes unchanged.

## Why not X

**Why not just require a mention?** A mention-only bot is what Copilot's and Cursor's Slack agents do, and it would silence what our loops depend on: a plain reply that steers a live run (thread-admission item 1), a follow-up that continues a finished run's session without a directive (item 6), and the typed answer records 0054 and 0057 read from the next message. It stays as a mode; the maintainer rejected it as the default.

**Why not wait for the operator?** Its rollout is flagged and long: the seam first, the operator beside the readers, the session key, the cards, the readers leaving shape by shape. The noise is today's. Building the verdict in the operator's shape, with its facts and fixtures, means nothing is thrown away when the operator absorbs it, and the receipt and the gate are needed either way.

**Why not tell the answering model to stay quiet when it is not addressed?** Devin tried the note "only contribute if you are needed" on each message and reports that a model trained to answer questions answers them. By the time our model runs, the 👀 and the card have posted and a workspace has attached; silence after a card is worse than an answer.

**Why not answer only when the bot spoke recently?** Recency is one of the six facts. As the rule it silences the requester coming back to a finished review an hour later and answers the teammate who replied a minute after the card.

**Why not gate only idle threads and leave a live run's steering as 0051 wrote it?** Because the steer is the costlier mistake: a colleague's remark during a coding run is folded into the run as an instruction at its next step, and the steer's own ack line is a reply in the thread. The live-run thread is where the verdict matters most, which is why the amendment is worth its cost.

**Why not wait for the model-driven thread owner that record 0051 names next?** That record decides which owner receives a message the bot handles; this one decides whether the bot handles it. Its gate is a measurement over a hundred owned threads or thirty days, and the noise is today's.

## Boundaries

The verdict governs one message class: an unmentioned reply in a channel thread the bot is part of. It never gates a mention, a direct message, a top-level post, an HTTP or MCP request, or a Linear session, whose events (mention, delegation, follow-up, stop) are addressed to the bot by construction. It does not decide which agent runs, who owns a thread, or whether an addressed message is steered or bound; those stay with the router today and the operator under 0057. Multi-bot arbitration is out of scope while the workspace has one bot. The prompt, the labelled set, the remaining validation rows and the thread page's rendering of silent receipts belong to the plan. No migration: the receipts table is new, and every message older than the window has no receipt and needs none.

## What would change our mind

- **The false-silence rate is above 5 percent on the labelled set.** The prompt, the facts or the model change before the release; the default does not. Measured in the plan's first unit.
- **People read the delayed 👀 as being ignored.** If the first week's `slack.receive` spans show the verdict's p95 above three seconds, the 👀 moves before the verdict and is removed on `silent`, at the cost of a visible flicker.
- **The operator lands first.** Then the plan's verdict unit becomes the `silent` decision kind and its facts inside the operator's turn, and the gate, the receipt, the setting and the replay row ship unchanged.
- **Reversibility.** One release carries the gate, the verdict, the receipts table and its catch-up read, the pending-by-thread read, the setting on four scopes with `config set thread`, the span attributes, the silent-receipt rows on the thread's page and the replay row, behind the mode. `intake: { threadReplies: always }` at the defaults layer restores today with the table idle; a superseding record drops the table by migration.

## Validation criteria

The rows below are the ones whose failure would falsify the record; the plan binds the rest (the facts, the mode's scopes, the page rows).

| Criterion | Proof |
|---|---|
| A mention or a direct message never enters the verdict in any mode; `always` at the defaults layer never calls it or the ledger, and every existing adapter and catch-up test stays green | `[gap]` unit one: `src/channels/slackTriggers.test.ts`, `src/core/intake.test.ts`, the existing suites under the setting |
| No code decides the verdict from the words: the facts are inputs and the lint rule record 0057 names holds over the verdict's module | `[gap]` unit one: the lint rule's own test |
| The receipt insert is first-writer-wins and every decider acts on the returned row; two concurrent deciders of one message produce one verdict and one action | `[gap]` unit one: `src/core/runLedger/inMemory.test.ts`, `src/core/intake.test.ts` |
| The receipt precedes the 👀 in `classify` and `mention`; the verdict sees the newest turns of a thread longer than 50 replies on both paths | `[gap]` unit one: `src/channels/slack.test.ts`, `src/channels/slackCatchUp.test.ts` |
| The catch-up skips a `silent` receipt and marks it seen, dispatches an `addressed` one with no bot reply after it and no 👀 in grace without a model call, and decides a receipt-less one with the same function | `[gap]` unit two: `src/channels/slackCatchUp.test.ts` |
| Record 0051 carries a dated re-evaluation amendment in the pull request that first changes steering | `[gap]` unit one, or 0057's: `decisions:check` on the amended record |
| The labelled set's false-silence rate is at or under 5 percent and false-answer rate at or under 10 percent | `[gap]` unit four: the intake row of the door's replay, counts recorded on the tracker; human-gated labelling |
| Live: a silent verdict followed by a deploy inside the window produces no run from the next generation | `[agent]` stage a reply, roll the bot, read the new generation's `slack.catch_up` line for `silenced: 1`; recorded on the tracker |

## Sources

- The maintainer's frame and decisions, 2026-09-17, in the session that wrote this record; the run sample is the newest 200 runs on the dashboard's list at survey time, 11.5 hours of activity.
- slack-channel.md items 1 and 7; thread-admission.md items 1, 5 and 6; routing-and-config.md items 3 and 21; records [0044](0044-a-routed-write-is-confirmed-in-proportion-to-its-blast-radius.md), [0051](0051-a-thread-has-one-owner-for-its-life-a-message-is-one-event-in-a-chosen-mode-and-a-pipeline-idles-instead-of-ending.md), [0054](0054-a-refusal-the-person-caused-is-one-question-with-a-best-guess.md), [0057](0057-the-operator-is-the-one-door-a-model-binds-every-chat-input-and-deterministic-code-authorizes-fences-and-executes.md).
- Devin, "Devin's Slack Etiquette"; Matt Webb, "Multiplayer AI chat and conversational turn-taking" (the shouldReply pattern); "An LLM Benchmark for Addressee Recognition in Multi-modal Multi-party Dialogue" (2025); Anthropic's Slack app's per-channel "respond automatically" toggle.
