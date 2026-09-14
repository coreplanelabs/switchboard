---
title: A session's log outlives its runs in one searchable object; a run seeds from its notepad and the log's tail and recalls the rest; compaction is a pointer, never a loss
status: proposed
date: 2026-09-14
pattern: Append-only log with a search index as the store of record; a working-notes document beside it; the context window as a cache over both
---

# A session's log outlives its runs in one searchable object; a run seeds from its notepad and the log's tail and recalls the rest; compaction is a pointer, never a loss

**The ask.** Decide: adopt this as the storage and growth half of record 0034's session rule, before the program's PR 3 (the seed rule, unit U34) is built, because that rule has nothing to seed from once a run finishes and this record says what it seeds from instead. Owner: the maintainer, who on 2026-09-14 named the published Astra approach (a rolling log kept whole, a notepad the model keeps across context windows, earlier windows searchable by the model) as "highly relevant and something we should consider in our design". Written for an engineer who knows the run ledger (record 0019), the pi harness (record 0032) and record 0034.

Success criteria: (1) nothing said or observed in a session is ever out of the agent's reach, whatever the window holds; (2) a follow-up in a thread starts from what the last run knew, not from 50 Slack replies; (3) a compaction changes what the model holds, never what exists; (4) a resume rebuilds the conversation its run had; (5) storage per session is bounded by the same retention as run records.

## TL;DR

Record 0034 seeds a follow-up from the transcript of the thread's last finished run, and that transcript does not exist: the ledger clears it when the run finishes, leaving a record whose tool outputs are cut to 8,000 characters. Its growth answer, "pi compacts", is a summary pi writes past a threshold we never set, and the Astra launch post says a compaction leaves out why a fix failed or how a component behaves. The bet: one **session log** per thread and agent, append-only with a full-text index, is the store of record; a run is a range of it, the seed is the agent's **notepad** plus the log's newest turns within a budget, and `recall` reaches everything before, so compaction removes turns from the window and never from the agent's reach. The cost is moving the transcript store from one object per live run to one per session, two tools, one steer per compaction, one range read per follow-up and a retention rule. Open are the seed budget, recall's quality on code-shaped text, and whether pi's compaction event carries its summary.

## Today at `6d26cf02`

The five facts the design turns on; the survey is Appendix A.

| You would expect | Today |
|---|---|
| A finished run's transcript is kept | One object per live run holds the raw turns; the ledger clears it best-effort when the run finishes or is abandoned (`src/core/runLedgerWorker.ts:266,275`), and nothing else sweeps it. What survives is the record: tool output cut to 8,000 characters, each event to 64 KiB, the record to 1.5 MiB with middle events dropped. |
| Compaction is ours to tune | pi exposes the knobs and we set none (`src/core/harness/pi/process.ts:212`); the declared window is 200,000 tokens whatever the model (`process.ts:174`), so pi summarizes at about 183,600 and keeps the newest 20,000 verbatim. The trace is a note whose counts are prose (`src/core/harness/pi/bridge.ts:342`); the mirror writes no compaction row, so a resume rebuilds the raw turns and pi compacts again (record 0032, line 191). How often a run compacts is unmeasured: coding on pi is behind a deployment flag. |
| A model can look back at what it saw | No tool reads a run's earlier turns: `get_run_status` returns the final reply alone (`src/tools/runs.ts:78-81`); the runs store reads events by sequence only; the one full-text index in the state Worker is the memory store's (`deploy/cloudflare-memory/worker.ts:259`). |
| Memory is the agent's notes | Memory is cross-thread distilled knowledge, org, user, repo and channel scopes, written by a reflection pass the model cannot call, "never a raw transcript" (`src/core/memory/types.ts:8-11`), injected as at most 8 records and about 800 tokens. |
| A failed transcript write ends the run | It detaches it: a refused or twice-failed step write leaves the run running untracked with one warning (`src/core/runLedger/writeThrough.ts:8-13`). |

## The shape

A **session log** is one Durable Object per session (a thread and an agent, the pair record 0034 defines; keyed `<threadKey>:<agent>`): the transcript rows as they are today, in order, for every run of the session, each run's first row its request; pi's compaction entry as a row where pi's event carries the summary; a full-text index over the text of every turn and tool result; and one **notepad** row, a document of at most 8 KiB the agent writes. The log is the transcript store because it is the only place both readers find what they need: a run appends its turns as it goes under the ledger's write-ahead rule and fence, its row keeps its range, a resume reads the range and a follow-up reads the tail, and nothing is cleared at finish. A run **seeds** from the notepad, then the log's newest turns within a **seed budget**, then the request; `recall` searches the turns before and reads a named turn whole; the agent keeps the notepad through `notes`; the notepad rides the system prompt at run start and is steered into the context after a compaction that leaves a turn queued. Compaction stays pi's and stays on; what changes is that it can no longer lose anything. The shape is Astra's context in Codex with one difference: the log here is already the durable store the ledger writes for resumes, so search and notes attach to an object that exists.

## One trace: a fix round across a compaction and a bot death

Two runs of one coding session on the pi harness, a compaction inside the first, a death inside the second, and the second needing a detail the compaction dropped.

1. A unit's coding run r1 starts in its thread. The thread has no coding session, so the runner opens the session log; r1's request is row 0, its range starts there, and its seed is the channel plus the contract, as record 0034 has it for a first run.
2. r1 runs the tests at turn 37; the result is 40 KB of vitest output naming one failing case. The mirror appends the assistant turn before the tool runs and the result after; the record keeps the same events cut to 8,000 characters as today.
3. r1 keeps a helper in one file and writes to its notepad: the decision, the failing case's name, the head the tests were green at. The `notes` call and its result are turns 61 and 62; the notepad row is replaced whole.
4. pi compacts. The bridge writes the `compacted` note, appends pi's compaction entry as a row where the event carries it, and, because a turn is still queued, steers the notepad plus one sentence that `recall` reaches every turn before the summary.
5. r1 pushes `h1`, submits its description and handoff, and settles. Its range closes at turn 212 on the finished record. Nothing is cleared.
6. The review requests changes; the runner's `findings` step dispatches into the thread as `agent:coding`. The dispatcher reads the session's tail by index, newest first, until the seed budget (60,000 tokens at 4 characters a token) is met at a boundary that begins with a user text turn: turn 148. r3's row records `seedFrom: 148`; its request is row 213 and its range starts there.
7. A finding says the failing case from turn 37 was fixed by loosening an assertion. The model calls `recall` with the case's name; the search returns turn 37 whole, under the 120,000-character tool result cap; the model reads the original failure and fixes the code instead.
8. The bot dies mid-push. The next generation reclaims r3 and rebuilds its conversation from rows 148 to 260 under a system prompt composed now, notepad included; pi still answers in the container and continues on the same session.
9. r3 confirms `h2`, updates the notepad, and settles; its range closes at turn 260.
10. Round two's review approves; the runner merges. Once every run of the session has left retention and none is live, the sweep drops the session log whole.

The property: the detail the compaction dropped reached the agent that needed it, the resume rebuilt the conversation its run had, and the window carried a summary, the notepad and the recent turns rather than the whole log.

## The difficulty map

1. **The session log as the one transcript store** (most likely to be wrong, most work): the ledger's write-ahead, fence and detach rules on an object successive runs share, a run as a range, what a resume rebuilds, the clear ending, the sweep, storage. Section "The session log".
2. **The seed budget**: how much of the tail a run starts from, against a window pi is told is 200,000 tokens whatever the model. Section "The seed".
3. **Recall on code-shaped text**: FTS5's default tokenizer against identifiers, paths and error strings. Section "Recall".
4. **The notepad**: its size, its injection points, what the prompt tells the agent to keep in it. Section "The notepad".

## The session log

The constraint: the ledger writes a run's turns to one object per live run, refuses a part the row cannot hold rather than truncating (`src/core/runLedger/transcript.ts:50-53`), writes each step before its tools run so a resume can settle the calls in flight, fences every write by the generation that holds the lease, detaches a run whose write is refused or fails twice rather than ending it, and clears the object at finish because a resume was its only reader. Record 0034 gave it a second reader, the next run in the thread, and the object is gone by then.

The store moves to one object per session because both readers want one place: a follow-up wants the thread's turns in order, `recall` wants one index, and the notepad wants a home. The rows are the transcript rows as they are today (turn index, part, JSON; attachments over 1,000,000 base64 characters stored once and referenced), appended by whichever run is live in the session under the same fence, and under the same `INSERT OR REPLACE` on `(idx, part)` so a new generation overwrites a zombie's late row as today; the index entry for the old row is deleted before the new one is written, since an external-content FTS5 table is told about deletions and never notices a replaced row on its own. Thread admission gives the log one writer at a time (`thread_key UNIQUE` on the live rows), and a coordinator's dispatch onto a live thread is refused as today.

A run's row gains `seedFrom` and `range`, the log index its seed began at and the indices its own turns occupy, the request first; the finished record carries both, since finish deletes the live row. A resume rebuilds the conversation from `seedFrom` to the end of the range under a system prompt composed at the resume, notepad included. A compaction row inside that span is the summary pi wrote of everything before it, so a session file rebuilt from the span gives pi the window it had: the summary and the turns after it. Where pi's event carries no summary, no row is written, the rebuilt span is the raw turns and pi compacts again on its first turn, which is today's behavior; the open question below decides which of the two a deployment gets, and both keep invariant (3).

A detached run keeps running as today and its row is marked `range: broken`; the next run in the session seeds from the channel with a note naming the hole, and `recall` says the log has a gap when a search spans it, so a Worker outage costs a session its continuity and never its honesty. Finish writes the record and closes the range; it clears nothing. The full-text index is an external-content FTS5 table over the text parts, so the rows are stored once; tool results index as text, so a test name in a failure output is findable. Retention: the object lives while any run of the session is within the run-history policy (30 days, 5,000 runs, 2 GiB by default) or holds a live row; the sweep drops a session object only when every run of that session is gone from the kept records and none is live, clearing the owner row first so a late write is refused, then the rows. The dispatch path pays one range read per follow-up, bounded by the seed budget at about 240 KB, and the store pays the rows it writes today plus the index.

Invariants: (1) every turn a model in a session saw or wrote is a row in the session's log, or the run's row says `broken`; the record is derived from the rows, never the other way; (2) a run's range is contiguous, begins with its request, and is closed at finish; two runs of one session never overlap; (3) a resume rebuilds the rows from its `seedFrom` to the end of its range and nothing else; (4) a write from a generation that does not hold the run's lease is refused, as today.

Failure modes: a turn over the 1.5 MB part budget is refused as today; with tool results capped at 120,000 characters and attachments externalized, no turn reaches it. A session object lost: the next run seeds from the channel and its record says `seed: channel` with the reason. A follow-up that lands while the previous run is being reclaimed: admission sees the live row and folds the message into that run's inbox, as today, so the range never overlaps. Storage: a coding session with heavy tool output is tens of megabytes over its life against Cloudflare's 10 GB per SQLite-backed object; the distribution cannot be measured today because the objects are cleared at finish, so the record's event bytes are the floor and the first ten sessions' row totals are the measurement.

The alternative it beat: keep one object per run and stop clearing it. Under record 0034 alone each run's object would hold every earlier turn, so a follow-up's seed would be one read; the seed budget this record adds stops that re-copying, and then a follow-up is a stitch across N objects, `recall` is N queries merged, the notepad has no home, and the bytes multiply by the number of runs until then.

## The seed

The constraint: a session's log outgrows any window, and a seed that hands the whole log to pi forces a compaction on the first turn, the cost record 0034 names as more input tokens per turn. pi is told a 200,000-token window whatever the model runs, and the harness sets none of pi's compaction knobs today.

The seed is bounded because the window is: the notepad, then the log's newest turns whose text fits the **seed budget**, 60,000 tokens estimated at 4 characters a token as the memory block estimates, read from the object by index range newest first, never the whole log into the Worker, cut at a boundary that begins with a user text turn so pi's session file opens as the provider requires and no tool call is parted from its result, then the request. Decided, revisable: the number is a third of pi's declared window, leaving the rest for the run's own work. The row's `seedFrom` names the turn the seed began at, so `recall` and a person both know where the window started. A seed whose newest boundary alone exceeds the budget takes the notepad and the request and says so in a note.

Failure mode: a session whose recent turns are all large tool outputs seeds with few turns of conversation; the notepad carries the state across, which is why the prompt tells the agent to keep it current before long tool runs.

## Recall

The constraint: FTS5's default tokenizer splits on punctuation, so `residentFleet.ts` indexes as two tokens and an error string as its words; a model searching for a symbol finds it, and one searching for an exact path finds its pieces.

`recall { query, limit? }` searches the caller's own session log and returns up to `limit` (default 5) matching turns as `{ turn, role, snippet }`, newest first; `recall { turn }` returns one turn whole, capped by the runner's 120,000-character tool result cap with the usual truncation marker. Both read the session the run belongs to and nothing else; the session is the requester's thread, so the `runs:read` predicate that gates `get_run_status` gates these, and a denied read is an empty result. The tool is relayed like every bot-side tool under pi, so it works on the harness the session rule applies to. A query with no hit says so and suggests the notepad; a first run is told the log begins with it; a search across a `broken` range says so.

The alternative it beat: an embedding index. It finds paraphrases FTS misses, costs a model call per turn indexed and a second store, and the model searching its own log knows the words it used; if recall's hit rate says otherwise (below), the index changes and the tool's shape does not.

## The notepad

The constraint: the summary a compaction leaves is pi's and drops what pi judged unimportant beyond the newest 20,000 tokens; the agent knows better what it will need, and a follow-up run needs that knowledge before it has read anything.

One document per session, at most 8 KiB, written whole through `notes { text }`, so the call and its result are turns in the log and the notepad's history is the log's. It is read at three points: rendered into the system prompt at every run start under a heading naming it the agent's own notes for this thread (the prompt is composed per run, so a resume gets the notepad as it stands); steered into the live context after a `compaction_end` that leaves a turn queued, at pi's next turn boundary, with the sentence that `recall` reaches every earlier turn (a compaction at the end of a run needs no steer, since the next run's prompt carries the notepad); returned by `notes {}` on demand. Every pi preset's prompt says what belongs in it, decisions and their reasons, names of things found (failing tests, heads, files), what is not yet proven, and that the notepad is the one thing sure to survive a compaction and reach the next run. The record keeps the final text as a `notes` event so the run page shows it. Decided, revisable: 8 KiB, about 2,000 tokens, is a page of notes and about one thirtieth of the seed budget.

Failure mode: an agent that never writes notes gets today's behavior plus recall; one that writes too much hits the cap and the tool answers with the size and a request to trim.

## Why not X

- **Why not rely on pi's compaction summary, since record 0032 makes the record a superset of the model's context?** A superset the model cannot read is a superset for people; the only fix for a summary that dropped what a later step needs is a way back to the originals from inside the run.
- **Why not tune pi's compaction instead?** Raising `keepRecentTokens` or the reserve moves the threshold and disabling compaction meets the window; either delays the loss or trades it for the trap 0034 tied the seed rule to the pi harness to avoid. The knobs stay available for the budget; they do not make anything reachable.
- **Why not persist pi's own session file and index that?** It lives in the container, is deleted at detach, is one process's tree in pi's format, and the native presets never have one; the mirror already writes its content to the ledger in the runner's vocabulary. The one thing worth taking from it, the compaction entry, this record takes as a row.
- **Why not make memory the notepad?** Memory is distilled knowledge across threads, written by a reflection pass after the reply, injected as 8 records within 800 tokens, off by default, and by its own type "never a raw transcript". A notepad is one agent's working state in one thread, written by the agent mid-run.

## Boundaries

Not decided here: record 0034's rule for which runs seed from a session (pi presets, same agent, same thread; unchanged, this record says what they seed from); the unit page and any search UI for people, which shares this index and follows the check-in the maintainer asked for before dashboard work; whether the native loop ever reads a session (it does not; it retires). Compatibility: a run on a deployment without the session object seeds from the channel and says so; `RunTranscriptDO` stays bound for one release so runs live at the deploy finish on the object they started in, then a `deleted_classes` migration removes it and its objects, the path the friction store already took. Migration: nothing stored changes meaning; rows without `range` and `seedFrom` are runs of the old shape and resume from their own object until that release.

## What would change our mind

- If fewer than one `recall` in ten finds what the agent looked for (judged from the next turn using or discarding the result), the tokenizer changes first (a trigram tokenizer for identifiers), and an embedding index after. Evidence: the `recall` tool events of the first ten sessions.
- If the first ten sessions' runs spend more than half their turns before the first tool call reading the seed, the budget halves. Evidence: `model.turn` input tokens on the first step against later steps.
- If agents leave the notepad empty in more than half of sessions that compacted, the prompt's instruction is wrong or the tool is, and the harness writes a first draft of the notepad from the compaction summary itself. Evidence: `notes` events against `compacted` notes.
- If fewer than one coding run in twenty compacts once coding runs on pi by default, the steer and the compaction row stay and the seed budget is what matters. Evidence: `compacted` notes over the first hundred pi coding runs.
- If a session object's rows pass 500 MB inside retention, the log gains a tail-only retention for tool results and the record changes. Evidence: the row totals the sweep reports.

Reversal: the session object reverts to per-run objects by one pull request while runs in flight finish on the object they started in; the tools and the steer are one revert each.

## Rollout

Two pull requests under unit U34, in order, then one under U35: (1) the session log as the transcript store: the object with its external-content index, the row's `seedFrom`, `range` and `broken`, the write and resume paths over it, the compaction row, the end of the clear at finish and abandon, the sweep's live check and owner-first drop, with the ledger's own tests over the fence, the detach and the range; (2) the seed budget in the dispatcher, the `recall` and `notes` tools relayed to pi, the notepad in the system prompt and the compaction steer, the prompts' notepad instruction, and the spec rows in run-history, thread-admission, harness-pi and a new session spec; (3) search on the unit page, after the check-in. Record 0034's PR 3 becomes (2) here, on top of (1); `RunTranscriptDO`'s deletion is the release after (1).

## Open questions

| Question | Owner | Resolves it | Before |
|---|---|---|---|
| Whether pi's `compaction_end` event carries the summary text, so the log can hold the compaction row and a resume rebuilds the compacted window | maintainer | one compaction on a staging pi run with the bridge logging the event whole | PR (1) |
| The seed budget's number | maintainer | the first ten sessions' first-step input tokens | revisable after PR (2) |
| Whether tool results index whole or only their first N KB | maintainer | recall hit rate and index size on the first ten sessions | PR (1) |

## Validation criteria

| Criterion | Proof |
|---|---|
| A run's turns append to its session's log before its tools run, under the run's generation fence and the `(idx, part)` upsert with the index entry deleted first; a write from another generation is refused; the log is not cleared at finish or abandon; the row and the record carry `seedFrom` and `range`, the request first; a detached run's range reads `broken`; a compaction row is written when the event carries the summary | `[gap]` PR (1): `deploy/cloudflare-memory/sessionLog.test.ts`, `src/core/runLedger/writeThrough.test.ts`, `src/core/harness/pi/bridge.test.ts` |
| A resume rebuilds the rows from `seedFrom` to the end of the range, compaction rows included, under a freshly composed system prompt, and settles in-flight calls | `[gap]` PR (1): `src/core/runLedger/resume.test.ts`, `src/core/harness/pi/harness.test.ts` |
| The sweep drops a session object only when every run of the session is gone from the kept records and none is live, owner row first | `[gap]` PR (1): the state Worker's retention tests |
| The seed is the notepad, then the newest turns within the budget read by index range and cut before a user text turn, then the request; a newest boundary over the budget yields notepad and request with a note; a `broken` predecessor yields the channel with a note; the row names `seedFrom` | `[gap]` PR (2): `src/core/dispatch/messages.test.ts` |
| `recall` searches the caller's session alone, returns matching turns newest first and a named turn whole under the tool result cap; a denied read is empty; a first run is told the log begins with it; a gap is named | `[gap]` PR (2): `src/tools/session.test.ts` |
| `notes` replaces the notepad up to 8 KiB and refuses over it naming the size; the notepad rides the system prompt at run start and is steered after a `compaction_end` that leaves a turn queued, never at the end of a run; the final text is a `notes` event on the record | `[gap]` PR (2): `src/tools/session.test.ts`, `src/core/harness/pi/bridge.test.ts` |
| Live: a coding session on pi that compacts recalls a tool output from before the compaction, and the next run in the thread starts from the notepad and the log's tail | `[agent]` PR (2)'s receipt, human-gated |

## Sources

- The Astra context approach as quoted from its launch post (a rolling log across context windows, notes the model keeps, earlier windows searchable), shared by the maintainer on 2026-09-14; Cognition's "Don't build multi-agents" on context compression being hard to get right; pi's `docs/settings.md`, `docs/rpc.md` and `docs/compaction.md` at the pinned version for the compaction knobs and the threshold rule.
- Records [0019](0019-durable-run-ledger-resume-after-kill.md), [0032](0032-pi-is-the-harness-the-native-loop-retires.md), [0034](0034-one-agent-per-unit-a-run-continues-a-transcript.md); the specs `run-history`, `harness-pi`, `memory`, `run-loop`, `thread-admission`.

## Appendix A: the survey at `6d26cf02`

| Fact | Where |
|---|---|
| The transcript is cleared best-effort after the finish or the abandon commits; item 33; nothing else sweeps the object | `src/core/runLedgerWorker.ts:258-277`; `docs/reference/specs/run-history.md` item 33; `deploy/cloudflare-memory/worker.ts` (the alarm sweeps `run_events`, never `RUN_TRANSCRIPTS`) |
| One transcript object per live run, keyed by run id; rows `(idx, part, json)` under `INSERT OR REPLACE`; an owner row; read whole in order; no thread key | `deploy/cloudflare-memory/worker.ts:2372-2456` |
| Transcript fences: 2 MiB request, 1,500,000 bytes a part, 1,000,000 base64 characters before an attachment is referenced; a part over budget is refused, never truncated | `src/core/runLedger/types.ts:20-25`; `src/core/runLedger/transcript.ts:32-53` |
| A refused or twice-failed write detaches the run, which goes on untracked; the finish record alone is never dropped | `src/core/runLedger/writeThrough.ts:8-13` |
| A resume rebuilds `messages` from the transcript alone, the seed as its first rows; system prompt and tools from the live row | `src/core/runLedger/resume.ts:95-111`; `docs/reference/specs/run-history.md` item 29 |
| Record caps: 1.5 MiB a record, 64 KiB an event, middle events dropped; tool output 8,000 and commands 4,000 characters | `src/core/runRecord.ts:624-700`; `src/core/runEvents.ts:602,608` |
| Retention policy default and bounds; the sweep walks finished `runs` rows only | `src/core/runRecord.ts:392-412`; `deploy/cloudflare-memory/worker.ts:1621-1675` |
| The `compacted` note, prose counts; a failed compaction is a `harness_error`; the mirror writes no compaction row | `src/core/harness/pi/bridge.ts:342`; `src/core/harness/pi/bridge.test.ts`; `docs/decisions/0032-pi-is-the-harness-the-native-loop-retires.md:191` |
| pi's declared window 200,000; the settings file writes no compaction knob; the harness sends `set_auto_retry`, `get_state`, `prompt`, `steer`; the transport closes at `settled` | `src/core/harness/pi/process.ts:174,212`; `src/core/harness/pi/harness.ts:349,368,410` |
| pi's compaction knobs and threshold rule (`compaction.enabled`, `reserveTokens` 16,384, `keepRecentTokens` 20,000, `set_auto_compaction`; the check runs after a low-level run ends) | pi 0.85.1 `docs/settings.md`, `docs/rpc.md`, `docs/compaction.md` (not vendored; the harness spike receipts) |
| pi's extension surfaces the repo records: `context` modifies messages, `before_agent_start` carries the system prompt; our extension registers tools and the `tool_call` veto | `docs/decisions/0032-pi-is-the-harness-the-native-loop-retires.md:199,207`; `src/core/harness/pi/extensionSource.ts` |
| `get_run_status` returns the final reply alone; `list_runs` never a message | `src/tools/runs.ts:78-81,428-494` |
| The runs store's only event read is by sequence; FTS5 exists in the memory store alone, a copying table kept in step by explicit writes | `deploy/cloudflare-memory/worker.ts:1088-1119,1875,259,264-271` |
| Memory scopes, reflection, budgets, "never a raw transcript" | `src/core/memory/scope.ts:26-58`; `src/core/memory/reflection.ts:40-58`; `src/core/memory/scorer.ts:25-26,71-73`; `src/core/memory/types.ts:8-11` |
| One live run per thread (`thread_key UNIQUE`); a coordinator's dispatch onto a live thread refused; a follow-up folds into the live run's inbox | `deploy/cloudflare-memory/worker.ts:1146`; `docs/reference/specs/thread-admission.md` items 1, 5 and 8 |
| Thread history is the last 50 replies; context events keep 20 turns within 256 KB | `src/channels/slack.ts:692`; `src/core/dispatch/messages.ts:16-17` |
| The tool result cap, applied on the pi relay too | `src/providers/types.ts:55`; `docs/reference/specs/run-loop.md` item 13 |
| The friction store's deletion as the precedent for removing a class | `deploy/cloudflare-memory/wrangler.template.jsonc:67` |
| Record 0034's session definition and growth paragraph | `docs/decisions/0034-one-agent-per-unit-a-run-continues-a-transcript.md:32,90,133` |
| Cloudflare's documented limits per SQLite-backed Durable Object: 10 GB storage, 2 MB a row | Cloudflare Durable Objects limits page, read 2026-09-14 |
