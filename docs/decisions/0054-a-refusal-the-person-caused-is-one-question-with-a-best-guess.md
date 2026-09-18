---
title: A refusal the person caused is one question with a best guess; the button and the next message both answer it; every refusal has exactly one way to exist
status: proposed
date: 2026-09-17
pattern: One typed outcome for every refusal, rendered in one place, fenced structurally; the cause decides whether the bot asks or reports; an answer re-dispatches a request, and only a button showing the line runs a write
---

# A refusal the person caused is one question with a best guess; the button and the next message both answer it; every refusal has exactly one way to exist

**The ask.** Decide (the maintainer, before the plan is written): adopt one seam for every refusal the bot makes, with the cause deciding the reply. A refusal caused by what the person said becomes one question carrying the bot's best guess, answered by a button or by the next message in the thread; a refusal caused by who they are keeps the way forward; a refusal caused by the system stays an error. Reader: an engineer who knows the dispatcher's stages and has not read the refusal sites. The frame is the maintainer's and a colleague's, 2026-09-17: "the pattern is clear: it takes the request and builds the full command; if it's confident it executes, if not it asks for clarification"; "can we make this happen any time we would fail or warn because we can't understand the prompt"; "collapse our code such that there is only one way for producers to exist, so this isn't something we are chasing as we add new functionality"; and the button is good, but the person "should also be able to type a follow-up, basically yes-but or no-but".

Success criteria: (1) every refusal the bot makes carries a code and a cause, and a refusal written outside the seam fails `verify` by file and line; (2) a request-caused refusal never ends the conversation: it asks one question with the best guess the bot can make from a list it holds, and the person's next click or next message answers it; (3) a write runs only from a button that shows its exact line: Yes on the question is such a button, a typed yes is not, so an accepted proposal enters the front door as a routed request and a write in it meets [record 0044](0044-a-routed-write-is-confirmed-in-proportion-to-its-blast-radius.md)'s offer, while an answer with changes shows a new question; (4) a system-caused refusal never grows a Yes button; (5) the trace's two failures become one question.

The decision comes in two cuts, and the maintainer may take the smaller: the **full bundle** (the seam and its fence, the guesses, the button, the typed answer, the router's own question), or the **seam cut** (the seam, the fence, the counting, and the repository guesses that fix the trace), deferring the typed answer and the router's question until the count from the first unit says how often people hit a request-caused refusal. The words ship, in either cut, only behind the replay row that measures the router reading answers.

## TL;DR

The bet: one type and one renderer for every refusal, with the cause deciding whether the bot asks or reports, so a refusal the person caused becomes a question with a best guess instead of a dead end, and no rule of 0039 or 0044 bends because an answer re-enters the door as a request rather than running anything. Today the bot refuses through 19 mechanisms across 71 inventory rows, one of them a question; on 2026-09-17 one typo (`acme/infra` for `acme/infrastructure`) cost two dead ends although two lists in the codebase named the right repository and neither is read where the refusals fire. The design is a `Refusal` object (cause, code, the sentence, an optional guess holding the corrected request and its evidence), produced from every layer, rendered in one place and fenced by a lint rule that forbids replying or throwing to the person in the producing modules; Yes and No ride 0044's confirmation store under a second row kind, and the next typed message is read against the question by the router the thread already pays for, with no keyword. The cost is one migration of 19 mechanisms, one more registry call at the repository gate, a cancel-by-thread on the store and a marker in the bot's own question. Decided: the seam, the fence, the three causes, the two answer paths, deterministic guesses before model guesses, and no write without a button; open: how close a near match must be, whether a policy refusal may carry a guess, and how long the button lives; unknown, and counted by the first plan unit: how often people hit a request-caused refusal at all.

## Today at `64d8b7ee`

The delta from what a veteran expects; the appendix has the groups.

| You would expect | What is true | Proof |
|---|---|---|
| One way to refuse | 19 mechanisms: `refuse(code)` spans with ad-hoc `io.reply` prose (17 call sites, 16 codes), bare `io.reply` with no span, a ship preflight result, plan hand-off prose, `chatErrorLine` over `CommandError` (96 throw sites under the command handlers), grammar rejections and registry codes, thrown `Error`s caught into `⚠️ <message>`, resident JSON errors, a tool result the model paraphrases, four transport shapes | [`src/core/dispatch/authorize.ts`](../../src/core/dispatch/authorize.ts), [`src/core/coordinator/handOff.ts`](../../src/core/coordinator/handOff.ts), [`src/core/commandChat.ts`](../../src/core/commandChat.ts) `chatErrorLine`, [`src/core/dispatch/reply.ts`](../../src/core/dispatch/reply.ts) `errorReply` |
| The bot asks when it cannot proceed | One refusal is a question, "Which branch of `<repo>` should this thread work on?"; the answer is read from the next message's own text. Record 0044's offer is the other question the bot asks. Every other refusal ends the turn; eight reasons for not reading a linked thread collapse into "I can't read that thread." | [`src/core/dispatch/provision.ts`](../../src/core/dispatch/provision.ts); [`src/core/dispatch/references.ts`](../../src/core/dispatch/references.ts) `REFERENCE_REFUSAL` |
| A typo in a name gets a "did you mean" | The resident list is read only for a bare repository name and only for an exact match; for `owner/name` the gate holds the rejected slug alone. The GitHub App installation's repository list exists as `listRepos()` and is called by one model tool, never by the gate or by `repo onboard` before it mints a token. MCP server names, presets, cost groups, options: each site holds the list it could match against | [`src/core/repoContext.ts`](../../src/core/repoContext.ts) `resolveAddressed`; [`src/execution/githubApi.ts`](../../src/execution/githubApi.ts) `listRepos`; [`src/tools/github.ts`](../../src/tools/github.ts); [`src/core/commands/repo.ts`](../../src/core/commands/repo.ts) |
| The next message can answer a refusal | No pending-question state exists. A run refused at a gate writes no record and is invisible to the thread's sticky logic. The bot's replies do come back in the thread history as assistant turns, with no marker. What exists: the confirmation store (one row per thread, keyed by offer id, consumed by a click) and the paste check, which reads the thread's newest command record before a typed command runs | [`src/core/dispatch/thread.ts`](../../src/core/dispatch/thread.ts) `continuable`; [`src/channels/slack/threadTurns.ts`](../../src/channels/slack/threadTurns.ts); [`src/core/confirmations.ts`](../../src/core/confirmations.ts); [`src/core/dispatch/fastPath.ts`](../../src/core/dispatch/fastPath.ts) `pastedRoute` |
| The router says when it is unsure | It binds anyway: on the replay of 2026-09-17 (37 commands, a later set than 0044's 33) two write asks bound a placeholder string as a server name, which nothing checks, and 15 of 37 questions about a subject bound the subject's read command; the verifier, run on the replay only, rejected 8 of 26 correct binds because it judged wording without the command's description | the replay receipt on the receipts tracker (#234), 21:55Z |

Nobody can say how often a person hits a request-caused refusal: a gate refusal writes no run. The seam's spans make it countable, and counting is the plan's first unit.

## The shape

Think of HTTP's status classes applied to a conversation: every reply that is not the work has a class, and the class decides what the client does next. Here the classes are three causes and the client is the person. The closest known system is a shell's command-not-found handler offering "did you mean `git status`?" with a yes prompt; the one way this differs is that the yes is also a message in a thread, read by the router that reads every message, so "yes, but on the staging branch" is one turn, not a menu.

Four pieces:

1. **The refusal.** One type, `Refusal = { cause: "request" | "policy" | "system"; code; text; guess?; wayForward? }`, where `guess = { proposal: IncomingMessage; line: string; evidence: string }`: the proposal is the person's request corrected, the line is what they see, the evidence is why ("one edit from `acme/infrastructure`, which is onboarded"). Every producing layer returns one, or throws `RefusalError` carrying one. The `refuse(code)` span the gates already emit becomes the seam's entry; the registry's `CommandError` codes get a cause each and flow through unchanged.
2. **The renderer.** One function in the dispatcher's reply module turns a `Refusal` into the reply and the card line, and is the only caller of the channel's `offer`. `request`: the question, the line as code, the evidence, Yes and No, and a marker the reader below recognises; without a guess, the question and what the bot needs. `policy`: the refusal and the way forward. `system`: the error and the way forward. Every one of today's sentences survives the migration; only its author changes.
3. **The fence.** A lint rule, `no-raw-refusal`, in the shape of `no-raw-env`: in the stage, preflight, hand-off and command handler modules, `io.reply(` and `throw new Error(` are forbidden outright; those modules return outcomes and the dispatcher speaks. The allowed forms are a returned `Refusal`, `RefusalError` and `CommandError`. The dispatcher's catch-all renders anything else as `system`/`uncaught`, and a test counts uncaught refusals over the fixtures so a new one is a visible change. The rule is structural, not textual: it reads the call, never the sentence.
4. **The answer.** Yes rides 0044's confirmation row with a second kind, `redispatch`, whose consume hands the stored proposal to `dispatch()` as the requester, the way 0044's consume hands over its stored message; the click's requester check, ten-minute life and one row per thread hold. Words ride the thread: the router's user turn already carries the thread's repository; it gains the pending question when the thread's last bot turn carries the renderer's marker, and the router may answer `accept`, `amend` or `decline`. `accept` dispatches the same proposal and cancels the row by thread. `amend` never runs anything: it renders a new question with the amended proposal. `decline` routes the message fresh. One rule for what runs: a write runs only from a button that shows its exact line. Yes is that button, since the question shows the line, so a Yes on a write starts it as 0044's Run does. A typed `accept` is a model's reading, not a button, so the door treats the proposal as routed whatever its shape: a read runs with its receipt and a write renders 0044's offer. A misread `accept` can at worst run a read or show an offer.

## One trace: a colleague's ship ask

The case most likely to go wrong is a typo in a name that reaches two layers. This one happened on 2026-09-17 08:27Z.

1. In a channel, a colleague writes `agent:ship in acme/infra the infra repo, change the onboarding link to the new booking page`. The directive names the preset; repository resolution finds `acme/infra` in the text.
2. Today: the resident registry says no such resident; the authorize gate refuses with a paragraph (onboard it, or name it by URL) and closes the card "not started (repo not onboarded)". The person, following the paragraph, runs `repo onboard acme/infra`; the resident Worker tries to mint a repository token, GitHub answers 422, and the reply is a 403 paragraph about installation settings. Two turns, two dead ends, no work.
3. Under this record: the gate, holding only the rejected slug, makes one registry call for the resident list, bounded by the probe's two-second timeout and skipped inside a probe-outage window. The near-match pass finds exactly one resident whose name starts with the typed one, so the gate returns `Refusal { cause: "request", code: "repo_not_onboarded", guess: { proposal: the same message with the slug replaced, line: "agent:ship in acme/infrastructure the infra repo, change …", evidence: "one edit from acme/infrastructure, which is onboarded and warm" } }`.
4. The renderer posts one message: "I don't know `acme/infra`. Did you mean `acme/infrastructure` (onboarded, warm)?", the corrected line as code, the evidence (with the repository's card sentence once the cards land, per the amendment under The guess), Yes and No, and its marker. The row is stored, kind `redispatch`, requester the colleague, ten minutes.
5. The colleague clicks Yes. The intake takes the buttons down, the consume checks the requester and deletes the row, and the corrected message enters `dispatch()` as the colleague: ship starts on `acme/infrastructure`. No: "Cancelled; nothing ran", and the door says what it needs, a repository it knows.
6. Had the colleague typed "yes but on the staging branch", the router receives the question and the proposal as a context line and answers `amend`; the renderer posts a new question with `on staging` in the line, and nothing runs until a plain yes. A typed "yes" answers `accept`; ship is a write and words are not a button, so the door renders 0044's offer with the same line and Run starts it: two clicks where the Yes button took one, the price of a model reading the yes. "no, I meant acme/infra-tools" answers `decline`; that message routes fresh, where the same pass finds a resident or asks again with the candidates.
7. Had no resident shared a prefix or sat within two edits, the gate would ask without a guess: "I don't know `acme/infra`. The onboarded repositories are …; name one, or give the URL to run cold." Still one question.
8. Had the person typed `repo onboard acme/infra` first, the command would read the installation's repository list before minting: not there, one near match, the same question; a repository that exists but the App cannot see answers a `system` refusal with the admin's way forward, the one case the 422 paragraph was ever right about.

The property: a name the bot does not know but can guess costs one question and one yes, by button or by words; a name it cannot guess costs one question that names what it needs; what runs is always the line the person saw, and a write runs only from a button showing it; and two layers producing the same refusal render it the same way, because neither owns a sentence.

## The difficulty map

Ranked by how likely the author is to be wrong, each pointing at its section.

1. Reading the next message as an answer without stealing an unrelated one, and the marker that makes the question findable: [Words as an answer](#words-as-an-answer).
2. The seam and its migration, 19 mechanisms onto one, with a fence that still holds when the next stage is written: [The seam](#the-seam) (most work).
3. Which sites get a deterministic guess, how close is close, and the one new registry call: [The guess](#the-guess).
4. Whether the router can ask instead of bind without asking too often: [The router's own question](#the-routers-own-question).
5. The line between request and system when one symptom has two causes: [The cause](#the-cause).

## Words as an answer

The constraint: the maintainer wants "yes, but…" and "no, but…" to work and nothing may become a keyword; the router is the least reliable component in the inventory; and a refusal leaves no run record, so the reader cannot find the question where the paste check finds a hand-back.

The design: the thread is the memory. The bot's own reply comes back in the thread history as an assistant turn, so the renderer stamps every question with a marker of its own: the first line is `Did you mean:` and the second is the proposal as one code span, and `questionFromThread(history)` recognises exactly that pair in the newest bot turn and nothing else, the way the status-card prefixes are recognised today. It is a marker in the bot's message, not a word the person types; a completion keeps the question's lines above the answer, as 0044's does, and a newer bot turn ends the question's reign whatever it says. The router's user turn gains one context line, `the door asked: …; it proposed: …`, and one tool, `answer { decision: accept | amend | decline; changes? }`. `accept` cancels the thread's pending row and dispatches the proposal, the same message the Yes button gives `dispatch()`, without the button's confirmation: the door treats it as routed, so a write in it renders 0044's offer. `amend` renders a new question. `decline` routes the message as if no question stood. The history read costs nothing new: the dispatcher already fetches it for every routed message.

Invariants: a thread with no marked question has no answer; an answer is read only against the newest question; `accept` and Yes give `dispatch()` the same message, and only Yes carries a confirmation; `amend` never dispatches; the words work after the button expired, because they never needed the row.

Failure modes: the person changes the subject: the router routes it fresh and the question stays until a newer bot turn or its row's expiry. Two people in the thread: the answer is the writer's and the proposal still dispatches as the person who asked, by the requester rule. The router reads a fresh ask as `accept`: the proposal enters the door as routed, so a write shows 0044's offer and a read runs with a receipt naming what ran; the replay's answer row measures this rate before the tool ships, and no measurement of it exists today. Two questions race the store's one row per thread: the later put replaces the earlier, and the reader takes the newest bot turn, so the row and the thread agree.

The alternative it beat is a keyword, ruled out for follow-ups on 2026-09-17 and dead the moment the person adds a clause; and the stateless sentence with no button and no state, which is exactly what a channel without `offer` renders and what the words path already is, so the only state this design adds is the row a click needs for an id.

## The seam

The constraint: a refusal is written today wherever the code notices it cannot proceed, in that file's vocabulary, and the person reads 19 dialects. The maintainer's instruction is structural: one way for a producer to exist, or every new stage adds a twentieth. A fence that reads sentences fails at once, because the gates' refusals are built by named helpers and the same files post ordinary replies.

The design: the type in `src/core/refusal.ts`; the renderer in the dispatcher's reply module, which takes over the door's call to `offer`; the fence as a rule that forbids `io.reply` and `throw new Error` in the producing modules, with the dispatcher and the renderer as the allowlisted speakers. Codes are the ones the spans and audit lines carry already, so nothing that reads them changes; where one code hides eight causes, it splits, and the consumers of the old code are named in the plan. The catch-all is the last line: an uncaught throw renders as `system`/`uncaught` with its message, redacted as today.

Migration order, since the seam is real only once the dialects are gone: the 17 `refuse(code)` gates (their codes exist, the prose moves), the bare `io.reply` sites and the silent coordinator refusal, the preflight's nine and the hand-off's fifteen sentences, the thrown `Error`s in directives and resolve, then the cause on each `CommandError` code and on the MCP service's own error shape. The resident Worker's JSON errors stay on the wire and become `Refusal`s where the bot receives them. Behaviour is identical through the migration: the same sentences from one place; questions appear only as guess producers land.

Invariants: every reply that is not the work carries a code and a cause on its span and card; no producing module speaks to the person; a `system` refusal never renders a Yes; a `request` refusal always renders a question; a `Refusal` from two layers renders identically.

Failure modes: a stage that forgets fails lint by file and line; an unexpected throw is still one object; a channel without `offer` renders the question and the line to type.

The alternative it beat is a style guide over 19 mechanisms, which the inventory refutes: the last three stages written each brought their own.

## The guess

The constraint: a wrong guess is worse than none, a model call per refusal would make refusals slow, and the lists that name the right answer are in hand at 25 of the roughly 45 request-caused rows, with one exception that matters: the repository gate, which for `owner/name` holds only the rejected slug.

The design: guesses are deterministic first, one rule, one helper: a unique candidate sharing a prefix with the typed name or within two edits is the guess; several candidates are listed and none proposed; none is a question naming what the bot needs. The lists by site: residents at the authorize gate (one registry call the gate does not make today, skipped when the probe is in an outage window or the profile is cold), the ship preflight and `repo test|build|reconfigure`; the installation's repositories for the cold gate and before `repo onboard` mints; presets for `agent:` and the agent gate; MCP server names in scope; command and option names in the grammar; efforts, providers, cost groups, memory ids, plan paths, ops and refs where each fires. Invariants: a deterministic guess is unique or absent; every guess carries evidence in words; the near-match rule is one function with one threshold, tested on the inventory's real names.

Failure modes: two residents within two edits: both listed, none proposed. A prefix that is a different repository: the exact name wins when present, and a typed name that is itself a resident is never a typo. The registry or the installation list unreachable: the question has no guess, and `repo onboard` proceeds to the mint as today with any 422 rendered as `system`, since the bot could not tell.

**Amendment, 2026-09-18, while proposed: the thread knows its repositories by what they are.** The maintainer added a second kind of list the bot holds. A **repository card** is the slug, one or two sentences of what the repository is, and up to ten keywords, built from the repository's README when the resident is provisioned and again when its default branch refreshes, the two moments that already write the resident's facts, and never at request time; a repository the installation can see but no resident holds gets GitHub's own description as its sentence. Every routed request's user turn carries the cards of the repositories the thread has touched and then the org's residents, so the router can bind a repository from the ask's subject when none is named ("change the onboarding link on the booking page") and every question names a candidate by what it is, not only by its name: the trace's evidence becomes "one edit from `acme/infrastructure`, onboarded and warm: the Terraform and Cloudflare configuration". A repository bound from a card is the router's reading like any other bind: a read runs with its receipt naming the repository, a write meets 0044's offer, and a doubt is a `clarify` whose candidates are cards. The typed answer benefits the same way: "no, the docs one" resolves against the cards, not against names alone. The plan carries this as its repository-cards unit, measured by a replay row over fixtures that name a subject and no repository.

## The router's own question

The constraint: some asks are not typos over a list; they are commands with a piece missing or a bind the bot doubts, and only a model can say what is missing. One way for a refusal to exist does not mean one source of guesses; it means every guess reaches the person through the same field and the same renderer.

The design: the router gains a fourth answer beside a route, a command call and a hand-back: `clarify { question, partial }`, for an ask it recognises as a command with a piece it cannot bind; a placeholder string in a required argument, which nothing checks today, becomes a `clarify` at bind time rather than a bind. The verifier of 0044, given the command's description in its prompt, disagrees into a `clarify` with the bound line as the proposal instead of refusing. A `clarify` is a `Refusal` with `cause: request` and a `guess` whose evidence says "the router's reading", rendered exactly as a deterministic one, and it ships only when the replay's clarify row holds: the checked-in fixtures whose right answer is a question get one, and no fixture whose right answer is a bind gets a question instead.

Invariants: a model guess is a `Refusal` like any other; its evidence names the router; it runs only under the one rule, a button showing its exact line; the placeholder check is at bind time, before any reply.

Failure modes: the router asks when it should have bound: one extra turn, measured by the replay row. It binds a placeholder the check does not recognise: the typed path refuses the argument as it does today, now through the seam.

The alternative it beat is the verifier as a gate, which rejected 8 of 26 correct paraphrases on the replay; as a question, the same disagreement costs one click.

## The cause

The constraint: one symptom can have two causes, and the reply must not guess the cause from the text. GitHub's 422 on a mint means "not in the installation" or "no such repository"; the resident's "not serviceable" means starting or gone.

The design: three causes set by the producer with the fact it has. `request`: a different sentence would work (an unknown name, a missing piece, a question read as a command, a closed PR named as work). `policy`: the person may not (an allowlist, a boundary, a restricted command); the way forward names who can. `system`: the bot or a dependency cannot act now. A producer that cannot tell picks `system` and says so. Where one code hides several causes, it splits: the eight reasons behind "I can't read that thread" become eight codes, four request, four system.

Invariants: the cause is a field the producer sets, never a classification of the sentence; every code has one cause; a `policy` refusal names the grant and who holds it.

The alternative it beat is two causes: folding policy into request puts a Yes on "you are not on the allowlist", which no yes fixes; folding it into system hides that a person can act.

## Why not X

**Why not just fix the repository gate?** One registry call and a "did you mean" at one site would kill both dead ends of the trace, and that is the seam cut's first guess. It is not the decision, because the inventory shows the same shape at about 45 rows and the gate's paragraph was itself once "just fixing one site"; the maintainer's constraint is that the twentieth mechanism cannot be written, and only the seam gives that. The seam cut exists so the gate fix does not wait for the words.

**Why not let the general agent handle anything the door cannot bind?** A run per message, tens of seconds and a card, to resolve a typo a list resolves at once; and the agent's guess is still a guess. The question is one turn and the person decides.

## Boundaries

Not here: the agents' own questions inside a run; the resident Worker's wire errors, which stay JSON and become `Refusal`s at the bot; the web channel's Yes and No, which arrive when it implements `offer`; a confidence number from the router; changing which refusals exist. Policy refusals carry no guess in this record (open question 2). Compatibility: every sentence survives the migration until a guess producer lands for its site; a channel without `offer` sees the question and the line to type; the store's row becomes a discriminated union and every row written before this record still parses; a click that re-dispatches hands the message to `dispatch()` and builds no ending of its own, so the drain counts one run.

## What would change our mind

- That deterministic guesses are right: `decline` against `accept` on the run records after a month; a guess accepted under half the time is removed from that site.
- That the router reads answers without stealing messages: no baseline exists, since the router has never been asked this; the replay's answer row (fixtures with a pending question and a fresh ask, a plain yes, a yes-but, a no-but) is the first measurement, and more than one fresh ask in twenty read as `accept` withdraws the answer tool before it ships.
- That the fence holds: the first stage written after the migration adds no sentence of its own, or the rule widens.
- That people hit request-caused refusals at all: the seam's spans, counted in the first plan unit; if the rate is negligible the guess producers stop after the repository sites.
- Reversibility: the seam is a refactor with identical text; guess producers are additive per site; the answer tool is one router tool; the `redispatch` kind can be refused by the consume.

## Rollout

Seam first, behaviour-identical, with the fence and the count; then the repository guesses, since they fix the trace; then the `redispatch` row, its cancel-by-thread and Yes/No on the existing buttons. The seam cut ends there. The full bundle continues with words as an answer behind the replay's answer row, the router's `clarify` behind its own row, then the remaining guess sites. The plan is the next artifact.

## Open questions

| Question | Owner | Resolved by | Needed before |
|---|---|---|---|
| The near-match threshold: prefix or two edits, and whether `owner/` may be dropped from the typed name | the maintainer | the helper's test table over the inventory's real names; the first week's accept and decline counts | the repository guesses land |
| May a `policy` refusal carry a guess, such as a button that asks the admin for the person? | the maintainer | one week of policy refusals on the records: how many end in an admin acting | the second plan |
| The button's life: ten minutes as 0044 decided, or longer for a question, given the words work regardless | the maintainer | the expired-click count on the records after the row lands | the `redispatch` row lands |

## Validation criteria

Every row is `[gap]` today and names the plan's unit by title.

| Criterion | Proof |
|---|---|
| In the stage, preflight, hand-off and command handler modules an `io.reply` or a `throw new Error` fails lint by file and line; a returned `Refusal`, `RefusalError` or `CommandError` passes; an uncaught throw renders `system`/`uncaught` and is counted; every refusal span carries a code and a cause | `[gap]` the seam unit: the rule's test beside `no-raw-env`'s, `src/core/refusal.test.ts`, `src/core/dispatcher.test.ts` |
| A request refusal renders the question, the line, the evidence, the marker and Yes/No where the channel offers; policy renders the way forward; system renders an error and never a Yes; the renderer is the only caller of `offer` | `[gap]` the seam unit: `src/core/dispatch/reply.test.ts` |
| `acme/infra` against residents holding `acme/infrastructure` yields that one guess; two candidates yield a list and none; an exact resident is never a typo; the gate's registry call is skipped in an outage window; `repo onboard` reads the installation list before minting | `[gap]` the guesses unit: `src/core/nearMatch.test.ts`, `src/core/dispatch/authorize.test.ts`, `src/core/commands/repo.test.ts` |
| Yes on a `redispatch` row hands the stored proposal to `dispatch()` as the requester with one drain slot and runs a write proposal; a typed `accept` gives the same message without the confirmation, cancels the row by thread, runs a read and renders 0044's offer for a write; `amend` renders a new question and dispatches nothing; `decline` routes fresh; a thread without the marker has no answer; two questions in one thread leave one row and one newest marker; old rows still parse | `[gap]` the answer units: `src/core/confirmations.test.ts`, `src/core/dispatch/confirm.test.ts`, `src/core/dispatch/route.test.ts`, `src/core/dispatcher.test.ts` |
| The replay's answer row: over fixtures holding a pending question and a plain yes, a yes-but, a no-but or a fresh ask, the router answers `accept`, `amend`, `decline` or nothing respectively, with at most one fresh ask in twenty read as `accept`; the replay's clarify row: fixtures whose right answer is a question get one and no bind fixture does | `[gap]` the words unit and the router's question unit: `src/load/routeReplay.test.ts` and the replay's checked-in fixtures |
| Live, human-gated: the trace's message on a wrong repository name answers one question with the right repository; Yes starts ship there; "yes but on staging" shows a new question with staging in the line | `[gap]` posted on the receipts tracker |

## Appendix: the inventory at `64d8b7ee`

Seventy-one rows in the inventory of 2026-09-17, grouped; a row may cover several throw sites.

| Group | Rows | Mechanism today | Cause | Guess in hand |
|---|---|---|---|---|
| Dispatch gates (`authorize.ts`, `admission.ts`, `provision.ts`, `reattach.ts`, `ship.ts`) | 16 | `refuse(code)` span + ad-hoc `io.reply` (17 call sites); three bare `io.reply`; one silent | request 7, policy 4, system 5 | presets, boundaries, the live run; residents one call away |
| Ship preflight and plan hand-off (`ship/preflight.ts`, `coordinator/handOff.ts`) | 12 (24 sentences) | typed result with prose; prose on an outcome, no span | request 9, system 3 | the thread's repository and PR, the plan's unit ids, the instance ledger |
| The door and the click (`route.ts`, `confirmations.ts`, `confirm.ts`) | 6 | hand-back line, two constants, receipt + error line + footer, click refusals, one silent fall-through | request 5, system 1 | the bound input, the catalogue |
| Typed commands (`commandChat.ts` over `CommandError`, 96 throw sites under the handlers; `mcp/service.ts`'s own error shape, 46 paths) | 16 | `chatErrorLine` by code | request 12, policy 2, system 2 | the very list being searched, at almost every site |
| Grammar and registry (`commandSurface.ts`, `commandRegistry.ts`, about 15 shapes) | 3 | grammar rejection; registry `fail` | request 3 | the option table, the catalogue |
| Directives and resolve (`directives.ts`, `resolve.ts`) | 3 | thrown `Error` → `⚠️ <message>` | request 3 | the preset, effort and provider lists, already in the message |
| The references step (`references.ts`) | 1 | one constant for eight reasons, bare `io.reply` | mixed (four reasons request, four system) | the reason, already logged |
| The conductor's spawn gates (`spawn.ts`) | 1 (6 sentences) | a tool result the model paraphrases | request | the preset registry, the live count, the budget |
| Executors and the resident Worker (`factory.ts`, `deploy/cloudflare-resident/worker.ts`) | 6 | typed executor errors; JSON `{error, status}` | request 3, system 3 | the command table, the mirror's refs |
| The ship pipeline's own end (`ship/coordinator.ts`) | 1 | `UnitEnding.reason` prose | mixed | — |
| The catch-all and the setup card (`reply.ts`, `dispatcher.ts`) | 2 | `errorReply`; `shell.close({ kind: "setup_failed" })` | mixed | — |
| Transports (`commandHttp.ts`, `http.ts`, `mcp.ts`, `web.ts`) | 4 | status + body | mixed | the catalogue, the thread's platform |

Mechanisms: 19. Clarifying questions among refusals: 1. Request-caused rows: about 45, of which 25 hold the list that names the answer when the refusal fires. The installation's repository list is fetched by one model tool and by nothing that refuses.

## Sources

- The maintainer and a colleague, 2026-09-17, quoted in the ask; the colleague's thread of 2026-09-17 08:27Z (the trace).
- [0044](0044-a-routed-write-is-confirmed-in-proportion-to-its-blast-radius.md) (the confirmation store, the button, the requester rule reused), [0039](0039-the-front-door-writes-nothing-from-prose-and-never-routes-twice.md) (a failed command asks; never a second route), [0036](0036-one-front-door-the-router-offers-every-command-and-ship.md) (the router and its thread-repository line), [0002](0002-dispatcher-is-the-only-orchestrator.md) (the dispatcher renders every reply).
- The refusal inventory of 2026-09-17 at `64d8b7ee`, summarised in the appendix; the correctness review of this record, which corrected its counts.
- The `no-raw-env` lint rule in `eslint.config.mjs` and its test, the fence pattern borrowed.
