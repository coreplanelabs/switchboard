---
title: A run has one live state, owned by the server — a closed set from admitted to ended, one event the moment it changes, one projection and one wording function every surface reads
status: proposed
date: 2026-09-20
pattern: State machine as the one source of truth — the server assigns each run's live state from a closed union, appends a state event to the run's log when it changes, projects {state, since, bound, detail} onto the run summary, and one wording function beside the ending words renders it everywhere; the seven rival derivations are deleted
---

# A run has one live state, owned by the server: a closed set from admitted to ended, one event the moment it changes, one projection and one wording function every surface reads

**The ask.** Decide (the maintainer, 2026-09-20, after issue #2101 — a coding child sat 18 minutes in "attaching the workspace" while it was only waiting for a deploy's drain): "it should be a lot more clear in the pipeline agents/runs when looking at the UI that it's waiting for deploy to drain; this is not a stall; refactor all the possible states and ensure there is a single way this is managed throughout the app and is driven by the server data." Written for an engineer who knows the dispatcher, the run registry and the trace. Success criteria:

1. One closed set of live states the server assigns: **admitted → waiting for the deploy** (detail: the drain's `until`) **→ waiting for the repository's container** (detail: the refusal's words) **→ falling back to a sandbox** (seeded or fresh) **→ preparing the workspace → working** (the model turn or the tool call, with its bound) **→ wrapping up → ended** — the ended state carrying [record 0064](0064-the-plane-owns-every-runs-state-a-refusal-becomes-a-queue-position-an-ending-is-judged-by-the-ledger-that-saw-it-and-a-release-is-a-quiet-window-a-person-closes.md)'s endings and causes, extended where a cause is missing, never a rival set.
2. The state is recorded as an event in the run's log the moment it changes, and projected onto `RunSummary` as one field: `{state, since, bound, detail}` — `since` when the state began, `bound` the moment the state itself promises to be over by (the drain's `until`, the wake wait's maximum, the tool call's declared bound), `detail` the words of the fact that put the run there.
3. Every surface — the Slack and web card, the run page's header and timeline, the runs index, the plane table, the unit page, `runs get` and `runs list` — renders the run's live condition from that one field, through **one wording function** beside `endingCauseWords`. The seven rival sources are deleted as sources of the live condition.
4. The state words join [the vocabulary](../reference/vocabulary.md); internal words (drain, preflight, image gate, attach) never print; the drift check holds the line.
5. The judgements read the state, never the spans: `runs friction`'s `drain_wait` and `infra_failure` categories are the waiting states' intervals, and the plane's stuck and steer watches compare now to the state's own `bound` — a run inside its bound is never "stalled".
6. No waits or timers: every transition is an event some component already emits or can emit at the moment the fact arrives (the executor's refusal, the fallback's decision, the loop's turn boundary), on the event buses that exist.

## TL;DR

On 2026-09-20, during the 1.258.0 deploy, Boris's coding child (run `55c2a001`) opened `dispatch.workspace.attach` at 17:19:58Z and closed it at 17:37:59Z — 18 minutes 1 second, zero events in between — because the fleet was drained and then held by the image gate; the run then did its work in a seeded sandbox without complaint. For those 18 minutes every surface lied by omission: the card read `◑ coding · Nm` (a timer, no cause), the plane's health column was empty, and `runs friction` afterwards counted `drain_wait: 0` because the category is computed from events the wait never emitted. The run was never stalled — it was waiting for a deploy to drain, a state the system knew (the resident client was polling the drain's own `until` every 30 seconds) and printed nowhere. The bet: one closed set of live states, owned by the server, written to the run's log as an event the moment the state changes, projected onto `RunSummary` as `{state, since, bound, detail}`, and worded by one function beside `endingCauseWords` — every surface reads the one field, and the seven rival derivations of "what is this run doing" are deleted. Doing nothing keeps seven part-truths that agree only when nothing interesting is happening.

## Today at `c584a0ce`

A run's live condition is printed from seven rival sources with no shared model:

| Source | What it says | Why it fails the drain wait |
| --- | --- | --- |
| Span display names (`src/core/trace/displayNames.ts`) | `"dispatch.workspace.attach": "attaching the workspace"` — the open span's noun becomes the activity line | A span is not a state: the drain wait, the container wait and the wake wait all hide inside one 18-minute `dispatch.workspace.attach` span with zero child events (run `55c2a001`, seq 16 → 17, `durationMs: 1081173`) |
| The card's setup note (`src/core/statusCardFrame.ts` `setSetupLabel`; fed by `onSetupNote` in `src/core/dispatch/provision.ts`) | Free text pushed at the card while provisioning | Slack/web card only — no event, no record; the run page, the plane and `runs get` never see it; whether the drain note rendered on #2101's card is unverifiable because nothing was recorded |
| `RunSummary.activity` / `inFlight` (`src/core/runRegistry/projections.ts`) | The last tool call and the call without a result yet, with its declared bound | The last tool, not the wait: before the loop starts there is no tool, so the whole provisioning phase projects nothing |
| The shape buckets (`src/core/runShape.ts`) | Post-hoc partition: `getting ready · thinking · in tools · finishing up` | "getting ready" swallows every wait — a 6-minute drain wait, an 11-minute image gate and a 2-minute clone are one bucket, and only after the run ends |
| `run_note` kinds (`src/core/runEvents.ts`, `RunNoteKind` — about twenty) | Facts appended to the log (`drain_wait`, `fleet_busy`, `sandbox_restarted`, …) | Facts, no machine: each note is written after its episode by whoever noticed, nothing says what the run is in *now*, and #2101's wait wrote none |
| The plane's health words + `PlaneEndingCause` / `endingCauseWords` (`src/core/plane/table.ts` `RunHealth`, `src/core/plane/decide.ts`) | `stalled`, `bound-exceeded`, `no-signal`, … over live rows; one wording function over endings | The right shape — a closed union, one wording function — but endings and alarms only: there is no vocabulary for a healthy wait, so #2101 showed `health: []` while the person saw a stall |
| Friction categories (`src/core/runFriction.ts`) | `drain_wait`, `infra_failure`, … computed from the run's events after it ends | Blind to a wait that emits no event: `drain_wait` counted 0 on #2101 — the category exists, the event never did |

Each source was added to answer one surface's question; none owns the answer, and the one component that knew the truth minute by minute — the resident client polling `awaitDrainEnd` (`src/execution/resident.ts`) and the wake wait (`src/execution/residentWake.ts`, `WAKE_WAIT_MAX_MS`) — reports to none of them.

## The shape

**The set.** One closed union of live states, in the order a run can pass through them (every run passes through a subset; only `ended` is mandatory):

| State | Enters when | `bound` | `detail` |
| --- | --- | --- | --- |
| admitted | the plane admits the run, before the dispatcher reaches a workspace | the lease | the queue position when it had one |
| waiting for the deploy | the resident's attach is refused by a drain (resident-repos item 69) | the drain's own `until`, capped by the fallback rule below | the refusal's words |
| waiting for the repository's container | the attach is refused because the repository's container is restoring or restarting (the image gate, the wake wait) | the wake wait's maximum | the refusal's words (`image-stale: …`, `attach-failed: …`) |
| falling back to a sandbox | the executor gives up on the resident and provisions cold | the provision's budget | `seeded` (from the resident snapshot) or `fresh` (no seed found) |
| preparing the workspace | the workspace exists and setup runs (checkout, branch, deps) | the setup budget | the step |
| working | the loop runs | the in-flight tool call's declared bound, or the turn's | the model turn or the tool call |
| wrapping up | the loop ended, the record has not closed (the wind-down, the description, the handoff) | the wrap-up window | — |
| ended | the record closes | — | record 0064's ending and cause, extended where a cause is missing — never a rival set |

**Who assigns it.** The server owns the state: the dispatcher and the run registry assign every transition they can see (admitted, falling back, preparing, working, wrapping up, ended). The two wait states are visible only inside the executor seam — the resident client is the component holding the drain's refusal and the container's refusal in its hands — so the resident client *emits* those transitions, through the same seam its spans and notes already travel, and the server records them; the client never renders anything and never owns the set. A client that dies mid-wait leaves the last state standing with its `since` and `bound`, which is exactly what the plane's watches need to judge it.

**The event.** Each transition is one event in the run's log, written the moment the fact arrives — the refusal answered, the fallback decided, the turn opened — never on a poll or a timer (the constraint in force: event buses, no waits). The event carries `{state, since, bound, detail}`; the log stays the run's one history, so the run page's timeline is the state history for free, and a record read cold after a restart reconstructs the live field from its last state event (the web derives from `RunRecord`, unchanged).

**The projection.** `RunSummary` gains the one field `{state, since, bound, detail}`, projected from the last state event. Inside `working`, the `detail` and `bound` ride the registry's existing in-flight tracking (the tool call and its declared bound) without a log event per tool call: the log records state *boundaries*; the projection refreshes the working state's detail from `inFlight`, which the registry already maintains. That is the one deliberate asymmetry, and it is bounded: a surface that reads only the log still knows the run is `working` and since when.

**The wording.** One function beside `endingCauseWords` — the same module discipline record 0064 set for endings — turns `{state, since, bound, detail}` into the user's words: "waiting for the deploy to finish · until 18:21Z at the latest", "waiting for the repository's container · restarting", "falling back to a sandbox · from the repository's snapshot", "working · running tests · up to 10 min". The state words join the vocabulary page as values of the run noun's live condition; internal words (drain, preflight, attach, image gate) never print, and the vocabulary drift check holds it.

**The deletions.** The rivals are deleted *as sources of the live condition*: the card's `onSetupNote` free-text channel goes (the card renders the state field); the activity line stops being the raw span noun (the span names remain for the timeline's rows, where a span is the right unit); `runShape`'s buckets remain the *finished* run's retrospective shape line and are never printed as a live condition; `run_note` facts remain facts and stop being any surface's guess at "now"; the plane's health words become judgements *over* the state and its bound rather than a parallel vocabulary; friction reads the state intervals from the log instead of hunting for episode notes.

## One trace: run `55c2a001`, 2026-09-20, minute by minute as it would render

Boris's coding child for the target repository, admitted during the 1.258.0 deploy (issue #2101's timeline). Left column the fact, right column what every surface — card, run page header, plane table, `runs get` — would say from the one field. What it actually said, the whole 18 minutes: `◑ coding · Nm`.

| Z | The fact | The state event and its rendering |
| --- | --- | --- |
| 17:19:58 | dispatch reaches the resident; the attach is refused: the fleet drained at 17:16:59, refusing new runs until 18:21:58Z | **waiting for the deploy** · since 17:19 · until 18:21Z at the latest — the card says it, the plane's row says it with no health flag (inside its bound is healthy), the run page timeline gains the event |
| 17:26:16 | the swap lands; the fleet stays closed on the image gate; the retried attach is refused with the container's words | **waiting for the repository's container** · since 17:26 · "the container predates the current pool and is restarting" — the detail is the refusal's own sentence, worded for the user |
| 17:34:30 | the container's restore completes; the report is still pending; the attach still refuses | same state; `since` unchanged (17:26) — the person sees one wait of 8 minutes, not a fresh state per retry |
| 17:37:59 | the wake wait's bound expires; the executor gives up on the resident and seeds a sandbox from the repository's snapshot | **falling back to a sandbox** · seeded — a state, an event, ten seconds of it |
| 17:38:0x | the sandbox is up; checkout, branch, deps | **preparing the workspace** · since 17:38 |
| ~17:40 | the loop starts | **working** · the model turn, then each tool call with its bound as the detail — the projection's `inFlight` refresh, no log event per call |
| later | the loop ends; description and handoff land; the record closes | **wrapping up**, then **ended** — record 0064's ending and cause, worded by `endingCauseWords` as today |

And the judgements, on the same field: `runs friction` reads `drain_wait: 6m18s` (17:19:58–17:26:16) and `infra_failure: 11m43s` (the container wait) from the state intervals instead of `drain_wait: 0` from absent notes; the plane's stuck watch stays quiet the whole wait because now never passed the state's `bound`, and would have flagged `bound-exceeded` at 18:21:58Z had the drain overrun — the flag the person can trust because it is the exception, not the silence.

## The difficulty map

1. **The two wait states cross the executor seam** (most consequential): only the resident client sees the drain's refusal and the container's refusal, so the transitions must travel from inside the seam to the server's log without giving the client ownership of the set or a side channel past the registry. The client emits, the server records and assigns; a client that stops emitting leaves a state whose `bound` the watches judge. Getting this seam right is unit one's hard half.
2. **`working` without an event flood**: a log event per tool call would multiply the run log by the tool count. The boundary/refresh split (events at state boundaries, `detail`/`bound` refreshed from the registry's existing `inFlight`) keeps the log small, but it means "recorded the moment it changes" must be stated precisely in the spec: the *state* changes at boundaries; the working detail changes without a log event, and a cold read of the record knows the state and its `since` but not the last tool. If that residual proves confusing, the fix is a bounded sampling of the detail into the log, by amendment.
3. **Deleting seven sources without losing their surfaces**: each rival feeds rendering paths with their own tests and spec rows (the card frame, the runs index, the plane table, friction). Unit two is mostly deletion, and deletion is where a surface silently goes blank — the cold-reader gate below exists for exactly this.
4. **`ended` must extend, never rival, record 0064**: the plane's `PlaneEndingCause` and `endingCauseWords` are the accepted ending model; the live-state union ends by *pointing into* it. A second ending vocabulary — even an innocent-looking one on the new field — recreates the disease this record cures.
5. **Bounds without timers**: every waiting state's `bound` comes from the fact that created it, and the watches compare now to it on the events they already receive. No new timer, no poll — the constraint in force — which means a state whose creating fact carries no bound (a refusal with no `until`) needs a stated default from the budgets module, not an invented clock.
6. **The vocabulary cost**: eight state words become user-facing nouns' values, each needing a wording row, a vocabulary entry and the drift check's blessing; the refusals' raw words (`image-stale`, `attach-failed`) are internal and must be translated at the boundary, never printed.

## The hard parts

**The witness is not the owner.** The deepest asymmetry: the server owns the state machine, but for the two wait states the only witness is the resident client inside the executor. The design accepts that split rather than hiding it — the client emits the wait transitions it alone can see, the server records and projects — because the alternative (the server inferring waits from the absence of progress) is a timer and a guess, both banned. The cost is a protocol: the emit path must survive the client's death (last state stands, `bound` judges it) and the deploy window itself (the state events of a run admitted mid-deploy travel the same seam the deploy is draining).

**One field that is honest after a restart.** The web derives from `RunRecord`; the card can be rebuilt from channel history; the registry dies with the process. The state field must reconstruct from the log alone — its last state event — so the projection is a fold, not a memory. The working state's `inFlight` refresh is the one part that does not reconstruct, and the design says so out loud rather than pretending.

**The wording function's temptation.** With one function rendering eight states on seven surfaces, every surface will want its own flourish ("the card needs it shorter", "the table needs it without the detail"). The line to hold, from record 0064's endings: the *words* are one function's; a surface may truncate or omit a part, never re-word it. The moment two wordings of one state exist, the drift check is the only thing standing between this record and the seven-source swamp it replaces.

## Why not X

**Why not fix the spans — give the drain wait its own child span?** Issue #2101's live fixes do add the spans, and the timeline needs them. But a span is a duration with a name, not a state: it cannot say what the run is in *now* without a reader walking the open spans and guessing, which is exactly today's activity line. The span answers "what happened"; the state answers "what is happening"; both exist, one renders the live condition.

**Why not push richer setup notes at the card?** `onSetupNote` is the disease in miniature: free text, one surface, no event, no record — #2101 cannot even establish whether the drain note rendered. A state event is the note with a type, a bound and a history.

**Why not extend the plane's health words to cover waits?** The health words are judgements (something is wrong); a wait is a condition (nothing is wrong yet). Making `stalled`'s siblings cover healthy waits would put the plane in the business of narrating every run's normal life, and the plane's table already carries the run rows — it should read the state like every other surface, and keep its words for exceptions.

**Why not a per-surface mapping table instead of deleting the rivals?** A mapping keeps seven sources and adds an eighth artifact that claims they agree. The incident's lesson is that part-truths do not compose; the fix is ownership, not reconciliation.

## Boundaries

Out of scope, deliberately: issue #2101's two live units — bounding the drain wait by the fallback's own cost instead of the deploy's, and making the new-image report the fresh container's own start so an attach never restarts the container it cannot verify. Those change *how long* the waits last; this record changes *whether anyone can see them*. Also unchanged: record 0064's ending model and the plane's admission (this record's `ended` points into them), the trace and its timeline (spans remain the timeline's rows), the finished run's shape line (retrospective, never live), and the card's transport.

## Rollout

Three units, in dependency order, one plan in the same pull request series as this record's acceptance:

1. **Unit one — the server**: the closed set, the state event in the run's log, the `{state, since, bound, detail}` projection on `RunSummary`, the wording function beside `endingCauseWords`, and the vocabulary rows; the resident client emits the wait states only it can see, through the executor seam.
2. **Unit two — the surfaces**: the Slack and web card, the run page header and timeline, the runs index, the plane table, the unit page, `runs get`/`runs list` all read the one field through the one function; the rival sources are deleted as sources of the live condition (`onSetupNote`, the activity line's raw span noun, the live use of the shape buckets).
3. **Unit three — the judgements**: friction's `drain_wait` and `infra_failure` read the state intervals; the plane's stuck and steer watches read the state and its `bound`, never spans.

The gate before the adversarial review is the **cold-reader test**: a person who knows nothing of this record is shown each surface during a staged drain and asked what the run is doing — the record passes when the answer is "waiting for a deploy, until about N" on every surface, and fails on the first surface that still needs the reader to know the system. Run `55c2a001`'s timeline, replayed against the staged drain, is the fixture.

## Sources

- Issue #2101 — the incident this record answers: the 18-minute silent attach, the timeline, the three defects (two of them the live units out of scope here).
- Run `55c2a001` (2026-09-20 17:19:58Z–17:37:59Z) — the hard-case trace's facts: one span, zero events, `drain_wait: 0`, `health: []`.
- [Record 0064](0064-the-plane-owns-every-runs-state-a-refusal-becomes-a-queue-position-an-ending-is-judged-by-the-ledger-that-saw-it-and-a-release-is-a-quiet-window-a-person-closes.md) — the ending causes and their one wording function, the pattern this record extends to the live side.
- [Record 0066](0066-a-user-meets-twelve-nouns-and-no-others-the-vocabulary-is-a-reference-page-bound-to-the-code-and-the-consistency-check-fails-a-user-surface-that-prints-an-internal-word.md) — the vocabulary as the prime reference and the drift check the state words join.
- `src/core/trace/displayNames.ts`, `src/core/statusCardFrame.ts`, `src/core/dispatch/provision.ts`, `src/core/runRegistry/projections.ts`, `src/core/runShape.ts`, `src/core/runEvents.ts`, `src/core/plane/table.ts`, `src/core/plane/decide.ts`, `src/core/runFriction.ts` — the seven rival sources at `c584a0ce`.
- `src/execution/resident.ts` (`awaitDrainEnd`), `src/execution/residentWake.ts` (`WAKE_WAIT_MAX_MS`) — the waits' witnesses, reporting to no surface today.
