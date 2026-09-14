---
title: One agent does a unit of work; a run continues its thread's transcript; a child run is a reader; only a state machine sits between agents
status: proposed
date: 2026-09-14
pattern: Single-threaded agent per unit of work, the session as the unit of context; coordinator as a state machine, never a model; fan-out only to readers
---

# One agent does a unit of work; a run continues its thread's transcript; a child run is a reader; only a state machine sits between agents

**The ask.** Decide: adopt this shape for the orchestration program, before the next conductor or ship change and before the harness series moves the review preset. Owner: the maintainer, who set the direction on 2026-09-14 ("keep the good parts and collapse our design into this more elegant one; don't have special logic where it's not needed"); this record fixes the shape for review before any code. Written for an engineer who knows the dispatch pipeline and records 0002, 0011, 0019, 0029, 0031 and 0032, and has read the two accounts this record is held against: Cognition's "Don't build multi-agents" and an incident-automation vendor's "Sub-agents are just wrong".

Success criteria: (1) no run starts from a summary of another run's work where that agent's own transcript exists (the agent's own notepad, record 0035, is the one summary a run starts from, written by the agent it belongs to); (2) the agent that implemented a unit is the agent that addresses its review; (3) no child run can push, open or merge; (4) a person reads a unit in one scroll; (5) the special cases removed outnumber the ones added, tallied in Boundaries.

## TL;DR

Both accounts reduce to one rule: the agent that gathered the evidence acts on it, and a summary passed between agents is context the next agent never has; the sub-agents post reports its author's median from detection to pull request fell from 2.2 hours to 35 minutes when it collapsed 18 agents into one. Switchboard keeps the load-bearing half already and breaks the rule twice: a ship fix round is a new child handed the findings and never the coding transcript, and the conductor fans out coding children on prompts a model paraphrased. The bet is one primitive, **a run seeds from a transcript** plus what the channel said since, on the harness that compacts, which pi already turns into a session file; with it the fix child and its plumbing are deleted and one refusal in the spawn stage keeps every spawned child off the repository. The cost is a review thread per unit, one store read per follow-up and a compound form that offers readers alone. Open are the unit page's shape and a session's size, measured on the first ten.

## Today at `ea57f048`

The five facts the design turns on, as the delta from what a reader of records 0019 and 0032 expects; the survey is Appendix A.

| You would expect | Today |
|---|---|
| A follow-up continues the conversation the model had | It rebuilds from the channel: the last 50 replies as text turns, the bot's status lines dropped (`src/channels/slack.ts:663-681`). The previous run's tool calls, results and reasoning sit on the ledger unread; a resume is the only run seeded from a transcript (`src/core/dispatcher.ts:521`). |
| The agent that opened the pull request addresses the review | The runner spawns a new coding child on `buildShipFixTurn` (`src/core/ship/codingChild.ts:14`), tagged `fixRound` (`src/core/coordinator/briefs.ts:154`). It shares the unit thread with the review child, so each readonly to writable switch wipes and reclones the worktree (`docs/reference/specs/agent-ship.md`, the gap rows). |
| A child of an orchestrating run cannot act | `spawnChild`'s gates read no preset's identity (`src/core/dispatch/spawn.ts:214-240`); the conductor's prompt lists `coding` and `ship` as child presets and says a child "sees none of this thread" (`src/agents/registry.ts:442,446`); the compound form offers every routable preset, `coding` included (`src/core/dispatch/route.ts:68`). |
| pi's session is the harness's private cache | Where a deployment sets `harness.coding: pi` (the default is native, `registry.ts:505`), the harness already builds pi's session from a transcript: the ledger's on a resume, and since the last-turn prompt fix the seed's earlier turns on a fresh run (`src/core/harness/pi/harness.ts:144,301`; `docs/reference/specs/harness-pi.md` item 9). What it is handed to build from is still the channel's 50 replies. |
| A unit is one trace | One root per message (`docs/reference/specs/tracing.md` item 1): a unit is a parent record plus one root per child, and the runs index draws no tree (`docs/reference/specs/agent-conductor.md`, the gap rows). |

## The shape

A **session** is one agent's conversation in one thread: its log, one durable object per thread and agent that every run of the session appends to and that outlives them (record 0035 decides the store; this record first said the transcript of the thread's most recent finished run, which the ledger clears at finish). The design has one rule, **a run seeds from a transcript**: a follow-up on the pi harness seeds from the session of its thread and resolved agent plus the channel's messages since that run ended; a child spawned by a run seeds from its parent's text turns; a resume from its own plan; a thread's first run of an agent, and every run on the native loop, from the channel's history as today. Everything else follows. A ship unit's coding thread holds the coding agent's session, so the findings the runner dispatches into it reach the agent that wrote the code, with its reasons. The review child runs in a thread of its own, so no round wipes the coding worktree. A child spawned by a run must hold a `read` or `none` identity, so nothing the conductor spawns can push, open or merge; the plan runner's children are the coordinator's own dispatches, not spawns, and stay coding. The thread, not the run, is what a person reads.

The closest known shape is Claude Code: one linear agent per conversation, whose only sub-agents answer questions and never act, and whose context survives a restart because the session is on disk. The one difference is that here the conversation belongs to a thread in a channel, so whoever replies there continues the session, and in a ship unit the one replying is a state machine that never takes a model turn.

```mermaid
sequenceDiagram
    participant R as plan runner, a state machine
    participant C as unit thread, coding session S
    participant V as review thread, review session T
    participant G as GitHub
    R->>C: dispatch coding with the contract; r1 seeds from the channel
    C->>G: push h1, open the pull request; S = r1
    R->>V: dispatch review at h1; r2 seeds from the channel
    V->>G: request_changes, F1 and F2; T = r2
    R->>C: dispatch the findings as agent:coding; r3 seeds from S + the thread since + the findings
    C->>G: fix F1, decline F2 with r1's reason, push h2; S = r3
    R->>V: dispatch review at h2; r4 seeds from T + prior findings and dispositions
    V->>G: approve; T = r4; on a plan branch the runner merges
```

## One trace: a fix round across a bot death

The case most likely to be wrong: the session crossing a run boundary and a bot generation, on a deployment that runs coding and review on pi.

1. The runner dispatches the unit's coding child into the unit thread with its contract. No coding run has lived there, so r1 seeds from the channel plus the contract; pi starts on an empty session directory, prompted with the request.
2. r1 keeps a helper in one file rather than splitting it and says why in its own turn, pushes head `h1`, submits its description and handoff, and settles. Its 41 turns are on the ledger; the thread's coding session is r1.
3. The runner opens the unit's review thread and dispatches the review child there with the pull request and `h1`; it attaches readonly on a worktree of its own. The unit thread's worktree stays on the unit's branch, writable.
4. The verdict requests changes with F1 (a missing test) and F2 ("split the helper"); the bot posts it pinned to `h1`.
5. Meanwhile the requester writes one line in the unit thread, "keep the helper where it is", mentioning no bot and starting no run.
6. The runner's `findings` step dispatches the findings into the unit thread as `agent:coding`, as the requester. No run is live there, so the dispatch proceeds; the directive resolves the agent, and the run seeds from r1's transcript, then the requester's line, then the findings as the one new user turn.
7. The pi harness writes the earlier turns as a session file, starts pi on it with `--session`, and prompts with the findings alone, as it does for any seed with earlier turns.
8. r3 adds the test for F1 and declines F2, citing r1's reason and the requester's line; it records both dispositions, resubmits the description and starts the push.
9. The bot dies mid-push. The next generation reclaims r3; pi still answers in the container, so the harness re-attaches and pi continues where it was, the push's result already in its session, as record 0032 has it.
10. r3 confirms `h2` on the branch and settles. The session is r3's transcript: r1's turns, the requester's line, the findings, r3's turns.
11. The runner reads r3's record, matches its dispositions to the round's finding ids, and dispatches round two's review into the unit's review thread; it continues r2's session, so the reviewer remembers what it read, and the prior findings and dispositions ride the follow-up's text as today.
12. The verdict approves; the branch is a plan branch, so the runner merges under `plan:merge`.

The property: the agent that wrote the code answered its review with the reasons it had when it wrote it and with what the thread said meanwhile, across two runs and a bot death, and no code path composed a brief for it.

## The difficulty map

1. **The session** (most likely to be wrong): what a follow-up's seed is across generations, agents and requesters, and how large it grows. Section "The session".
2. **Readers only**: the identity refusal, the child's seed, and the compound form that stops offering write parts. Section "Children are readers".
3. **The runner and the unit page** (most work): the findings step, the review thread, the thread listing the store lacks. Sections "The session" and "The unit is the reading unit".
4. **Serial units**: a decision, one paragraph.

## The session

The constraint: the ledger already holds every run's transcript as the model saw it (record 0019), and the pi harness already turns whatever seed it is handed into a session pi continues, yet every run but a resume is handed 50 Slack replies instead of the transcript. The two accounts say what that costs: the agent that acts next lacks what the last one learned. Slack history is the summary between agents in this system, and nobody wrote it.

The design: the messages stage of `dispatch()` resolves a **seed source** before building the conversation, in this order. A resume seeds from its own plan, unchanged. A child spawned by a run seeds from the parent's text turns, handed over by the spawn stage (next section). A follow-up whose resolved agent runs on the pi harness seeds from the session of its thread and that agent when one exists, then the channel's messages after that run's end as user turns, the bot's own posts left out because the run's final reply is already the transcript's last assistant turn, so a line a person wrote between runs is not lost; the request is the one new user turn. Anything else seeds from the channel's history, as today. The native loop keeps the channel seed because it has no compaction and is being deleted by the series; tying the rule to the harness costs one condition and buys the absence of a bound for a loop nobody will run in a month, and it removes the trap in which a native session past the provider's window would fail every later follow-up in the thread. The pi harness writes the seed's earlier turns as a session file and prompts with the last user turn, which is what it does for any seed since the last-turn prompt fix, so the harness needs no second mechanism. A seed carries no system prompt and no thinking block: every run composes the current preset's prompt, so a deploy between two runs of a session changes the prompt and the tool table and not the conversation, exactly as a resume after a deploy does; and a session whose last step had calls in flight when its run ended gets each answered with the ledger's restart note, as a resume does, so no dangling tool call reaches a provider.

Resolution: the thread's sticky agent today is re-parsed from the thread's user turns on every message, the last directive winning, and a routed thread is not sticky at all. Under this design the dispatcher first reads the thread's most recent finished run from the store; when that run's agent runs on the pi harness, it is the sticky agent and the router is not asked; when it runs on the native loop, today's derivation from the user turns stands, so a native follow-up still routes again on its own text until the series moves the last native preset. A request directive still wins over both, and user, channel and default settings still sit below; the model and effort layers stay directive-derived, since a session is about the agent and its context, not the model it ran on. A directive naming another agent starts that agent's own session in the thread, so a thread has one session per agent and a directive-less follow-up continues the most recent. The card's "reply `agent:<preset>` to run it another way" keeps its meaning, and a routed thread on pi becomes sticky by transcript, which the front-door slice left open. "Finished" is any terminal status whose record carries a transcript, `completed`, `failed`, `interrupted`, `stopped_soft` or `stopped_hard`; a run refused at a gate wrote none and is not a session. The lookup, the thread's most recent finished run and its agent, is one store query by thread key that the run store lacks today and the unit page needs too.

The ship consequence: a unit's coding thread holds the coding agent's session. The runner's unit machine loses the `fix` brief and gains a **findings** step: the bot dispatches the review's findings into the unit thread as `agent:coding`, as the requester, with the coordinator's provenance on the record, through the coordinator's own spawn route as every runner child is dispatched today. The directive is explicit so that a person's `agent:review` detour in the unit thread, or a lost store, never routes the findings elsewhere. A run live in the unit thread at that moment is a person's, because the runner awaited its own child's end; the dispatch is refused `coordinator_thread_live` as today and the step waits and retries under the unit's wall clock, since that run's transcript is the session the findings should follow; a person's run in the unit thread spends the unit's clock, as today, and a busy answer that reaches the clock's reserve ends the unit `wall_clock_cap` with no fix, as today. `DispatchOptions.fixRound`, `buildShipFixTurn` and the "no sink" answer of `submit_dispositions` are deleted; the tool records what a coding run submits, wherever the tool lives after the harness series, and the runner matches the dispositions to the round's finding ids when it composes the re-review turn, dropping an id the review never issued with a note. The review child runs in a **review thread** the runner opens once per unit beside the coding thread; its worktree is its own and readonly, so no round wipes the coding worktree and the warm-worktree gap closes. A re-review continues the review thread's session once the review preset runs on pi, as the coding half arrives with the coding preset's move; the prior findings and dispositions still ride the follow-up's text, because the dispositions live on the coding run's record. On a deployment whose coding preset is still native, the findings step behaves as today's fix child did with the findings as the thread's request; the design's benefit for ship arrives with the flip to pi that the series makes.

Invariants: (1) a run's seed is exactly one of four sources and the run record names it, `seed: resume | parent | session | channel`, with the session's run id when it is one; (2) a session is continued only by a run of the same agent, on the pi harness, in the same thread, under a requester the authorize stage admits; (3) no code path composes a brief from a coding run's outputs for a later coding run.

Failure modes: the store lost the transcript: the run seeds from the channel and its record says `seed: channel` with the reason. A different person continues a session: the run is theirs under their grants, the repository gate covers the workspace they inherit, and the transcript they inherit carries tool results the Slack history did not (file contents, command output) from a repository they were just admitted to, the same content the run page shows anyone the `runs:read` predicate admits; decided, revisable if a deployment asks for per-person sessions. A person runs a read preset in a unit thread: admitted as today, and the mode switch reclones the coding worktree once, as today; the findings step still resolves to coding by directive. Growth: record 0035 decides it (the seed is the agent's notepad plus the log's newest turns within a budget, `recall` reaches the rest, and pi's compaction removes turns from the window and never from the log); this record first wrote "pi compacts". Two numbers this section lacks: a session's size, where r1's 41 turns are an example and what a coding session reaches by round two is unknown, measured by the first ten session-seeded runs' `model.turn` input tokens; and how often a follow-up lands in a thread that has a finished run of the same agent, which bounds the benefit outside ship, measured from the run history once the store lists runs by thread. The review thread costs a second worktree per unit on a resident sized for 16; two units in flight hold four.

The alternative it beat: resume the coding child's transcript for the fix round alone. It is one branch in `briefs.ts`, it reuses the crash path for something that is not a crash, so the run page says `resumed` about a run that was not, and it leaves every human thread rebuilding from Slack. Once the fix child is gone the general rule is smaller than the patch; the tally is in Boundaries.

## Children are readers

The constraint: the one fan-out Cognition allows is sub-agents that answer questions and never act in parallel with the main agent; ours may run `coding` and `ship`, in parallel, on prompts the conductor's model wrote, with nothing arbitrating two children on one branch.

Two paths start a run for another: `spawnChild`, the one way a run starts a run (the conductor's tools today, and the conductor's relay once it moves to pi, which calls the same function), whose children carry `parentRunId` at depth 1; and the coordinator's spawn route, which builds a message and calls `dispatch()` itself with the coordinator's tag, no parent and depth 0, for the plan runner's coding and review children. Everything in this section binds the first path alone; the runner's children stay coding and review.

The design: `spawnChild` refuses a preset whose `identity` is `write` by name, `spawn_identity`, beside `spawn_depth` and `spawn_fanout`. The rule reads the registry field, so a new write preset is refused the day it lands and no allowlist exists; `coding` and `ship` are refused, and `research`, `explore`, `general` and `review` stay because their identity is `read` or `none`. What a child keeps is the requester's own grants: `general` still writes issues, as the person could by hand; what no spawned child can do is push, open or merge. The conductor's prompt renders its child presets from the registry, as `help` renders its rows, and its "sees none of this thread" paragraph goes: a child seeds from the parent's **text turns**, the user and assistant text without the parent's tool exchanges, on either harness since the seed is a few turns, so a routed compound's child sees the whole message and its part, never a fragment, and never a `spawn_run` call its own toolset lacks; decided, revisable if children redo reads the parent made.

The compound form is narrowed in two places, because a prompt rule alone leaves the parse to collapse an off-table part onto the default agent, which would land a coding ask on `general`. The router's offer lists read-identity presets alone and says a write ask is never a part; and the parse, when a compound answer still carries a write-identity part, becomes a single route to that write preset with the message as typed as the request, so "review X and fix Y" is one coding run that reads the pull request and fixes it, and "research X and open a PR for Y" is one coding run that does its own research. The offline replay is re-run after the change: a compound that collapsed to a write preset is its own row, counted apart from the read-to-write row that must stay at zero, and judged by hand once at the re-baseline; the compound fixtures whose parts include `coding` expect `coding`, single.

Invariants: no run at depth 1 mints a write token; every child `spawnChild` starts names its parent run as its seed. Failure mode: a conductor asked for a write part says so instead of spawning; the refusal's name reaches its tool result as every gate's does.

The alternative it beat: delete the conductor. Its substrate, spawn and await, is the runner's; the read-only fan-out is the one shape both accounts allow; removing a preset later is a registry entry. Decided, revisable if the compound form goes unused.

## The unit is the reading unit

The constraint: the sub-agents post's third rule is one trace per run, and this system keeps a designed wall between author and reviewer, so the honest equivalent is one page per unit. The linkage exists, `parentInstanceId` and the unit row's rounds and thread; the view does not, and neither does a listing of runs by thread: `RunView` carries `threadKey` and `ListRunsOptions` cannot filter on it.

The design: the unit row gains its review thread; the run store gains a filter by thread key, which the seed lookup above needs first; a unit's story is then two listings in time order. A **unit page** composes the coding thread's runs and the review thread's runs at the runner's round boundaries, each run expandable to its own timeline; the parent record's page links its units, and a conductor's run page lists its children the same way. The data route ships first; the page's shape is checked in with the owner before dashboard work.

## Serial units

Decided: a plan's units run one at a time in dependency order, as the driver does today, and the gap row asking for parallel ready units is removed. Two units with no declared dependency can still introduce the same abstraction two ways; the rebase catches text, nothing catches meaning, and record 0031 appends a landed unit's deviations to its dependents alone. Wall time per plan is the cost, and the review loop per unit dominates it today.

## Why not X

- **Why not let the coding agent await its own review?** It puts the run tools in `full`, so every coding run can fan out (the run tools live in the conductor's toolset alone, `src/tools/workspace.ts:716`); it hands the model the loop's control flow and clock; and it holds a live run and its worktree through a review of up to 25 minutes. The runner already does the wait with no model turn.
- **Why not hand the reviewer the coding transcript too, if full traces are the rule?** A reviewer handed the author's reasoning inherits the author's blind spots. That post's handoffs split one job by stage; author to reviewer is a role boundary, the one human review keeps. The wall is designed; only the fix step's loss was accidental.
- **Why not keep one pi process alive per thread between runs?** An idle process per thread is a second lifecycle to fence, with a bearer to revoke and a pid to verify, on a resident sized for 16 thread users; record 0032 ties a process's life to a run's for the same reason. The session file is the durable form and costs one write the harness already does.
- **Why not hand the fix child the coding transcript as a document?** Tool calls and results flattened into text repeat the context in a shape the model did not see; continuing the transcript is the same turns in their own places.

## Boundaries

Not decided here: the runner's identity and merge grant (record 0031, unchanged); the harness (record 0032, unchanged; this record's pi half is what its second step and the last-turn prompt fix built); the unit page's visual shape. Compatibility: `agent:ship` on a task string, the review loop's caps and the `LGTM:` contract are unchanged; a thread that has never run, and every native run, behaves exactly as today; the conductor refuses two presets it accepted; the `fixRounds` delivery metric counts pushes between verdicts and is unaffected. Migration: nothing stored changes shape; the unit row gains one field and the run record one.

The tally for success criterion (5). Removed: `DispatchOptions.fixRound`; `buildShipFixTurn`; the `fix` brief kind; the "no sink" answer of `submit_dispositions`; the conductor's hand-written preset list; the "sees none of this thread" rule; the warm-worktree gap; and, for pi presets now and every preset once the series ends, the re-parse of a thread's user turns for its sticky agent and the routed-thread exception to stickiness. Added: the seed source with its harness condition; `spawn_identity`; the compound parse collapse; the review thread; the store's filter by thread key. The `findings` step replaces the `fix` spawn one for one, and the disposition id match moves from the tool to the runner. Nine removed, five added.

## What would change our mind

- If the first ten session-seeded coding runs average more input tokens per turn than a fresh run does by a factor the cost page notices, the seed narrows to the session's text turns and pi's compaction carries the rest. Evidence: the `model.turn` attrs of those runs against the ten before them.
- If the reviewer's memory across rounds narrows re-reviews, a finding a fresh reviewer would catch at round two that the continued one misses, the review thread becomes one per round. Evidence: the first ten units' round-two verdicts against their diffs.
- If the compound form goes unused once it offers readers alone, the conductor and the compound door are removed together. Evidence: the router's replay over a month of routes.
- If fewer than one follow-up in ten lands in a thread with a finished run of the same agent, the seed rule stays for ship's unit threads alone and the general rule is not worth its store read. Evidence: the run history, once it lists by thread.

Reversal at each step is the revert of one pull request; the seed source on the record lets a reverted deployment read the runs this design wrote.

## Rollout

Six pull requests through the review loop, each carrying its spec rows, each owned by a unit of the orchestration program plan as its owner amends it: (1) this record; (2) `spawn_identity`, the child's text-turn seed, the conductor prompt from the registry, the conductor spec; (3) the store's thread filter, the seed source in the dispatcher and on the run record, the store-read sticky agent for pi presets with the directive derivation kept for native ones, and the two-clause stickiness sentence on every surface that states the rule (routing-and-config items 3 and 21, thread-admission, the conductor spec's gap row, the Slack commands and configuration references, the config-layers page, a migrations line, and the run-history spec for the record's new field); (4) the runner's `findings` step and review thread, the fix child's deletion, the gap rows; (5) the compound offer and parse collapse in `route.ts`, after the router prompt change the maintainer has in progress, with the replay re-baselined and the fixtures whose parts include `coding` expecting `coding`, single; (6) the unit data route, then the page after check-in. The explanation pages follow once (2) to (5) are live. The harness condition on the seed rule and on stickiness disappears when the series' last step moves `general`, `research` and `conductor` to pi and deletes the native loop; the plan binds that to the same unit.

## Open questions

| Question | Owner | Resolves it | Before |
|---|---|---|---|
| The unit page's shape | maintainer | a mockup against one real unit | pull request 6 |
| A review thread per unit, or per round | maintainer | the first ten units' round-two verdicts | revisable after pull request 4 |

## Validation criteria

| Criterion | Proof |
|---|---|
| A follow-up on the pi harness in a thread with a finished run of the resolved agent seeds from its transcript without thinking blocks, with in-flight calls settled, then the channel's messages since it, then the request; a native run, a directive naming an agent with no session there, a thread's first run and a lost transcript seed from the channel; the record names the source and the session's run | `[gap]` pull request 3: `src/core/dispatch/messages.test.ts`, `src/core/runRecord.test.ts` |
| When the thread's most recent finished run is on the pi harness its agent is sticky and the router is not asked; when it is native the user-turn derivation stands and a routed thread routes again; a directive still wins either way | `[gap]` pull request 3: `src/core/dispatch/resolve.test.ts`, `src/core/dispatch/route.test.ts` |
| The run store lists a thread's finished runs newest first | `[gap]` pull request 3: `src/core/runStore.test.ts` |
| A child `spawnChild` starts seeds from the parent's text turns plus the prompt | `[gap]` pull request 2: `src/core/dispatch/spawn.test.ts` |
| A write-identity preset is refused as a `spawnChild` child by name; the coordinator's spawn route still dispatches coding and review; the conductor's prompt lists the registry's readers | `[gap]` pull request 2: `src/core/dispatch/spawn.test.ts`, `src/channels/adminCoordinator.test.ts`, `src/agents/registry.test.ts` |
| The runner dispatches findings into the unit thread as `agent:coding`, waits out a live run there under the unit's clock, and spawns no fix child; the review runs in the review thread; dispositions are matched to the round's ids; `DispatchOptions.fixRound` is gone | `[gap]` pull request 4: `src/core/ship/coordinator.test.ts`, `src/channels/adminCoordinator.test.ts` |
| Live: on a deployment with `harness.coding: pi` and `harness.review: pi`, a unit whose review requests changes is fixed by a run whose record names `seed: session`, and round two's review continues the review thread | `[agent]` pull request 4's receipt, human-gated |
| The compound offer lists readers alone; a compound answer carrying a write part collapses to that preset, single, with the message as its request; the replay's collapsed compounds are their own row and the read-to-write row stays at zero | `[gap]` pull request 5: `src/core/dispatch/route.test.ts`, `src/load/routeReplay.test.ts` |
| A unit's runs list in round order from one route | `[gap]` pull request 6 |

## Sources

- Cognition, "Don't build multi-agents" (cognition.com/blog/dont-build-multi-agents). "Sub-agents are just wrong" (dated 2026-09-14; on its author's staging site behind an access gate when this record was written, so its figures are the post's own and unverified here; the pull request that added this record carries the link).
- Records [0002](0002-dispatcher-is-the-only-orchestrator.md), [0011](0011-thread-admission-one-live-run.md), [0019](0019-durable-run-ledger-resume-after-kill.md), [0026](0026-capability-profiles-and-request-routing.md), [0029](0029-durable-objects-store-workflows-schedule.md), [0031](0031-the-coordinator-runs-a-plan-not-a-pull-request.md), [0032](0032-pi-is-the-harness-the-native-loop-retires.md); the specs `agent-ship`, `agent-conductor`, `thread-admission`, `routing-and-config`, `harness-pi`, `tracing`.

## Appendix A: the survey at `ea57f048`

| Fact | Where |
|---|---|
| A thread's history is the last 50 replies with the bot's status lines dropped and its other posts kept as assistant turns; the run's `context` events keep at most 20 turns within 256 KB | `src/channels/slack.ts:663-681`; `src/core/dispatch/reply.ts:301`; `src/core/dispatch/messages.ts:16-17` |
| The dispatcher seeds from the thread history plus the request, or on a resume from the ledger plan | `src/core/dispatcher.ts:293,519-525` |
| The runner's briefs are ids only; the bot composes the fix turn from the review run's findings and final reply, and the re-review turn from the prior review's findings and the fix run's dispositions | `src/core/ship/coordinator.ts:299-313`; `src/core/coordinator/briefs.ts:111-158` |
| The fix turn's text; the unknown-id check reads `fixRound.findingIds` | `src/core/ship/codingChild.ts:14-23`; `src/core/dispatch/runLoop.ts:389-393`; `src/tools/workspace.ts:433-444` |
| The coordinator's spawn route dispatches its children itself with the coordinator's tag, no parent, depth 0 | `src/channels/adminCoordinator.ts:517-561`; `src/core/dispatcher.ts:771` |
| The coding and review children share the unit thread; a coordinator's dispatch onto a live thread is refused `coordinator_thread_live`; a busy answer under the reserve ends the unit `wall_clock_cap` | `src/channels/adminCoordinator.ts:350-355,485`; `src/core/dispatch/admission.ts:322,388`; `src/core/ship/coordinator.ts:900-908`; `docs/reference/specs/thread-admission.md` item 8 |
| The coordinator's step routes have no findings step | `src/core/coordinator/driver.ts:80-81` |
| A thread reply's admission and a run's steer | `src/core/dispatch/admission.ts:325-345,474-518` |
| The spawn's gates, request text and thread lead | `src/core/dispatch/spawn.ts:138-162,214-240` |
| The conductor's prompt and preset list | `src/agents/registry.ts:422-446` |
| The preset identities and the harness default | `src/agents/registry.ts:474-592,505` |
| The run statuses and the record's validation | `src/core/runRecord.ts:38,545` |
| The run tools live in the conductor's toolset alone; `general` holds the issue writes | `src/tools/workspace.ts:657-660,691,711-716` |
| The routable table, the compound brief, and the parse that collapses an off-table part onto the default agent; the replay counts a compound as identity `none` | `src/core/dispatch/route.ts:68-78,228-260,466-473`; `src/load/routeReplay.ts:175-184`; `src/load/routeCompoundFixtures.ts` |
| Thread stickiness derived from the thread's user turns; a routed thread is not sticky | `docs/reference/specs/routing-and-config.md` items 2, 3 and 21; `src/directives.ts:43-53` |
| pi's session rebuild with thinking dropped, the seed split, the last-turn prompt, the re-attach path and the rebuild path | `src/core/harness/pi/mirror.ts:16-20,93-140`; `src/core/harness/pi/harness.ts:144-170,264-330`; `docs/reference/specs/harness-pi.md` item 9 |
| The run loop hands pi the built messages | `src/core/dispatch/runLoop.ts:474-476,523` |
| A resume settles the calls in flight with restart notes | `src/core/runLedger/resume.ts:95-152` |
| Native transcripts carry thinking blocks with signatures | `src/providers/types.ts:13-18`; `src/providers/anthropic.ts:237` |
| `RunView` carries `threadKey`; `ListRunsOptions` has no thread filter | `src/core/runsService.ts:67,153-171,268` |
| Units run one at a time | `src/core/coordinator/driver.ts:23-24,484-497` |
| The delivery metric counts pushes between verdicts | `src/core/delivery.ts:325-328` |
| The resident's worktree sizing | `docs/reference/specs/resident-repos.md`, the sizing section |
| The gap rows this record closes or removes | `docs/reference/specs/agent-ship.md`, the warm-worktree and parallel-units rows; `docs/reference/specs/agent-conductor.md`, the board and the spawned-thread stickiness rows |
