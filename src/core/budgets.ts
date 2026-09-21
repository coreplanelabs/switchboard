// Every wall clock in Switchboard as one table (docs/decisions/0046; docs/reference/specs/harness-pi.md
// item 15; docs/reference/specs/agent-ship.md item 8). A budget is a LEASE a
// parent carves from its own remainder, never a constant a file holds on its
// own: a preset ASKS for a lease and does useful work above a FLOOR; a parent
// that runs a loop holds back a RESERVE, derived from the floors and the
// provisioning of every round that must still follow, plus the merge wait's
// floor; and the lease covers everything the run does, the loop, the write-up
// and the post-step, each an ALLOWANCE named here. The registry reads its
// `maxMinutes` and `maxTurns` from this module and `budgets.check.test.ts`
// asserts the fits, so a number that breaks another's assumption is a red
// build. `carve` is called by the ship coordinator for every round (agent-ship
// item 8), `fit` by the config validator at load and by the fork over a clipped
// request, and `carveChildOfParent` by the conductor's spawn.
//
// Deliberately free of node: imports and of the agent registry, so the
// Workflow-driven coordinator and the deploy Workers can bundle it — the
// dependency runs registry → budgets, never the reverse.

export const SECOND_MS = 1_000;

export const secondsToMs = (seconds: number): number => seconds * SECOND_MS;

export const MINUTE_MS = 60_000;

/** Minutes → milliseconds, for a duration a request names in minutes (a drain's
 *  length): the multiplication lives here so no other file holds it. */
export const minutesToMs = (minutes: number): number => minutes * MINUTE_MS;

/** One calendar day in milliseconds: the unit the daily cost and delivery ranges
 *  step by (`dayOf`, the day count of a range). A day is not a lease, but it is
 *  a duration, and every duration is read from this table rather than written
 *  as a literal where it is used. */
export const DAY_MS = 24 * 60 * MINUTE_MS;

/** One calendar week in milliseconds: the bucket the live false-silence ratio
 *  is printed per (docs/reference/specs/load-harness.md item 20). */
export const WEEK_MS = 7 * DAY_MS;

/** How long the confirmation a routed write is offered as stays pending
 *  (docs/decisions/0044; docs/reference/specs/routing-and-config.md item 25):
 *  the connect ticket's ten minutes. The bot passes it to the config object,
 *  which stamps the expiry on its own clock. */
export const CONFIRMATION_TTL_MS = 10 * MINUTE_MS;

/** How long a question's Yes stays pending (docs/decisions/0054, as amended;
 *  docs/reference/specs/routing-and-config.md item 25): one day. A Yes only
 *  re-dispatches the corrected message, which is then routed, authorized and,
 *  for a write, offered its own graded button — the write's ten-minute
 *  freshness is enforced downstream, so a short window here protects nothing
 *  and only loses answers. People answer a question in minutes to hours. */
export const QUESTION_TTL_MS = DAY_MS;

/** How long a resolved author binding is reused before the stored `{ login,
 *  id }` pair is re-read from GitHub (docs/decisions/0062;
 *  docs/reference/specs/authorization.md item 18). The commit identity pairs
 *  are resolved per EXEC (`gitIdentityEnvs`), and the pi harness's log polls,
 *  FIFO sends and file writes ride the same executor — without a cache a
 *  write run costs one `GET /user/<id>` per command, drawing down the
 *  installation's shared rate limit for a freshness nothing needs: the
 *  identity rewrite re-reads the binding fresh before the PR opens, so a
 *  rename is caught there whatever this window holds. Read by `bindingOf`
 *  (`src/execution/authorBinding.ts`) for the resolved pair and the rename
 *  refusal alike (one `[identity]` line per window, not one per exec); a read
 *  that FAILED is never cached — the next read asks again. */
export const AUTHOR_BINDING_TTL_MS = 15 * MINUTE_MS;

/** How long a dispatch's FIRST attach to a resident — a fresh run's, or a
 *  resumed run's re-attach to its recorded worktree — waits for the resident
 *  to wake when the Worker typed its refusal as the platform's transient
 *  (docs/reference/specs/execution.md item 9): a Durable Object reset or lost
 *  under the attach clears in seconds, so a minute is generous, and far under
 *  the wake ceiling a mid-run re-attach may take — the card is silent while
 *  this wait runs, then names it. It bounds the PROBING: past it no further
 *  probe is made and, with nothing bound, a fresh run falls cold and a resumed
 *  run is refused, the wait named either way; a re-attach already opened
 *  inside it runs to the attach's own timeout. The run's own stop ends any of
 *  it at once. Read by the executor factory. */
export const FIRST_ATTACH_WAIT_MS = MINUTE_MS;
/** The least an attach REQUEST is opened with (docs/reference/specs/execution.md
 *  item 9): a re-attach that recreates the worktree clones from the resident's
 *  local mirror and may install deps, so a bound under this could not finish
 *  and a request cut mid-clone is struck as a rollout — the strike this floor
 *  exists to stop counting. A run with less than this left past its write-up
 *  reserve opens no attach at all (`attachBoundWithinRun`: `exhausted`). Half
 *  a minute: the one-second floor a COMMAND keeps (`BASH_TIMEOUT_MIN_MS`) is
 *  the model's to choose; an attach is opened on the run's behalf. */
export const ATTACH_REQUEST_MIN_MS = 30_000;
/** How long a harness's one more command waits for a container that is down
 *  under a live run to answer (docs/reference/specs/harness-pi.md item 16):
 *  the platform rebuilt a replaced resident container in about a minute, and
 *  a run with work in flight should not hang on a container that is not coming
 *  back for as long as a fresh run may wait for its first container
 *  (`SANDBOX_START_WAIT_MAX_MS`, ten minutes, execution.md item 23 — a wait
 *  before anything ran). A wait that runs out decides nothing; the failure
 *  that opened the question stands. */
export const HARNESS_PROBE_WAIT_MS = 5 * MINUTE_MS;

/** The resident fleet drain (docs/decisions/0059; docs/reference/specs/resident-repos.md
 *  item 69; docs/reference/specs/release-and-deploy.md item 31). A deploy closes
 *  the fleet to new runs and waits for the runs in flight to end: `deployWaitMaxMs`
 *  is that wait, past a coding child's whole lease (its ask plus its write-up),
 *  the longest a run in flight can outlive the drain's start; the drain itself
 *  lasts the wait plus `marginMinutes`, and the registry caps any drain at
 *  `maxMinutes` so one nobody lifted is an hour and a half, not a day. A run
 *  asked during a drain waits at its attach one `pollMs` at a time under its
 *  own lease less `leaseReserveMs` (what the attach and the work after it
 *  need), `waitMaxMs` with no lease to clip it. */
export const DRAIN = {
  pollMs: 30_000,
  waitMaxMs: 60 * MINUTE_MS,
  leaseReserveMs: 10 * MINUTE_MS,
  deployWaitMaxMs: 60 * MINUTE_MS,
  marginMinutes: 5,
  maxMinutes: 90,
  defaultMinutes: 60,
  /** How long a held drain waits for a container's post-deploy cycle before
   *  reopening the fleet anyway with the stale container named (issue 2044):
   *  the platform replaces container processes three to ten minutes after a
   *  deploy (docs/reference/specs/resident-repos.md item 65), so a cycle that
   *  has not landed within this bound is not coming on its own — the gate
   *  asked for the cycle, so it owns the outcome and never holds the fleet
   *  closed to the drain's whole `until` on a report nothing will send. */
  cycleBoundMinutes: 10,
} as const;

/** How long an intake receipt row is kept on the run history object
 *  (docs/reference/specs/run-history.md item 59; docs/decisions/0058): the larger of one day
 *  and the reconnect catch-up window the write named plus the drain deadline
 *  (`DRAIN.maxMinutes`, the longest a fleet drain may last), so a catch-up
 *  that runs after the longest allowed drain still reads the verdict instead
 *  of deciding the reply again. The window is clamped to a month so a
 *  misconfigured writer cannot make retention unbounded. */
export const INTAKE_WINDOW_MAX_MS = 30 * DAY_MS;
export function intakeReceiptRetentionMs(catchUpWindowMs: number): number {
  const window = Math.min(Math.max(0, catchUpWindowMs), INTAKE_WINDOW_MAX_MS);
  return Math.max(DAY_MS, window + minutesToMs(DRAIN.maxMinutes));
}

/** The live false-silence join's recovery window (docs/reference/specs/load-harness.md
 *  item 20; docs/decisions/0058): a `silent` intake receipt counts as a false
 *  silence when the same person mentions the bot in the same thread within
 *  this window — the mention is the ignored person's recovery move, so a
 *  prompt one bounds the ratio the gate is judged by. */
export const INTAKE_RECOVERY_WINDOW_MS = 10 * MINUTE_MS;

/** The presets that run the tool loop, and the one pipeline preset. */
export const LOOP_PRESETS = [
  "general",
  "coding",
  "review",
  "research",
  "explore",
  "conductor",
  "orchestrator",
] as const;
export type LoopPreset = (typeof LOOP_PRESETS)[number];
export type Preset = LoopPreset | "ship";

/** What each preset asks for when nothing above it is tighter, in minutes. The
 *  pipeline's (`ship`) is the wall clock one segment of its loop runs under;
 *  a deployment's `ship.maxMinutes` replaces it, held to `fit` below. Coding's
 *  is sized by the ledger's ship children, not its standalone runs: a child
 *  that pushes at minute 29 and then runs the repo's whole gate (seven to ten
 *  minutes on a resident) was cut at 45 one run in twelve, so the ask is
 *  double the 90th percentile (31.5) with the gate inside it. Ship's holds
 *  its own loop at the default rounds with a findings round at that ask, not at
 *  its floor (`fit` proves the floor case; the ask leaves room above it). */
export const ASKS: Readonly<Record<Preset, number>> = {
  general: 5,
  coding: 90,
  review: 25,
  ship: 240,
  research: 8,
  explore: 120,
  conductor: 120,
  // The plane's chat preset (record 0070): reads the fleet's tables and
  // answers; a turn is a projection read plus a write-up, so its ask sits
  // between general's and research's kind of work, with room for a few reads.
  orchestrator: 10,
};

/** The rounds a ship loop is made of. `findings` is a coding child handed the
 *  review's findings; `merge` is the runner's wait on the guards. */
export type RoundKind = "coding" | "review" | "findings" | "merge";

/** The least lease in which a round does useful work, in minutes. A carve that
 *  falls under the floor is refused rather than dispatched: a two-minute
 *  review or findings round costs an attach and a model turn and finishes
 *  nothing. Review's is the ledger's 90th percentile of completed reviews (5.1
 *  min over 181); coding's is the least a findings round can run the repo's
 *  gate in — the gate alone takes seven to ten minutes on a resident, and a
 *  round that cannot run it finishes nothing its contract asks; the merge
 *  wait's is a guess
 *  until the ledger says. */
export const PRESET_FLOORS: Readonly<Record<LoopPreset, number>> = {
  general: 2,
  coding: 15,
  review: 5,
  research: 3,
  explore: 15,
  conductor: 15,
  orchestrator: 2,
};
export const FLOORS: Readonly<Record<RoundKind, number>> = {
  coding: PRESET_FLOORS.coding,
  findings: PRESET_FLOORS.coding,
  review: PRESET_FLOORS.review,
  merge: 10,
};

/** The merge wait's own ask: how long the runner waits on the guards at most
 *  when the remainder allows it. */
export const MERGE_WAIT_ASK_MINUTES = 60;

/** The sweep's bounds (record 0071, mechanism two): the short lease of the one
 *  model round a conflicting pull request may buy, and the spend that round is
 *  capped at per pull request — a round refused at either bound ends the pull
 *  request's line with the conflict named, never a retry loop. */
export const PULL_SWEEP = { leaseMinutes: 15, spendCapUsd: 5 } as const;

/** The provider retry ladder (issue 1932): the backoff before each retry of a
 *  transient model-call failure — a gateway 5xx, a stream cut before
 *  `message_stop`, a gateway timeout. Three attempts with growing waits,
 *  charged to the run's lease; the waits stay small next to the run's minutes
 *  because the observed blips are edge transients of seconds. */
export const PROVIDER_RETRY_BACKOFFS_MS = [5_000, 15_000, 45_000] as const;

/** A hosted ship parent's deadline margin past the pipeline's wall clock
 *  (record 0060): the row's `state.hosting.until` is the hand-off time plus
 *  the instance's `caps.maxMinutes` plus this hour, absorbing the runner's own
 *  scheduling slack before a reclaim closes the row `interrupted`. */
export const HOSTED_DEADLINE_MARGIN_MINUTES = 60;

/** The ship runner's waits, in minutes: the margin a child's wait allows past
 *  its budget, the slice a wait is asked in, the merge door's re-ask cadence,
 *  and the pause before a busy spawn is asked again. */
export const SHIP_WAIT = { marginMinutes: 5, chunkMinutes: 5, mergeChunkMinutes: 5, busyRetryMinutes: 2 } as const;

/** How long a restarting close gives its replacement dispatch to claim the
 *  same run before a read with no successor treats the close as final
 *  (run-history item 47a). One whole coordinator wait chunk lets an ordinary
 *  replacement claim without shortening the parent's first wait; a successor
 *  found after this deadline still wins because read-record searches first. */
export const RESTART_CLAIM_GRACE_MS = minutesToMs(SHIP_WAIT.chunkMinutes);

/** The plane's table (docs/decisions/0064): how long a finished run stays on
 *  it, a reservation's window, and the default re-ask cadence — how often a
 *  silent resident something waits on is probed (`plane.reaskMinutes`
 *  overrides it per deployment). */
export const PLANE = {
  recentMinutes: 60,
  reservationMinutes: 2,
  reaskMinutes: 2,
  /** A coding round with no pushed head past this is steered once (record 0064, "The backpressure contract"). */
  noPushMinutes: 15,
  /** The line an in-flight call with NO declared bound is judged against for the same steer. */
  noBoundMinutes: 20,
} as const;

/** The named amounts a lease holds back, in minutes. Each stands for a step
 *  every run or round pays: `provision` is attach and restore before the
 *  harness's clock starts; `writeUp` is the final answer after the loop ends;
 *  `commandWriteUp` is what the last command leaves for that answer; `execCall`
 *  is the exec client's wait past a command's own budget; `bearerGrace` is how
 *  far past the lease the model bearer stays valid for the last call's tail. */
/** The stall signal's window in minutes (docs/reference/specs/live-view.md
 *  item 32): a run's pace is counted over the last this-many minutes, and a
 *  run with no tool call for a whole window reads as stalled. */
export const PACE_WINDOW_MINUTES = 5;

export const ALLOWANCES = {
  provision: 3,
  writeUp: 3,
  commandWriteUp: 1,
  execCall: 0.5,
  bearerGrace: 1,
} as const;

/** The post-step turn a preset runs after its loop, in minutes: the coding
 *  run's description turn, the review's verdict turn, none for the rest. */
export const POST_STEP_MINUTES: Readonly<Record<Preset, number>> = {
  coding: 5,
  review: 3,
  general: 0,
  research: 0,
  explore: 0,
  conductor: 0,
  orchestrator: 0,
  ship: 0,
};

/** The post-step allowance of a preset named by its def's `name`: a name
 *  outside the table (a test's, a command run's) runs no post-step. */
export function postStepMinutes(preset: string): number {
  return (POST_STEP_MINUTES as Readonly<Record<string, number>>)[preset] ?? 0;
}

/** The post-step turn's lease, in minutes (fractional when the remainder is:
 *  the harness turns it back into ms): the preset's allowance, or the lease's
 *  remainder when that is less — never under a minute, so a turn the loop's
 *  write-up crowded still gets its one chance. The bearer's grace covers that
 *  floor for a turn that starts at or before the lease's end; a turn that
 *  starts later runs on a bearer that may expire under it, and its refused
 *  call fails soft — the run's answer already stands. Without a remainder
 *  (no harness session says) the allowance stands. */
export function postStepLease(preset: string, remainingMs: number | undefined): number {
  const allowance = postStepMinutes(preset);
  if (remainingMs === undefined) return allowance;
  return Math.min(allowance, Math.max(1, remainingMs / MINUTE_MS));
}

/** The least lease under which a loop-running preset does anything: the
 *  write-up and the preset's post-step are held back from every lease
 *  (`loopClock`), so a lease of that sum leaves the loop nothing — the run
 *  goes straight to its write-up and reports a budget it never had. One minute
 *  above the sum is the least that runs a turn. A profile clipped under this by
 *  a directive, a boundary or a parent's remainder is refused at the gate
 *  naming it, the way a ship round is refused under its floor; the floors are
 *  the larger numbers a round needs to be worth dispatching. */
export function leaseMinimum(preset: string): number {
  return ALLOWANCES.writeUp + postStepMinutes(preset) + 1;
}

/** A follow-up turn's lease, in ms: the lesser of what it asks and what the
 *  run's lease still holds, never under a minute — the grace covers that floor
 *  when the turn starts by the lease's end; later, the bearer may expire under
 *  the turn and its call is refused, failing soft. */
export function turnLeaseMs(askMinutes: number, remainingMs: number): number {
  return Math.min(askMinutes * MINUTE_MS, Math.max(MINUTE_MS, remainingMs));
}

/** The wrap-up warning's place before the loop's end: three minutes, or a
 *  quarter of the loop when the loop is shorter than twelve. */
export const WRAP_UP_WARNING = { minutes: 3, fraction: 0.25 } as const;

/** The clocks a harness keeps for one lease (docs/reference/specs/harness-pi.md
 *  items 6 and 15). The lease ENDS at `deadline`; the LOOP ENDS at `loopEnd`,
 *  the write-up allowance and the preset's post-step earlier, so both run
 *  inside the lease; the WARNING is steered at `warnAt`; the write-up is
 *  BOUNDED by `finaleMs`. A follow-up turn on the session (`kind: "turn"`)
 *  holds nothing back — its deliverable is a tool call, not a write-up — and
 *  its loop ends at its deadline. A lease shorter than its hold-back has no
 *  loop time: the loop ends at its start, never before it. */
export interface LoopClock {
  startedAt: number;
  deadline: number;
  loopEnd: number;
  warnAt: number;
  finaleMs: number;
}

export function loopClock(
  startedAt: number,
  remainingMs: number,
  preset: string,
  kind: "loop" | "turn" = "loop",
): LoopClock {
  const deadline = startedAt + remainingMs;
  const holdBackMs = kind === "loop" ? (ALLOWANCES.writeUp + postStepMinutes(preset)) * MINUTE_MS : 0;
  const loopEnd = Math.max(startedAt, deadline - holdBackMs);
  const warnAt =
    loopEnd - Math.min(WRAP_UP_WARNING.minutes * MINUTE_MS, (loopEnd - startedAt) * WRAP_UP_WARNING.fraction);
  return { startedAt, deadline, loopEnd, warnAt, finaleMs: ALLOWANCES.writeUp * MINUTE_MS };
}

/** When a run's model-proxy bearer expires: the lease's end plus the grace
 *  (docs/reference/specs/model-proxy.md item 2). */
export function bearerExpiresAt(leaseEndsAt: number): number {
  return leaseEndsAt + ALLOWANCES.bearerGrace * MINUTE_MS;
}

/** The bearer's expiry as the mint at provisioning sets it, before the lease
 *  has started: the provisioning allowance, the lease and the grace — replaced
 *  by `bearerExpiresAt` the moment the harness starts the lease. */
export function provisionalBearerExpiresAt(now: number, leaseMinutes: number): number {
  return now + (ALLOWANCES.provision + leaseMinutes + ALLOWANCES.bearerGrace) * MINUTE_MS;
}

/** The e2b credential-write exec's own timeout: the store-file write is one
 *  `printf` plus a `git config` reset, so a minute is generous headroom while
 *  still failing fast when the micro-VM is wedged
 *  (docs/reference/specs/execution.md item 5). */
export const SANDBOX_CREDENTIAL_WRITE_TIMEOUT_MS = MINUTE_MS;

/** The per-command bash budget's rows: the default when a call names none, the
 *  ceiling a call may raise it to, and the floor under which a number is a
 *  typo (docs/reference/specs/execution.md item 11). */
export const BASH_COMMAND = { defaultMinutes: 5, maxMinutes: 20, minMs: 1_000 } as const;

/** The pace that marks a run as looping rather than working: a model turn
 *  every ten seconds, sustained for the whole wall clock. A busy run takes
 *  20–40 s a turn (a model think plus a tool call), so a run that averages six
 *  a minute from start to end is re-issuing calls, not making progress — and
 *  its turn cap ends it before the wall clock would, with a write-up that
 *  says so (docs/reference/specs/harness-pi.md item 15). */
export const RUNAWAY_TURNS_PER_MINUTE = 6;

/** The turn cap a wall clock implies: `maxMinutes × RUNAWAY_TURNS_PER_MINUTE`.
 *  Every preset that runs the loop derives its `maxTurns` from this, so the
 *  cap is never a number a good run reaches — the minutes are the budget. */
export function runawayTurnCap(maxMinutes: number): number {
  return maxMinutes * RUNAWAY_TURNS_PER_MINUTE;
}

/** A pipeline's loop as the config allows it: `maxRounds` counts review rounds. */
export interface Loop {
  maxRounds: number;
}

/** A round's position in its loop: its kind and its index, so the reserve is
 *  the rounds after that index, never a table keyed by kind alone. */
export interface RoundPosition {
  kind: RoundKind;
  index: number;
}

/** The rounds of a loop in order: the coding round, then a review and, after
 *  every review but the last, a findings round, then the merge wait. */
export function loopRounds(loop: Loop): RoundKind[] {
  const rounds: RoundKind[] = ["coding"];
  for (let i = 0; i < loop.maxRounds; i++) {
    rounds.push("review");
    if (i < loop.maxRounds - 1) rounds.push("findings");
  }
  rounds.push("merge");
  return rounds;
}

/** Where a round sits in `loopRounds`: the coding round first; review round
 *  `n` (counted from 1) and the findings round that follows it at `2n − 1`
 *  and `2n`; the
 *  merge wait last. The ship coordinator numbers its rounds this way, so the
 *  reserve it carves with is the one the fit assumed. */
export function loopPosition(loop: Loop, kind: RoundKind, n = 0): number {
  switch (kind) {
    case "coding":
      return 0;
    case "review":
      return 2 * n - 1;
    case "findings":
      return 2 * n;
    case "merge":
      return 2 * loop.maxRounds;
  }
}

/** A child spawned outside any loop (a conductor's): the parent's whole
 *  remainder in whole minutes, refused under the child preset's floor — a
 *  child under its floor costs a thread and a model turn and finishes nothing. */
export function carveChildOfParent(
  remainingMs: number,
  preset: LoopPreset,
): { kind: "carved"; minutes: number } | { kind: "refused"; reason: "under floor"; minutes: number; floor: number } {
  const minutes = Math.max(0, Math.floor(remainingMs / MINUTE_MS));
  const floor = PRESET_FLOORS[preset];
  if (minutes < floor) return { kind: "refused", reason: "under floor", minutes, floor };
  return { kind: "carved", minutes };
}

/** The minutes a round holds back for what must follow it in the loop: the
 *  floor plus provisioning of every later review and findings round, and the merge
 *  wait's floor. A merge holds nothing back; a round with no loop (a
 *  conductor's child) holds nothing back either. */
export function reserveMinutes(
  round: RoundPosition,
  loop: Loop | undefined,
  floors: Readonly<Record<RoundKind, number>> = FLOORS,
): number {
  if (!loop) return 0;
  let reserve = 0;
  for (const kind of loopRounds(loop).slice(round.index + 1)) {
    reserve += kind === "merge" ? floors.merge : floors[kind] + ALLOWANCES.provision;
  }
  return reserve;
}

/** What a round asks for: the preset's ask for a coding or findings round, the
 *  review's for a review, the merge wait's own for the merge. */
export function roundAskMinutes(kind: RoundKind): number {
  switch (kind) {
    case "coding":
    case "findings":
      return ASKS.coding;
    case "review":
      return ASKS.review;
    case "merge":
      return MERGE_WAIT_ASK_MINUTES;
  }
}

/** A carve's result: the minutes with what bounded them (`ask` when the round
 *  got its whole ask, `parent` when the remainder minus the reserve was
 *  tighter) and what the parent holds back, or a refusal when the minutes the
 *  remainder leaves fall under the round's floor. */
export type Carve =
  | { kind: "carved"; minutes: number; boundedBy: "ask" | "parent"; holds: number }
  | { kind: "refused"; reason: "under floor"; minutes: number; floor: number; holds: number };

/** The only place a round's minutes are computed: the parent's remainder in
 *  whole minutes minus the round's reserve, capped at the round's ask, refused
 *  under the round's floor. `loop` is undefined for a child outside any loop. */
export function carve(remainingMs: number, round: RoundPosition, loop: Loop | undefined): Carve {
  const holds = reserveMinutes(round, loop);
  const ask = roundAskMinutes(round.kind);
  const headroom = Math.floor(remainingMs / MINUTE_MS) - holds;
  const minutes = Math.min(ask, headroom);
  const floor = FLOORS[round.kind];
  // A refusal reports what the remainder left, never a negative number.
  if (minutes < floor) return { kind: "refused", reason: "under floor", minutes: Math.max(0, minutes), floor, holds };
  return { kind: "carved", minutes, boundedBy: minutes === ask ? "ask" : "parent", holds };
}

/** A pipeline's wall clock and its loop: what `fit` judges. */
export interface Pipeline extends Loop {
  maxMinutes: number;
}

/** The fit: a pipeline holds its first child at its ask and every later round
 *  at its floor — `provision + ask(coding) + reserve(coding, loop) ≤
 *  maxMinutes`. Asserted at verify over the registry, at config load over the
 *  deployment's `ship` block (`validateShip`), and at the fork over a request a
 *  boundary or a `budget:` directive clipped. `need` is the sum a refusal names. */
export function fit(pipeline: Pipeline): { ok: boolean; need: number; have: number } {
  const need = ALLOWANCES.provision + ASKS.coding + reserveMinutes({ kind: "coding", index: 0 }, pipeline);
  return { ok: pipeline.maxMinutes >= need, need, have: pipeline.maxMinutes };
}

// ---- the grant (decision 0046, Renewal: the grant decides, the lease continues) ----

/** What the request authorizes for the whole problem beyond one lease: a count
 *  of renewals and a cost cap in dollars. A lease is sized by the infrastructure
 *  that must outlive it; the grant is sized by the person — a scope's word or
 *  the request's `renewals:` directive — and the runner spends it one segment at
 *  a time. Zero renewals and no cap by default, so nothing renews until someone
 *  says so; `costCapUsd` absent is no cap, never zero. */
export interface Grant {
  renewals: number;
  costCapUsd?: number;
}

/** Which layer's word the grant is: the request's directive, the user's scope,
 *  the channel's, or the org's `ship.grant` — the default counts as the org's. */
export type GrantSource = "org" | "channel" | "user" | "run";

export const DEFAULT_GRANT: Grant = { renewals: 0 };

/** The most renewals one request may carry: thirteen segments of the ship
 *  preset's ask are two days. The cap bounds a COUNT a person types
 *  (`renewals:`) or a scope holds; it did not halve when the ask doubled,
 *  since every grant already configured is a count of segments and a day's
 *  hand-over is now `renewals: 5` — the longest problem a person hands over
 *  in one message before a plan should carry it. */
export const GRANT_RENEWALS_MAX = 12;

// ---- the structured-answer seam (record 0067: a violation is re-asked) ----

/** The most re-asks one structured ask may make (`askStructured`,
 *  src/core/dispatch/structured.ts): a named violation is quoted back to the
 *  same model at most this many times; the next violation is the caller's
 *  declared floor. A count, not a duration — the caller's one timeout covers
 *  the whole loop. */
export const STRUCTURED_RETRIES_MAX = 2;

// ---- the idle unit (record 0051: a pipeline idles instead of ending) ----

/** `ship.idleDays`' default: zero — today's endings byte for byte. It moves to
 *  seven only in the unit that lands after the baseline and the billing answer
 *  are recorded (record 0051's plan), never before. */
export const IDLE_DAYS_DEFAULT = 0;
/** The most days one idle may wait: the platform's own `waitForEvent` ceiling
 *  (a year), which the wait must pass explicitly — its default is 24 hours. */
export const IDLE_DAYS_MAX = 365;
/** The most wakes one idle answers before it expires: a bound on how long a
 *  busy thread can keep an instance parked (read by the wait, this plan's
 *  fifth unit). */
export const IDLE_WAKES_MAX = 100;
