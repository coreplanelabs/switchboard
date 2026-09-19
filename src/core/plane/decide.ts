// The plane's decider (docs/reference/specs/orchestration-plane.md, the
// decider items; record 0064, "Where it lives"): one pure function over a
// closed event union and a closed effect union. The ledger object reads its
// state, calls `decide` and commits the writes and the effects inside ONE
// `transactionSync`, so a decision and its consequences land together or not
// at all. Node-free by design, like `table.ts`: no clock, no io, no ids it
// did not derive from its inputs — the same event over the same state is the
// same answer, which is what the shadow comparison and the tests rest on.

/** The three stages an ask is judged at (record 0064): the bot's admission
 *  door, the plan runner's seed door, the resident's seat. this unit decides the
 *  admission stage alone; the others' conditions arrive with their units. */
export type PlaneStage = "admission" | "runner" | "resident";

/** A queue condition: what must become true before the row may run. Each is
 *  flipped by an event the plane already sees, never polled. The admission
 *  stage's full set (record 0064, "The queue"): `thread_free` — flipped by the
 *  seal or closing reclaim of the thread's run; `window_open` — flipped by the
 *  window's lift; `deploy_settled` — flipped by the deploy runner's
 *  `deploy.landed` post. The union grows one member per stage as the later
 *  units land. */
export type PlaneCondition =
  | { kind: "thread_free"; threadKey: string; met: boolean }
  | { kind: "window_open"; window: string; met: boolean }
  | { kind: "deploy_settled"; met: boolean };

/** A reservation: an admitted ask's hold on its thread between the answer and
 *  the ledger claim that promotes it (the `plane_reservations` row). A second
 *  ask meanwhile sees the thread taken and queues. The seal deletes it. */
export interface PlaneReservation {
  kind: "thread";
  key: string;
  runId: string;
  at: number;
}

/** One queued ask: the `plane_queue` row. `position` counts the waiting rows
 *  ahead of it on the same conditions when it queued — the number a person is
 *  told, never recomputed for them. */
export interface PlaneQueueRow {
  runId: string;
  requester: string;
  threadKey: string;
  stage: PlaneStage;
  /** The stored request, replayed verbatim when the row is admitted (the transport unit). */
  request: Record<string, unknown>;
  conditions: PlaneCondition[];
  position: number;
  queuedAt: number;
  state: "waiting" | "admitted" | "withdrawn";
}

/** What the decider knows: the queue and the threads with a live run. The
 *  object builds it from its own tables inside the same transaction that
 *  commits the answer. */
export interface PlaneState {
  queue: PlaneQueueRow[];
  liveThreads: string[];
  /** Threads an admitted ask holds before its claim lands (or after, until the seal). */
  reservations: PlaneReservation[];
  /** Open window kinds; `deploy` is the pending-deploy window (`deploy_settled` is its absence). */
  openWindows: string[];
}

export function emptyPlaneState(): PlaneState {
  return { queue: [], liveThreads: [], reservations: [], openWindows: [] };
}

/** The window kind behind `deploy_settled`: opened while a deploy is pending,
 *  lifted by the deploy runner's `deploy.landed` post (record 0064). */
export const DEPLOY_WINDOW = "deploy";

/** The closed event union. `ask`: may this run start now; `sealed`: a thread's
 *  live run ended (the ledger's seal, the event that flips `thread_free`);
 *  `withdraw`: the requester gave the wait up (`runs stop` on a queued id, the transport unit). */
export interface PlaneAskEvent {
  kind: "ask";
  at: number;
  runId: string;
  requester: string;
  threadKey: string;
  stage: PlaneStage;
  request: Record<string, unknown>;
}
export type PlaneEvent =
  | PlaneAskEvent
  | { kind: "sealed"; at: number; threadKey: string }
  | { kind: "withdraw"; at: number; runId: string }
  /** A window's open or lift (`window_open`); kind `deploy` is the pending deploy (`deploy_settled`). */
  | { kind: "window"; at: number; window: string; phase: "opened" | "lifted" };

/** The closed effect union: what the bot is asked to do, offered on its
 *  heartbeat and reclaim answers and acknowledged by id (`/plane/ack`). The
 *  id is derived from the run, so a duplicate offer after a roll is the same
 *  effect, acknowledged once. The transport unit adds execution; this one only shapes and stores. */
export type PlaneEffect = {
  id: string;
  kind: "admit";
  runId: string;
  threadKey: string;
  request: Record<string, unknown>;
};

/** What the object must persist beside the returned state — the decider names
 *  the rows, the object owns the SQL, both inside one `transactionSync`. */
export type PlaneWrite =
  | { table: "plane_queue"; op: "put"; row: PlaneQueueRow }
  | { table: "plane_queue"; op: "state"; runId: string; state: PlaneQueueRow["state"] }
  | { table: "plane_effects"; op: "offer"; effect: PlaneEffect; at: number }
  | { table: "plane_reservations"; op: "put"; row: PlaneReservation }
  | { table: "plane_reservations"; op: "del"; key: string }
  | { table: "plane_windows"; op: "put"; window: string; at: number }
  | { table: "plane_windows"; op: "del"; window: string };

/** The bot's own outcome for one dispatch, posted to `POST /plane/outcome`
 *  under `plane.admission: shadow` (orchestration-plane item 8): `proceeded`, `refused:<code>` or
 *  `fell_cold:<token>` — the ledger object logs the decider's word beside it.
 *  `runId` is absent when the dispatch never minted one (a refusal). */
export interface PlaneOutcomePost {
  runId?: string;
  requester: string;
  threadKey: string;
  stage: PlaneStage;
  outcome: string;
}

/** How the bot answers an offered effect (orchestration-plane item 7): `done` and `skipped` close it,
 *  `deferred` leaves it on the next heartbeat or reclaim answer. */
export type PlaneAckOutcome = "done" | "skipped" | "deferred";

/** The effect bounds (record 0064, "Where it lives"): a run holds at most this
 *  many open effects, the object at most the total — an offer past either is
 *  refused by the cap's name, never queued silently. */
export const PLANE_EFFECTS_PER_RUN_CAP = 4;
export const PLANE_EFFECTS_TOTAL_CAP = 256;

/** The named refusal an over-cap offer gets (the object counts, this judges). */
export function effectCapRefusal(counts: { total: number; forRun: number }, effect: PlaneEffect): string | undefined {
  if (counts.total >= PLANE_EFFECTS_TOTAL_CAP)
    return `plane_effects total cap (${PLANE_EFFECTS_TOTAL_CAP}): effect ${effect.id} refused`;
  if (counts.forRun >= PLANE_EFFECTS_PER_RUN_CAP)
    return `plane_effects per-run cap (${PLANE_EFFECTS_PER_RUN_CAP}): effect ${effect.id} refused`;
  return undefined;
}

export interface PlaneDecision {
  state: PlaneState;
  effects: PlaneEffect[];
  writes: PlaneWrite[];
}

/** One event in, the next state out, with the writes and effects that carry
 *  it — and nothing else: no transition, no writes (the state comes back as
 *  given). Never throws: an event about a run or thread the state does not
 *  know is a no-op, because the object replays outcomes from a bot whose view
 *  can be older than the tables. */
export function decide(state: PlaneState, event: PlaneEvent): PlaneDecision {
  switch (event.kind) {
    case "ask":
      return onAsk(state, event);
    case "sealed":
      return onSealed(state, event);
    case "withdraw":
      return onWithdraw(state, event);
    case "window":
      return onWindow(state, event);
  }
}

/** The `/plane/admit` answer (record 0064, "The queue"): `admitted` with the
 *  reservation the decision wrote, or `queued` with the row's id, its position
 *  and the conditions it waits on. */
export type PlaneAskAnswer =
  | { kind: "admitted"; reservation: string }
  | { kind: "queued"; id: string; position: number; waiting: PlaneCondition[] };

export function planeAskAnswerOf(decision: PlaneDecision, runId: string): PlaneAskAnswer {
  const row = decision.state.queue.find((r) => r.runId === runId);
  return row && row.state === "waiting"
    ? { kind: "queued", id: runId, position: row.position, waiting: row.conditions }
    : { kind: "admitted", reservation: runId };
}

/** The shadow word for an ask the decider just judged (orchestration-plane item 8): `queued` when the
 *  decision holds a waiting row for the run, `proceed` when it holds none —
 *  what the object logs beside the bot's own outcome. */
export function planeAskWordOf(decision: PlaneDecision, runId: string): "proceed" | "queued" {
  const row = decision.state.queue.find((r) => r.runId === runId);
  return row && row.state === "waiting" ? "queued" : "proceed";
}

/** The queue's waiting words (record 0064, "The queue"): what a person is
 *  told the row waits on — the queued reply in the thread and the queued id's
 *  page say the same thing, so the two surfaces cannot drift. */
export function waitingWords(waiting: PlaneCondition[]): string {
  if (waiting.length === 0) return "its turn";
  return waiting
    .map((c) =>
      c.kind === "thread_free"
        ? "the thread's live run"
        : c.kind === "deploy_settled"
          ? "the pending deploy"
          : `the ${c.window} window`,
    )
    .join(", then ");
}

/** The unmet conditions an ask meets right now: a live or reserved thread,
 *  every open window, a pending deploy. Empty means admitted. */
function unmetConditionsOf(state: PlaneState, threadKey: string): PlaneCondition[] {
  const out: PlaneCondition[] = [];
  if (state.liveThreads.includes(threadKey) || state.reservations.some((r) => r.key === threadKey))
    out.push({ kind: "thread_free", threadKey, met: false });
  for (const w of state.openWindows)
    out.push(
      w === DEPLOY_WINDOW ? { kind: "deploy_settled", met: false } : { kind: "window_open", window: w, met: false },
    );
  return out;
}

/** Whether two conditions are the same wait: same kind, same subject. */
function sameCondition(a: PlaneCondition, b: PlaneCondition): boolean {
  if (a.kind !== b.kind) return false;
  if (a.kind === "thread_free" && b.kind === "thread_free") return a.threadKey === b.threadKey;
  if (a.kind === "window_open" && b.kind === "window_open") return a.window === b.window;
  return true; // deploy_settled has one subject
}

function onAsk(state: PlaneState, event: PlaneAskEvent): PlaneDecision {
  const conditions = unmetConditionsOf(state, event.threadKey);
  if (conditions.length === 0) {
    // Admitted: the thread is reserved in the same transaction (record 0064,
    // "The queue") so a second ask a moment later queues; the ledger claim
    // promotes the reservation and the seal deletes it.
    const reservation: PlaneReservation = { kind: "thread", key: event.threadKey, runId: event.runId, at: event.at };
    return {
      state: { ...state, reservations: [...state.reservations, reservation] },
      effects: [],
      writes: [{ table: "plane_reservations", op: "put", row: reservation }],
    };
  }
  // Position (record 0064): the rank among queued runs sharing an unmet condition.
  const waitingAhead = state.queue.filter(
    (r) => r.state === "waiting" && r.conditions.some((c) => conditions.some((n) => sameCondition(c, n))),
  ).length;
  const row: PlaneQueueRow = {
    runId: event.runId,
    requester: event.requester,
    threadKey: event.threadKey,
    stage: event.stage,
    request: event.request,
    conditions,
    position: waitingAhead + 1,
    queuedAt: event.at,
    state: "waiting",
  };
  return {
    state: { ...state, queue: [...state.queue, row] },
    effects: [],
    writes: [{ table: "plane_queue", op: "put", row }],
  };
}

function onSealed(state: PlaneState, event: { kind: "sealed"; at: number; threadKey: string }): PlaneDecision {
  const liveThreads = state.liveThreads.filter((t) => t !== event.threadKey);
  const reservations = state.reservations.filter((r) => r.key !== event.threadKey);
  const freed = liveThreads.length !== state.liveThreads.length || reservations.length !== state.reservations.length;
  if (!freed && !hasWaiting(state, event.threadKey)) return { state, effects: [], writes: [] };
  const writes: PlaneWrite[] =
    reservations.length !== state.reservations.length
      ? [{ table: "plane_reservations", op: "del", key: event.threadKey }]
      : [];
  const walked = walk({ ...state, liveThreads, reservations }, event.at);
  return { ...walked, writes: [...writes, ...walked.writes] };
}

function onWindow(
  state: PlaneState,
  event: { kind: "window"; at: number; window: string; phase: string },
): PlaneDecision {
  if (event.phase === "opened") {
    if (state.openWindows.includes(event.window)) return { state, effects: [], writes: [] };
    return {
      state: { ...state, openWindows: [...state.openWindows, event.window] },
      effects: [],
      writes: [{ table: "plane_windows", op: "put", window: event.window, at: event.at }],
    };
  }
  if (!state.openWindows.includes(event.window)) return { state, effects: [], writes: [] };
  const next = { ...state, openWindows: state.openWindows.filter((w) => w !== event.window) };
  const walked = walk(next, event.at);
  return { ...walked, writes: [{ table: "plane_windows", op: "del", window: event.window }, ...walked.writes] };
}

function onWithdraw(state: PlaneState, event: { kind: "withdraw"; at: number; runId: string }): PlaneDecision {
  const row = state.queue.find((r) => r.runId === event.runId && r.state === "waiting");
  if (!row) return { state, effects: [], writes: [] };
  const queue = state.queue.map((r) => (r === row ? { ...r, state: "withdrawn" as const } : r));
  return {
    state: { ...state, queue },
    effects: [],
    writes: [{ table: "plane_queue", op: "state", runId: event.runId, state: "withdrawn" }],
  };
}

function hasWaiting(state: PlaneState, threadKey: string): boolean {
  return state.queue.some((r) => r.state === "waiting" && r.threadKey === threadKey);
}

/** The queue walk (record 0064): oldest first, and the state is re-evaluated
 *  after each admission — an admitted run's thread is live again, so a second
 *  row on the same thread keeps waiting for the next seal. */
function walk(state: PlaneState, at: number): PlaneDecision {
  let next = state;
  const effects: PlaneEffect[] = [];
  const writes: PlaneWrite[] = [];
  for (;;) {
    const row = next.queue.find((r) => r.state === "waiting" && conditionsMet(next, r));
    if (!row) break;
    const admitted: PlaneQueueRow = { ...row, state: "admitted" };
    const effect: PlaneEffect = {
      id: `admit:${row.runId}`,
      kind: "admit",
      runId: row.runId,
      threadKey: row.threadKey,
      request: row.request,
    };
    // The admitted run reserves its thread like a fresh admission does, so the
    // ledger claim under its id promotes the same row and a rival ask queues.
    const reservation: PlaneReservation = { kind: "thread", key: row.threadKey, runId: row.runId, at };
    next = {
      ...next,
      queue: next.queue.map((r) => (r === row ? admitted : r)),
      reservations: [...next.reservations, reservation],
    };
    effects.push(effect);
    writes.push({ table: "plane_queue", op: "state", runId: row.runId, state: "admitted" });
    writes.push({ table: "plane_effects", op: "offer", effect, at });
    writes.push({ table: "plane_reservations", op: "put", row: reservation });
  }
  return { state: next, effects, writes };
}

function conditionsMet(state: PlaneState, row: PlaneQueueRow): boolean {
  return row.conditions.every((c) => {
    switch (c.kind) {
      case "thread_free":
        return !state.liveThreads.includes(c.threadKey) && !state.reservations.some((r) => r.key === c.threadKey);
      case "window_open":
        return !state.openWindows.includes(c.window);
      case "deploy_settled":
        return !state.openWindows.includes(DEPLOY_WINDOW);
    }
  });
}
