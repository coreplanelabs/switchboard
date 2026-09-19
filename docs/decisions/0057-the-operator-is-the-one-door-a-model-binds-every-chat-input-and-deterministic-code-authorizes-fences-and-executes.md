---
title: The operator is the one door; a model binds every chat input from the thread's session, and deterministic code authorizes, fences and executes but never interprets
status: proposed
date: 2026-09-18
pattern: One interpreter per surface; the typed registry projected into a model's tools; the thread as the memory; determinism at the boundaries (authorization, class over the bound input, fence, execution), judgement in the middle; a replay row as the release gate for every prompt change
---

# The operator is the one door; a model binds every chat input from the thread's session, and deterministic code authorizes, fences and executes but never interprets

**The ask.** Decide (the maintainer, before the refusal-seam plan's third unit lands): adopt one model turn, the **operator**, as the only interpreter of chat input; delete the chat-side parsing it replaces; key the session by thread; let plan units name their own repository. Reader: an engineer who knows the dispatcher's stages and has read records 0036, 0044, 0051 and 0054. The frame is the maintainer's: "every single input goes into a smart operator; there should be zero regexes; I should be able to say 'set my config to blah' or 'do x, y and z' and it knows exactly how to execute across repos; if we can't deliver this promise it won't be used."

Success criteria the decision is judged against:

1. A bullet list of mixed asks in one message, changes in two repositories, one setting and one question, runs to completion from one thread with no line to paste and no directive typed.
2. A follow-up anywhere in a thread's life ("the above", "no, the docs one", "stop") is understood from the thread's own memory, never from a re-read of the channel.
3. No refusal asks the person to restate what the thread already said.
4. The button appears for a destructive act and for nothing else; a personal setting, a pull request, a run of the repository's own checks run on the operator's reading.
5. A prompt or projection change ships only when the replay's rows hold, including a new row for writes bound from prose.

## TL;DR

Nineteen router issues were filed in eight days, five on one day; of the seventeen distinct ones, eight are the model misreading words it saw and seven are a sentence it never saw or a deterministic reader that outranked it, because a directive regex, a grammar parser, a repository token scan and the model router each read a different slice of the request and the deterministic ones win every tie. The bet is one interpreter: the operator binds every chat input into typed calls with every argument filled, reading the thread's session, the registry's projection and repository cards, and code only authorizes the bound call, classes it over its bound input, fences the refusal and executes. It costs one strong-tier model call per event with a capped tail, a replay row for writes that must hold before the button leaves the write class, and the deletion of about 540 lines of chat-only interpretation with their cases moved into fixtures. Decided: the operator, the projection, the thread session, class over the input, the destructive-only button, cards chosen at spawn, per-unit repositories; open: the write bar's number and the event volume the cost rests on. Doing nothing means a rule per miss, of which two landed in the day before this record was written.

**Amendment, 2026-09-18, while proposed: what the adversarial round changed.** Five review arms ran against this record and the code: an invariant attack, a red team, a cost and latency sizing, a capability matrix against the peer tools, and an elegance read. Four things changed. Admission now follows the operator and a thread admits one live run per unit, because today a reply is folded into the live run before any model reads it and the trace could not happen. Every session row carries its author and a bind is authorized as its author, because the log carried only a role and a guest's reply would have steered the requester's run. The fence becomes structure with a lint, because today it is a sentence in the prompt and absent on several paths the operator would read. One identity hole found in the code as it stands, a requester any app can forge through the relay footer or the thread-parent rule, is a dependency before the confirm default moves; a second the red team reported, a resident minting for any requested repository, the correctness pass disproved. The decision has three outcomes, not five: steering a live run and answering the door's question are binds. The operator runs on the strong tier with its tail capped, no fast path exists, and the maintainer's answers close the three open questions below.

**Amendment, 2026-09-18, while proposed: reconciled with record 0060.** [Record 0060](0060-a-ship-pipeline-is-a-live-run-for-its-whole-life-and-runs-on-every-channel-that-can-open-a-thread.md), written the same day, keeps a ship pipeline's parent run live for the pipeline's whole life under a host key so it occupies no thread, and makes every runner post an event on that run. Three sentences of this record pulled the other way and are corrected in the sections below: the trace assumed several live units in one thread, where this record keeps record 0055's thread per unit; the thread occupancy the plan's admission unit was to rebuild into a per-unit index is record 0060's host key instead, and the store's index stays; a unit's report is record 0060's `ship_unit` event and the thread session projects it, never a second copy. Working sessions register by the run's metadata thread key, which closes record 0060's deferral to this record, and a silent reply record 0058's gate withholds from the operator appends to the thread session as the person's turn marked silent. The same "a thread admits one live run per unit" phrasing recurs in the admission-after-the-operator amendment below; it reads by the same corrected mechanism — the store's index, unchanged, not a per-unit index rebuilt by that unit.

## Today at `f8cbe0ba`

Five facts a veteran would not expect. The full survey is the appendix.

| Fact | Value | Proof |
|---|---|---|
| The router sees the request text, one slug derived from the thread, and nothing else of the thread: not its words, the quoted thread, the run records or a description of any repository | `RouteInput` = text (capped at 2,000 characters), sticky directives, presets, allowed, fallback, compound, sources, commands, `threadRepo`, a count of references | `src/core/dispatch/route.ts:260-291`, `:1228-1247` |
| Three deterministic readers run before or inside the router and outrank it | stage A parses a typed command line before history is fetched; a directive or sticky preset skips the router; `structuralRoute` matches an `attach_file` token by regex before the model call | `src/core/dispatcher.ts:392-397`; `src/core/dispatch/route.ts:1175-1179`, `:975-1001` |
| The repository is bound after the router by a 104-line token scan with ten rule families | PR URL, branch keyword, tree URL, repo URL, `in <slug>`, `in <name>` in compose position, `on the <name> repo`, `on <ref>`, `owner/name#N`, bare slug | `src/core/repoContext.ts:275-378` |
| The session is keyed by thread and agent, so a thread has one memory per preset and none for the door | `sessionKey = ${threadKey}:${agent}`; the dispatcher fetches the channel's history on every message | `src/core/runLedger/sessionLog.ts:34-36`; `src/core/dispatch/resolve.ts:70-77` |
| A plan has one repository, a spawn carries no model, and a command's class cannot see its arguments | `CoordinatorInstance.repo` per instance, `CoordinatorUnit` without `repo`; `SpawnRequest` = preset, prompt, repo, budget, ref; `blastRadius(def)` reads the definition alone while `config set` takes a `scope` argument | `src/core/coordinator/contract.ts:162-165`, `:224-270`; `src/core/dispatch/spawn.ts:69-78`; `src/core/commandRegistry.ts:243-247`; `src/core/commands/config.ts:85-86` |

## The shape

The operator is the router grown into the whole front door. Every event on a chat surface, a message, a reply into a live or finished thread, a click, a child run's report, enters one model turn that reads the thread's **session** (the log every run of the thread writes, compacted, with notes and recall), the **projection** (every registry command and every preset rendered as one tool each, derived from the typed definitions) and the **repository cards** (a slug, a sentence and keywords from each repository's README, built when a resident is provisioned or refreshed). It returns one **decision**: a list of **binds**, each one tool call with every argument filled (the command or preset, the repository, the ref, the pull request, the task text), or exactly one **question** carrying its best guess as the full line, or one **refusal** with a cause. Steering the thread's live run and answering a question the door asked earlier are binds too, of the `steer` command and of the proposed line. A decision never mixes binds with a question: when one piece is missing the whole decision is the question. Words addressed to work in flight, naming the unit, its pull request or continuing its subject, bind a steer; words that state a new outcome bind new work; in doubt, the decision is the question. *Amended 2026-09-18:* an unmentioned reply in a channel thread enters the operator only when [record 0058](0058-a-thread-reply-is-read-before-it-is-answered-intake-decides-whether-the-bot-was-addressed.md)'s gate, a cheap turn ahead of the ack that binds nothing, says the person addressed the bot; a silent reply never reaches this turn, and under the flag its verdict is logged beside the operator's so the comparison sees every event. "Every event" above reads "every event the gate admits". Nothing in code reads the sentence. Code authorizes each bound call against the policy table, decides the button by the command's declared class evaluated over the bound input, fences every refusal through record 0054's seam, and executes.

**Amendment, 2026-09-18, while proposed: three outcomes, admission after the operator, three words.** The decision is a list of binds, or exactly one question or refusal; the paragraph above is corrected to say so. A steer is a bind of the registry command `steer` with the live run and the words; an answer is a bind of the line the pending question proposed. Both meet authorization like any bind, which is what gives a steer an owner. The operator runs before admission, not after: today the dispatcher folds any reply into the thread's live run before a model reads it and refuses a second run while one holds the thread, so the operator's decision now names the run an event steers, or none, and a thread admits one live run per unit. Record 0051's owner rule survives as that sentence: the pipeline still owns its unit and idles at its lease; the operator is who delivers the event. Three words are fixed so one noun does one job: a **card** is the message in the thread; a repository's README digest is its **brief**; the model and effort a spawn carries is the child's **tier**. A **boundary** is the end of a child turn: steers fold and tiers change only there. The hand-down rule is total: a child's first turn is the parent's brief followed by the thread session's tail within the seed budget, nothing filtered, so a child never lacks what its parent saw. The briefs in the operator's turn are capped at twenty, the thread's touched repositories first and then the org's residents, so an org with two hundred repositories does not spend the tail on them.

The closest known shape is Claude Code: one linear agent per conversation, subagents in fresh isolated contexts that return only a final message, the model chosen per subagent at invocation. The one way this differs is that our operator does not act; it binds into a typed registry and hands the call to code that authorizes and runs it, so a wrong reading is a wrong typed call the class ladder can catch, never a free-form action.

```mermaid
sequenceDiagram
  participant P as person
  participant O as operator (one model turn)
  participant S as thread session
  participant A as authorize + class + fence
  participant R as runner / registry
  P->>O: event (message, reply, click, report)
  S-->>O: session tail, notes, run records
  R-->>O: projection (52 tools), repository briefs
  O->>A: decision: binds[] (incl. steer, answer) | question | refusal
  A->>A: policy table per bound call; class over the bound input
  alt destructive
    A->>P: button showing the exact line
  else read, exec, write
    A->>R: execute as bound; receipt names the line
  end
  R-->>S: run record; a child's report folds in as one turn
```

## One trace: three bullets, two repositories, a live unit

The state is the rollout's last step, the confirm default at destructive; until then step 4 shows a button. The maintainer replies into a thread where a ship unit is idle at its lease, waiting for a person (record 0051):

```
- set my default effort to high
- in the console the topology page should show one Connect GitHub button when nothing is connected
- the cli's cloud connect needs the trigger provider added, same shape as the others
```

1. The Slack adapter appends the reply to the thread's session and calls the operator. No parser touches the text.
2. The operator's turn holds the session tail (the idle unit, its pull request, the earlier explore report), the projection (52 command tools, 6 preset tools) and the cards of the org's residents, among them `acme/console` ("the web console: Vue pages for topology, settings and connect flows") and `acme/cli` ("the command line: cloud connect, providers, install").
3. It returns one decision with two binds: `config set me effort=high`, and a plan of two units, one in `acme/console` with the second bullet as its contract and one in `acme/cli` with the third. The idle unit is untouched: the bullets are new asks, not words for it, so this is a bind of the plan form and not a steer.
4. Authorization checks `config.set` for this person in this channel; the class is evaluated over the bound input, `scope: me` is write, below destructive, so it runs at once and the receipt names the line. The same command bound with `scope: channel` would be destructive and show the button.
5. The plan goes to the runner with `repo` on each unit. The runner cuts `plan/<id>/u1` in `acme/console` and `plan/<id>/u2` in `acme/cli`, each at its own default branch, and its receipt in the thread names both repositories before any round starts.
6. Unit one attaches to the console resident, whose git door mints a token pinned to `acme/console`; unit two attaches to the cli resident and gets one pinned to `acme/cli`.
7. The runner spawns each coding child on the strong tier, since coding never runs on the fast one, and each unit's review child on the tier the decision chose. Each unit has a working session per lane that its later rounds continue; the thread session gets one turn per child report.
8. The person replies "actually make the console button say Connect a repository". The operator reads the two live units in the session and returns a steer into unit one's run; the runner folds it at the child's next boundary.
9. Unit two's review round finds the checks red at the head; the runner reports "not ready, `ci / test` red" under the unit's card in the same thread.
10. The person replies "merge the cli one". The operator binds `merge` on unit two's pull request; the class is destructive, so the button appears with the exact line and the risk, and the click runs it.
11. Three days later the person writes "the topology thing again, but for the empty cloud list". The session tail carries the compacted summary of unit one and its pull request; the operator binds a plan of one unit in `acme/console` and never re-reads the channel.
12. Nothing in steps 1 to 11 typed a directive, matched a regex or pasted a line.

The property the trace proves: one interpreter with the thread's memory turns a heterogeneous ask into typed calls that code can authorize, class and execute, and understands every later event against the same memory.

**Amendment, 2026-09-18, while proposed: four steps corrected against the code.** Step 3 is a decision with two binds and it is authorized as the replier, who is the requester here; a reply by another member would be authorized as that member and could not steer this person's units without a grant. Step 7 is corrected in place to put both coding children on the strong tier, since the coding preset never gets the fast one; the tier choice applies to review, explore and research children. Step 8 is a bind of `steer` on unit one's run, returned by the operator and folded by the runner at the child's next boundary; today's admission would have folded the words into whichever run was live before any model read them. Step 10's `merge` is a new registry command whose input pins the pull request's head sha, so a click on an old button after the head moved refuses instead of merging; a plan whose units carry `merge: runner` is destructive class at the plan bind, since the runner then merges without a person.

**Amendment, 2026-09-18, while proposed: the trace under one thread per unit.** Record 0055 stands: every unit of a plan runs in a thread of its own and one live run holds a thread. Steps 5 to 10 read accordingly. The plan bind's two units open two unit threads in the channel, and the idle unit's thread is a third. The person's words in step 8, typed in the plan's thread, name unit one, and the operator binds a steer into that unit's run whichever thread holds it. Step 9's report is the `ship_unit` event on the hosted parent run of record 0060, which the plan thread's card and the thread session both render. Step 10's merge names unit two's pull request. Nothing in the trace needs two live runs in one thread, and the earlier note's reading of step 8 is corrected by this one.

## The difficulty map

1. **Writes bound from prose without a button** (most likely wrong): the misbind rate on writes has never been measured, the operator binds from text that includes untrusted READMEs and child reports, and an identity hole in today's code would let a forged requester or a guest's reply run a write as someone else. Section: the write bar.
2. **One session per thread while children stay isolated**: the key moves to the thread for the operator and to the unit and lane for a child's working session; admission moves after the operator; the fold and the migration are where a transcript could be lost or doubled. Section: the thread session.
3. **Deleting the readers without losing their cases** (most work, with 4): every shape they handled becomes a fixture. Section: the deletion.
4. **Cross-repository plans**: per-unit repository, resident, token and preflight, with the cold path waiting on record 0048. Section: the unit's repository.
5. **The tier at spawn**: least risk, least code. Section: tiers.

## The write bar

The constraint: the maintainer wants "if it's confident it executes, if not it asks", and also that a model must never go rogue. Record 0044 answers both today with one lever, the confirm class, whose built-in default is write: every routed write is a button, including `config set me` and `mcp add`, which are reversible and scoped to the person. The validator refuses `never` until the write misbind rate is measured, and no row measures it. The class is read from the command's definition alone, so `config set` is one class whether its `scope` argument says `me` or `channel`. And the operator's turn will hold text nobody on the team wrote: README cards, quoted threads, child reports that carry repository content.

The design separates confidence from class and makes the class see the input. Confidence decides ask versus act: an operator that cannot fill an argument, or reads two candidates, returns a question with its best guess as the full line, per record 0054. Class decides button versus run: the built-in confirm default moves from write to destructive, so a bind of class read, exec or write runs at once with a receipt naming the exact line, and a destructive bind shows the button. The class is the command's declaration evaluated over the bound input, never the sentence: `annotations.destructive` becomes a boolean or a total predicate over the input, the shape `risk(input)` already has, and the conformance suite fails a chat-exposed write without one or with a predicate that is not total over the schema. The declarations are audited under one rule: destructive means irreversible, or affecting people other than the requester. `memory forget`, `mcp remove`, a stop of another person's run, a merge, a deploy, and `config set` or `mcp add` at channel or org scope are destructive; the same at `me` scope, a pull request, a run of the repository's checks are not.

Five holds stand between a wrong reading and a wrong act, and only the last is new:

- **The projection.** The operator can call only what it is offered, so a rogue bind is a registry command with wrong arguments, never an action outside the registry.
- **Authorization.** The policy table reads the bound call, as today.
- **The fence and the verifier.** Cards, quoted threads and folded reports enter the turn inside record 0037's untrusted fence, which the prompt already tells the model to cite and never obey; the structural guarantee is record 0044's verifier, today a builder the replay scores and nothing in production calls, wired before the default moves for binds of class write and above: a second model call on the fast tier, given only the author's own turns and the bound line, that answers whether the line does what those turns asked and nothing more; a disagreement renders the question with the line as its proposal. An instruction planted in a README opens no pull request because no person asked for one.
- **The lease.** Record 0046 caps what any run spends.
- **The write row.** Over the checked-in fixtures the replay counts how often a write bind names a command, a required argument or a repository the fixture did not. An optional argument the fixture left unset and the bind filled is a misbind, because a filled argument nobody asked for is an act nobody asked for; one the fixture set and the bind left unset is not, because an omission becomes a default or a question. The row measures agreement with fixtures the team wrote, so under the flag the operator's decision and the readers' result are also logged on production traffic and compared on command name and every argument after normalization.

The bar is a guess to be set by the first replay: zero misbinds on the imperative and command fixtures, at most one in fifty on paraphrases, and production agreement on typed command lines at or above the command row's own bar.

Invariants: the default confirm stays at write until the write row holds at the bar on two consecutive replays against the production prompt and the verifier is wired; a destructive class always renders a button whatever the operator's confidence; a `system` or `policy` refusal never renders a Yes; the receipt of a write that ran names the line that ran; a class predicate is total over its command's input schema; untrusted text enters the operator's turn only inside the fence.

Failure modes: the row never reaches the bar, and the button stays at write while everything else in this record ships, since nothing else depends on it. A predicate is wrong for one input shape: the suite proves totality, not correctness, so the audit is a reviewed list in the plan with a table test per predicate. The person changes their mind after a write ran: the inverse command runs the same way.

**Amendment, 2026-09-18, while proposed: the red team's findings.** Six corrections, the first two dependencies before the default moves.

- **The requester is not forgeable.** Today a Slack message posted by any app through a mention is read for authorization as the person its relay footer names, or, with no footer, as the thread's parent author; only the button, bound to that person's ids, stops the write half, and routed presets already run at once. The footer is honoured only for a configured relay app id; from any other app, footer or not, the app itself is the requester and the thread-parent rule applies to people only. Until this lands the default stays at write.
- **Every turn has an author.** Session rows carry only a role today, so a guest's reply in the requester's thread is read as the requester's words by the seed, by a steer and by the verifier. Every row carries the actor id; a bind is authorized as its author; a bind of `steer`, and any destructive bind on a run another person requested, needs that person or a grant, which is record 0051's owner rule read through authorization. The runner's own steers into its children are authored by the runner acting as the plan's requester, as its coordinator tag already records, so they pass. The verifier reads the author's own turns, never the thread's.
- **The fence is structure.** Today the untrusted wrapper is a sentence applied on some paths: quoted threads and machine outputs are wrapped, review prose in a coding brief and pull request facts are not, and the router quotes the request in tags of its own. A brief is typed fields with capped lengths, never prose; every text a person did not type enters the operator's turn and every child's brief only through the wrapper; one vocabulary, the fence of record 0037; a lint in the shape of `no-raw-refusal` fails a module that passes untyped text to a model without it.
- **The predicate runs over parsed input.** `risk(input)` today receives the raw arguments, before the schema parses them, so a predicate written over raw strings is fooled by case, whitespace, look-alike characters or an array where a string was expected. The class predicate is typed over the schema's output and evaluated after parsing; a parse failure or a throw classes as destructive; an argument that widens scope never defaults to the wider value.
- **Coordinator actions are outside the button.** A merge the runner performs under `merge: runner` is not an operator bind and no button covers it; its holds are the fence on what the review child reads and the verdict parser's severity gate, and the record says so rather than implying the ladder reaches it.
- **Guests and caps.** A guest's binds keep the write-class button whatever the default, so a guest cannot plant a memory that recall feeds into every later bind; a plan bind carries a per-requester cap on units, in the shape of record 0046's lease.

The receipt of every bind carries the class verdict and the operator's one-line reason beside the line that ran, so a person can see why the ladder let it run. When a bind chose a repository or a preset, the receipt also carries one **re-bind** button offering the next-best candidate, so a wrong repository costs one click, which is the one place a peer's door was more elegant than this one. When the bind already ran as a write, the re-bind runs the inverse first where the command has one, and otherwise renders a question naming both the act that ran and the one proposed, never a second write beside the first.

## The thread session

The constraint: the session log already is the memory the maintainer describes, a per-turn log with compaction as a pointer, notes and recall, a 60,000-token seed from its own tail; a run continues from it, never from the channel. But it is keyed by thread and agent, so a thread has one log per preset and the door has none. Record 0055 rejected one thread per plan for exactly this key: N coding children would share `<thread>:coding`.

The design gives a thread one **thread session**, keyed by the thread alone, that the operator reads and writes: every event from every connector, every child's final report, every question the door asked and every answer is a turn in it. A child run gets a **working session**, keyed by its run, seeded from the brief the parent composed plus the turns of the thread session the parent hands down, and it writes into the thread session only through its report. The isolation record 0034 keyed by agent now hangs on the run, which the runner's coordinator tag already identifies, so the constraint that killed one thread per plan goes with the key. The thread-wide artifact read that hands every finished run's typed results to a seed today applies to the thread session only; a working session carries what its parent handed down and nothing of its siblings.

**Amendment, 2026-09-18, while proposed: a working session is keyed by unit and lane.** A peer read against the runner found the key above undoes record 0034's rule for ship, that a unit's findings round continues the coding child's session so the agent that wrote the code answers the review with its own reasons, which the runner's findings step keeps today. Corrected: a working session is keyed by the unit and its lane, `<unit>:coding` and `<unit>:review`. The first run of a lane seeds it from the brief the parent composed plus the turns of the thread session the parent hands down; every later coding round of the unit continues `<unit>:coding` and every review round continues `<unit>:review`. Isolation hangs on the unit: runs of different units never share a working session, and within a unit the rounds of one lane share one. The fold below stays keyed by the child's run id. This supersedes record 0055's "One session per agent" trade, where a person's `agent:review` run in the unit's thread shared `<thread>:review` with the runner's re-review: under this record the person's run has its own lane in the thread session and the runner's review lane is the unit's.

The fold is one write keyed by the child's run id, `<thread>/<runId>`, in the shape record 0046's segments use, so a runner reclaimed between a child's end and its fold writes the report once. The operator's turn takes the tail within the seed budget, newest first, with folded reports kept whole ahead of the person's older turns, since a later bind needs what a child did more than what was said before it.

Migration: an old thread's `<thread>:<agent>` logs are not rewritten. On the first event after cutover the thread session is built once from their tails, rows interleaved by their timestamps, and the old keys stay read-only for recall until they retire by the deletion precedent record 0035 cites.

Invariants: a thread has one thread session for its life; a child report enters it once, under the child's run id, at the child's end; a unit has one working session per lane and every round of that lane continues it; runs of different units never share a working session; a working session is read by no run but its parent, through the report; the operator reads the tail and nothing else about the thread.

Failure modes: a compaction summarizes a folded report into a sentence and a later bind needs the detail; recall over the log answers it, as for runs today. Two connectors append in the same second: the log is append-only under the thread's object, so the order is the object's.

**Amendment, 2026-09-18, while proposed: the log the fold needs, the key, the cap, the migration.** Today's write-through is a single-claimant, index-appended log: a run's rows land at the index its seed began from, and a tail that moved underneath rewrites the whole seed as new rows. Folds from several children and turns from several connectors cannot share that. The thread session's object gains an idempotent keyed append, `append(key, rowId, rows)`, where a fold's row id is the child's run id with its attempt and a connector's is the message id with its edit timestamp, so a reclaimed runner or a redelivered message writes once while an edited message and a re-attempted child each write their new words. The operator's read-then-decide race resolves the same way it does at admission today: a decision that steers a run which ended before the fold is re-dispatched as a bind of the same words. The working session's key carries the plan instance, `<instance>:<unit>:<lane>`, because unit ids repeat across plans and a re-issued plan gets a new instance; a re-issue of the same plan id continues the prior instance's lanes. The operator's own tail is capped at 12,000 tokens, a guess the first unit measures, while a run's seed keeps the 60,000 budget: the cost and latency arm found the tail, not the projection, is the whole cost, and a bind on the strong tier with a 20,000-token tail would take three to six seconds. The operator's prompt is ordered rules, projection, briefs, then the tail oldest-first, then the request, so consecutive events in a thread hit the prompt cache for everything but the new turns. A run live at cutover keeps writing to its old key and folds its remaining turns into the thread session at its end. The projection the operator sees is filtered to the presets and commands the author may run, as the router's table is today.

**Amendment, 2026-09-18, while proposed: the fold projects record 0060's event, and sessions register by metadata.** A child's report enters the thread session by reading the `ship_unit` event that record 0060 writes on the hosted parent run, keyed by that event's id, never as a second authoritative copy; the earlier note's fold key, the child's run id with its attempt, is superseded by the event's id. A working session `<instance>:<unit>:<lane>` registers under the thread named in the run's metadata, not under the claim's thread, which is the rule record 0060 deferred to this record. A silent reply record 0058's gate withholds from the operator is appended to the thread session as the person's turn marked silent, so a later bind can read what a colleague said.

## The deletion

The constraint: chat surfaces run about 540 lines of interpretation that exist only for chat: the directive syntax (156 lines, six words), the chat command entry (279 lines) and the repository token scan (104 lines of a 975-line module), plus the attach-token regex inside the router. Each got a rule per miss, two in the day before this record: `on the <name> repo` in the scan and two sentences in the router prompt. The grammar's tokenizer and catalogue (526 and 401 lines) serve the CLI, MCP and HTTP adapters too, and there they are right: those surfaces are syntax.

The design deletes interpretation from chat and keeps syntax on the typed surfaces. Where each piece goes:

- The directive words `agent:`, `model:`, `effort:`, `budget:`, `severity:` stop being syntax and become words the operator reads. `renewals:` becomes the `renewals` argument of the plan bind, bound from words, with the grant it names checked in authorization as today.
- The typed command line in chat stops being stage A. It is an input the operator binds trivially; a **fast path** for it is allowed only as an optimization proven identical to the operator's bind on the replay's command fixtures and on the flag's production log.
- The repository token scan leaves `resolveRepoContext`. The operator binds the repository into the call's `repo` argument from the cards, the session and the text; the resolver keeps only the deterministic vet of the bound slug against the resident registry or the installation, reporting `unverifiedRepo` when neither answers.
- `structuralRoute` goes; the attach rule lives in the prompt and its fixtures.
- Record 0054's near-match guess stays as evidence in the operator's turn ("no resident is named `acme/infra`; `acme/infrastructure` is one edit away and warm") instead of the first line of defense.
- Channel encoding stays in the adapters and moves there where it is not: Slack's `<url|label>` unwrapping and code-span detection are the channel's encoding, not the request's meaning, so `unwrapChatLinks` leaves `route.ts` for the Slack adapter.

Every case the deleted code handled becomes a fixture before the code goes: PR URLs and `owner/name#N` shorthand, `in <slug>` and `in <name>`, tree URLs with a ref, the branch keyword, the six directive words, the typed command line with flags, the compose-position rule, the code-span exclusion, the attach token. The replay's command row already scores a command named right at 1.0 and its input bound at 0.9 over 74 fixtures and 37 decoys; the deletion adds the repository, directive and attach fixtures to the same row and holds the same bars, ported from the deleted code's own tests.

Invariants: no module under `src/core/dispatch` or `src/channels` reads chat text with a regex to decide what it means, enforced by a lint rule in the shape of record 0054's `no-raw-refusal`, with the adapters' encoding helpers allowlisted by file; a fast path exists only beside a replay row and a production log that prove it identical; a case that leaves the code enters the fixtures in the same pull request.

Failure modes: the operator binds a PR URL to the wrong number; the fixture catches it, and that reader stays until it does not. Latency: the router answers under an 8,000 ms bound today; a bind on the strong tier with the capped tail is measured in the plan's first unit, and the cap drops if the median exceeds three seconds. Cost: one strong-tier call per event where today only routed messages pay one fast-tier call; the run ledger counts runs, not events, so the volume and the miss rate per routed request are both unknown, and the first unit counts events and routed requests for a week under the flag before any reader leaves.

**Amendment, 2026-09-18, while proposed: no fast path, and the operator's tier.** The maintainer decided there is no fast path for a typed command line in chat at all: a typed line is words the operator binds, the fast-path bullet above and its invariant clause are withdrawn, and the lint has no exception to defend. The operator runs on the strong tier, not the fast one, since eight of the seventeen distinct misses were the fast model misreading words it saw; the latency sentence above is met by the tail cap in the thread session's amendment, not by a cheaper model. The word `lane` names the round's preset, `coding` or `review`, and nothing else.

## The unit's repository

The constraint: the promise fails if a plan cannot ship to every repository in the org from one thread. Today a plan instance has one `repo`, a unit has none, the runner cut a branch in the wrong repository when the ask addressed another, and the coding child pushed with a token pinned to the wrong repository and fell back to attaching a patch. The bot's own installation token is scoped by permission, not by repository; the pin is the resident's: each resident's git door mints `repositories: [<its own repo>]`. On the cold path a write run holds the installation's full grant until record 0048's git door lands.

**Amendment, 2026-09-18, while proposed: the resident's pin is the code's contract.** The mint above is what the resident's git door is written to do; its live receipt is still open, so the record states it as the contract, not as a proven fact.

The design puts `repo` on the unit. The operator's plan bind names a repository per unit from the cards; the runner cuts each unit's branch in its own repository, attaches each unit's children to that repository's resident, and lets that resident's git door mint the pinned token, so a child on a resident never holds a credential for a repository it does not work in. A preflight per unit runs before any coding round: the resident exists or a cold sandbox can be provisioned, the installation can see the repository, the default branch is known; a unit that fails preflight is a question with the corrected line, never fifteen minutes of coding and a patch. Dependencies between units cross repositories the way they cross units today, by order.

Invariants: a unit's branch, resident and token name the same repository; a child on a resident holds no token for another repository, and a cold child holds none once record 0048 lands; a plan's units may name any number of repositories.

Failure modes: two units in one repository share a resident and take two worktrees, which the resident already does per thread and ref. A repository with no resident runs cold with the installation's grant until record 0048, and the runner's receipt says so on that unit's card. The operator binds a unit to a repository whose card matched a shared keyword: preflight cannot catch a plausible wrong repository, so the runner's first receipt names every unit's repository before the first round, which is the person's chance to steer.

**Amendment, 2026-09-18, while proposed: the pin holds by construction, and preflight runs before the instance.** The red team read the resident's git door as minting for whatever repository a request names; the correctness pass found the request only selects which resident answers, and the resident mints from its own stored resource at every site, so the pin holds by the object's identity and the open receipt above is the only proof still owed. Preflight runs before the plan instance is created, not after: today a failed branch aborts one unit while its siblings run, and a re-bound generated plan hashes to a new instance with new branches, duplicating the units that passed. A generated plan's id derives from the thread and the decision that bound it, not from its text, so a re-bind after a runtime failure reuses the instance; a unit that fails preflight or its branch is a question whose answer re-issues that unit alone into the same instance; the pre-check adopts a unit by its head sha, as today. The confirmation row is already a union of a command with its input and a question's Yes; it gains a third member, a decision's list of binds, so a destructive plan bind can be offered as one button showing every line; one row per thread stays. A confirmation store that cannot be reached refuses the destructive bind by name instead of falling back to a line to paste. Any number of repositories means any within one installation owner, since a resident plane holds one installation.

**Amendment, 2026-09-18, while proposed: thread occupancy is record 0060's.** The plan's admission unit no longer rebuilds the ledger's one-live-run-per-thread index into a per-unit key. Under record 0055 a unit has its own thread, so a claim per unit is a claim per thread, which the index already enforces; the pipeline's parent occupies no thread because record 0060 claims it under a host key. The operator's steer names the run in the unit's thread; the stage reorder and the owner rule stay as written. A preflight question that ends a plan bind releases the host claim in the same branch, which record 0060 takes as its own amendment.

## Tiers

Every peer tool that has solved model choice chooses per agent at invocation, never per tool call, because the prompt cache is model-scoped and a mid-conversation switch re-reads the whole prefix. The operator's bind and the runner's spawn carry `model` and `effort` for the child in the request slot of the existing ladder, chosen from an **allowed set** each preset declares (new: today a preset carries only a built-in effort). Escalation is a phase boundary: a child that finds the work harder than briefed ends with a note and the parent spawns the continuation on a stronger card. Invariants: a run's card is fixed at dispatch; a child's card is within its preset's allowed set.

**Amendment, 2026-09-18, while proposed: tiers, and who may run fast.** What this section calls a card is the child's **tier**, the model and effort a spawn carries; the word card is the message in the thread. The allowed sets follow what every peer does, which is to keep code-writing off the fastest model and use it for reading: `coding` and `ship` never the fast tier; `review` never, since a wrong approval has already cost missed majors; `explore` and `research` may use it; `general` and the operator run on the strong tier.

## Why not X

**Why not just fix the router?** It was fixed twice in the day before this record, and the token scan gained a rule the same day. The seven seam issues are not the router misreading; they are ordering. Two interpreters with different context cannot agree, and the deterministic one wins every tie.

**Why not invert the precedence and keep the readers as evidence?** That is the flagged stage of the rollout, and it is where the design would stop if the fixtures did not hold. It is not the end state, because a reader kept as evidence still grows a rule per miss and still needs the seam this record removes; the cases live on as fixtures, which grow nothing.

**Why not keep a directive as an escape hatch?** A directive is a bypass, and the bypass is what refused a ship for no repository while the router named the repository in its own reason line. When the operator misreads, the person asks it or steers it in words.

**Why not a persistent agent per thread?** The transcript is the state. A process holding it buys nothing a turn appended to the log does not, and costs a container per thread; record 0051 reserved that shape for a pipeline parked on a person.

**Why not keep the button on every write?** Two clicks for a setting and a paste for a ship is the door nobody uses. Class over the input decides the button, confidence decides the question, the write row decides when the default moves.

**Why not one agent with all the tools instead of presets?** The presets are the projection of machine, credential and budget, and the policy table authorizes by preset. Deleting them would move authorization into the prompt, the one place it must never live.

**Why not let the person choose interrupt, queue or steer, as two peers do?** A chosen mode is a directive by another name, and the operator infers it from the words with the thread in view. The override for a wrong inference is the re-bind button on the receipt, one click, which is what the capability matrix found the best peer offers.

## Boundaries

The CLI, MCP and HTTP adapters keep the grammar. Authorization, the policy table and record 0007's identity rules read the bound call, as today. Record 0054's seam and fence survive as written; its guess sites become evidence in the operator's turn, and its third unit is reshaped to that. The repository card is deterministic text from the README, built in the resident as record 0054's cards unit sizes it, never a model digest. Record 0048's git door is a dependency of the cold path, not this record's work. Compatibility: nothing a person typed stops working, since every deleted shape is a fixture the operator binds.

**Amendment, 2026-09-18, while proposed: the spec rows this changes.** The searchable transcripts become the thread session plus the working sessions by unit and lane, so live-view item 28 (the unit page's session search, which today derives `<unitThread>:coding` and `<unitThread>:review`), session-log item 11 and agent-ship item 17 change in the same pull request as the code, per the same-PR rule.

**Amendment, 2026-09-18, while proposed: record 0060 is a dependency of the plan form.** The plan form's units land after record 0060's host key, hosted parent and host-only write path, since both records rewrite the hand-off and the coordinator's channel code; record 0060 uses the word operator for a person running a hard stop and renames it there so the word means one thing across the records.

## What would change our mind

| Assumption | Cheapest evidence | When |
|---|---|---|
| The operator binds writes at the bar | the write row against the production prompt, and the flag's production agreement | before the confirm default moves; the record ships without it |
| A bind on the strong tier with the tail capped at 12,000 tokens answers under three seconds at the median | the plan's first unit measures it on the replay; the cost arm projects three to six seconds at a 20,000-token tail | before the readers leave |
| The operator, replayed over the seventeen filed misses as fixtures, binds what the person meant | a misses row on the replay, run before the flag is on for anyone | before the flag |
| The event volume makes one call per event affordable | one week of event and routed-request counts under the flag | before the readers leave |
| A thread session with folded reports compacts without losing what a later bind needs | ten real threads replayed with the fold, then a bind that needs a folded fact | before the key migration |
| Per-unit residents and tokens hold the pipeline's step semantics | one two-repository plan on staging | before the plan form is offered |

Reversibility: the operator runs beside the readers behind `routing.operator` with both decisions logged and compared, as the router shipped behind a flag with the replay as its gate; each shape leaves only after its fixture holds, and the confirm default is a config value.

## Rollout

The requester fix first, the relay footer and the thread-parent rule, since it holds today regardless of this record, and the authored session rows with it. Then the seam and the fence, since they are in flight. Then the operator behind a flag beside the readers, logging both decisions, with the write row and the event count added to the replay, and the class predicate on `annotations.destructive` with its audit. Then the thread session key with the migration, and the repository cards. Then the projection widens to the plan form with per-unit repositories, the runner's per-unit resident and token, and the spawn's card. Then the readers leave shape by shape as fixtures hold, and the verifier is wired. Last the confirm default moves when the write row holds twice. The execution ledger is the plan's.

**Amendment, 2026-09-19, while proposed: the operator ships on — the shadow week is one entry test.** The maintainer decided the operator's default is `on`. The plan gains a unit after its cut two, "The default is on", that flips `operatorModeOf`'s default from `off` to `on` in `src/config.ts`, gated on the admission and verifier units merged plus one strong-tier replay run (`npm run load -- route --provider anthropic --model <strong tier> --verify`) whose write row and misses row hold, posted in that unit's pull request body. The flag stays as the rollback lever, never a setting a person is told about. The shadow week above is replaced by that entry test; `shadow` stays a mode of the flag, not a rollout phase. The agreement row is kept as a measurement posted after one day under `on`, never a gate, so the Reversibility paragraph's "both decisions logged and compared" reads as that one-day measurement with `routing.operator: off` as the rollback, and the assumptions table's misses row runs as part of the entry test before the default flips, its volume week measured under `on`.

**Amendment, 2026-09-19, while proposed: images are first-class operator input.** The maintainer decided the request's images enter the operator's turn as provider-native image blocks, so the operator's card must be vision-capable. Every attachment of a thread is copied into the R2 artifacts store by reference when it arrives ([record 0033](0033-artifacts-move-by-reference-through-r2.md)), the reference stored on the session row so a later turn's "this" resolves, and the same references are handed to the child at the bind. The plan gains a unit in its cut three, "Images reach the operator", with a replay row of image-anchored fixtures — a screenshot plus an order, expected bind `ship`.

## Open questions

| Question | Owner | Resolves it | Before |
|---|---|---|---|
| The write row's bar: zero on imperatives and commands and one in fifty on paraphrases, or stricter | the maintainer | the first replay of the row against the production prompt | the confirm default moves |
| Whether a plan bind naming two or more repositories is itself destructive class | the maintainer | the two-repository staging run and its receipt | the plan form is offered |
| Whether the operator runs on the router's fast card or the general card | the plan's first unit | latency and the write row on both | the readers leave |

**Amendment, 2026-09-18, while proposed: the maintainer's answers, and two new questions.** The bar stands as the guess above. A plan bind naming several repositories is write class, unless a unit carries `merge: runner`, then destructive. The operator runs on the strong tier, with a note that this piece is the likeliest to move to another model later. Two questions open in their place:

| Question | Owner | Resolves it | Before |
|---|---|---|---|
| The operator's tail cap: 12,000 tokens, or lower | the plan's first unit | the median bind latency on the strong tier at the cap | the readers leave |
| How the requester fix is disclosed, since the repository is public | the maintainer | the fix deployed, then the maintainer's call on an advisory | the fix merges |

## Validation criteria

| Criterion | Proof |
|---|---|
| The operator receives the thread session tail, the projection and the cards inside the fence, and never the channel history | `[gap]` the operator unit's route test |
| A destructive bind renders the button; a write bind runs with a receipt naming the line; `config set` at `me` and at `channel` class differently | `[gap]` the dispatcher test on `config set me`, `config set channel` and `memory forget` |
| Every class predicate is total over its command's input schema | `[gap]` the conformance suite's row |
| A bind no person's turn asked for disagrees into a question | `[gap]` the verifier's dispatcher test with an instruction planted in a card |
| No regex reads chat text under dispatch or channels outside the allowlisted encoding helpers | `[gap]` the lint rule's own test |
| A plan with units in two repositories cuts two branches, attaches two residents, mints two pinned tokens | `[gap]` the runner test and the staging receipt, human-gated |
| A child report enters the thread session once under its run id | `[gap]` the session log test with a reclaimed runner |
| The write row holds at the bar twice and the verifier is wired before the default moves | `[gap]` the replay's row, posted on the receipts tracker |
| A relay footer from an app that is not the configured relay is read as the app, never as the person it names | `[gap]` the requester test with a forged footer |
| A bind of `steer` by a member who is not the run's requester and holds no grant is refused | `[gap]` the dispatcher test with two actors in one thread |
| An app's reply with no footer in another person's thread is read as the app, never as the thread's parent | `[gap]` the requester test with an app reply |
| The runner's steer into its own child passes as the plan's requester | `[gap]` the admission test with the coordinator tag |
| The class predicate sees parsed input: a look-alike or array-shaped scope argument classes as destructive or fails to parse, never as `me`, and no scope-like argument carries a widening default | `[gap]` the conformance suite's row with the look-alike fixtures and a schema-defaults check |
| The operator's median bind latency at the tail cap is under three seconds on the strong tier | `[gap]` the plan's first unit, posted on the receipts tracker |
| The operator binds the seventeen filed misses as the person meant them | `[gap]` the replay's misses row |
| Text a person did not type reaches a model only inside the fence | `[gap]` the lint rule's test over briefs and pull request facts |

## Sources

Records 0034, 0035, 0036, 0037, 0039, 0044, 0046, 0048, 0051, 0052, 0054, 0055. In the tracker: the nineteen routing issues of the eight days before this record (seventeen distinct: eight the model's reading, seven the seam, two the card's rendering), the cross-repository ship failure, and the topology-screen thread pair that opened this record. Peer documentation: Claude Code's subagent `model` and `effort` frontmatter and per-invocation override, and its Slack surface's correction buttons; the Claude Agent SDK's per-subagent model; Managed Agents' permission policies and per-event evaluation; the OpenAI Agents SDK's per-Agent model, handoffs and approval predicate; Cursor's Auto router; Capy's and eve's delivery modes; Cognition's "Don't build multi-agents". The adversarial round's five reports are in the session that wrote this record; their findings are the dated amendments above.

## Appendix: the survey at `f8cbe0ba`

| # | Fact | Value | Proof |
|---|---|---|---|
| 1 | Stage order | stage A typed-command parse, `readRequest` (directives, channel history), thread read, settled resolution, route, agent gate, profile gate, admission, references, `resolveTarget`, memory read, ack, repo gates, ship fork, attach, run loop | `src/core/dispatcher.ts:392-1297` |
| 2 | Router's model and bound | `routing.model` else `defaults.models.general`; 8,000 ms; forced tool call | `src/core/dispatch/route.ts:1180`, `:106`, `:907-930` |
| 3 | Command menu already a projection | `routableCommands` = chat-exposed registry commands as tools with `jsonSchemaFor` | `src/core/dispatch/route.ts:217-227` |
| 4 | Presets already a projection | `routablePresets` = name, description, machine, identity, budget | `src/core/dispatch/route.ts:187-198` |
| 5 | The verifier is unwired | a pure builder the replay's `--verify` scores; nothing in production calls it | `src/core/dispatch/route.ts:725-727` |
| 6 | Directive syntax | six words including `renewals`, one regex, 156 lines | `src/directives.ts:47` |
| 7 | Chat command entry and the shared grammar | `parseChatCommand` 279 lines over `tokenize` and `parseInvocation` (526) and the catalogue (401), the latter two shared with the typed surfaces | `src/core/commandChat.ts`, `commandSurface.ts`, `commandCatalogue.ts` |
| 8 | Registry size | 52 commands, 24 chat-exposed; 6 `destructive: true`, 10 `destructive: false`; `config set` one command with a `scope` argument, `destructive: false` | `grep defineCommand( src/core/commands/*.ts`; `src/core/commands/config.ts:85-86`, `:385` |
| 9 | Confirm classes and default | `["write", "destructive"]`, built-in `write`; `exec` and `never` refused by the validator; `routedRunsAtOnce` = read, or class below the confirm class | `src/config/profile.ts:82-83`, `:103`; `src/config/validate.ts:189-192`; `src/core/dispatch/route.ts:145-151` |
| 10 | Replay fixtures and rows | attach 5, command 74 plus 37 decoys, compound 25, imperative 39; accuracy at or above 95 percent, read to write routes zero, command named 1.0 and input bound 0.9 | `src/load/route*Fixtures.ts`; `src/load/routeReplay.test.ts:301-302`, `:656-657`; `src/load/routeReplay.ts:1013-1080` |
| 11 | Seed and notepad | 60,000 tokens; compaction as a pointer; notepad 8,192 bytes | `src/core/dispatch/seed.ts:32-33`, `:104-116`; `src/core/runLedger/sessionLog.ts:90` |
| 12 | Cross-agent reads | none of the log; typed artifacts of every finished run, children included, enter a seed | `src/core/dispatch/thread.ts:101-111` |
| 13 | Model and effort ladders | request, user, channel, per-agent maps, defaults; presets carry no model and a built-in effort layer | `src/config.ts:980-1000`; `src/agents/registry.ts:11-12`, `:78-81` |
| 14 | Spawn limits | three children, depth one; write presets refused | `src/core/dispatch/spawn.ts:54`, `:63`, `:246-274` |
| 15 | Bot token scope | by permission, never by repository; write is the full installation grant | `src/execution/githubApp.ts:36-45`, `:205-207` |
| 16 | Resident token scope | `repositories: [<own repo>]` on every mint | `deploy/cloudflare-resident/worker.ts:852-870` |
| 17 | Resident facts | default ref, sha, lockfile hash, timestamps; no README or description | `deploy/cloudflare-resident/worker.ts:1229-1239` |
| 18 | The untrusted fence | quoted data between `<<<UNTRUSTED` and `UNTRUSTED>>>` is read and cited, never obeyed | `src/agents/registry.ts:230` |
