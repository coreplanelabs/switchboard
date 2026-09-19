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
 *  flipped by an event the plane already sees, never polled. The union grows
 *  one member per stage as the later units land. */
export type PlaneCondition = { kind: "thread_free"; threadKey: string; met: boolean };

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
}

export function emptyPlaneState(): PlaneState {
  return { queue: [], liveThreads: [] };
}

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
  PlaneAskEvent | { kind: "sealed"; at: number; threadKey: string } | { kind: "withdraw"; at: number; runId: string };

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
  | { table: "plane_effects"; op: "offer"; effect: PlaneEffect; at: number };

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
  }
}

/** The shadow word for an ask the decider just judged (orchestration-plane item 8): `queued` when the
 *  decision holds a waiting row for the run, `proceed` when it holds none —
 *  what the object logs beside the bot's own outcome. */
export function planeAskWordOf(decision: PlaneDecision, runId: string): "proceed" | "queued" {
  const row = decision.state.queue.find((r) => r.runId === runId);
  return row && row.state === "waiting" ? "queued" : "proceed";
}

function onAsk(state: PlaneState, event: PlaneAskEvent): PlaneDecision {
  const threadLive = state.liveThreads.includes(event.threadKey);
  if (!threadLive) return { state, effects: [], writes: [] };
  const waitingAhead = state.queue.filter((r) => r.state === "waiting" && r.threadKey === event.threadKey).length;
  const row: PlaneQueueRow = {
    runId: event.runId,
    requester: event.requester,
    threadKey: event.threadKey,
    stage: event.stage,
    request: event.request,
    conditions: [{ kind: "thread_free", threadKey: event.threadKey, met: false }],
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
  if (liveThreads.length === state.liveThreads.length && !hasWaiting(state, event.threadKey))
    return { state, effects: [], writes: [] };
  return walk({ ...state, liveThreads }, event.at);
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
    next = {
      queue: next.queue.map((r) => (r === row ? admitted : r)),
      liveThreads: [...next.liveThreads, row.threadKey],
    };
    effects.push(effect);
    writes.push({ table: "plane_queue", op: "state", runId: row.runId, state: "admitted" });
    writes.push({ table: "plane_effects", op: "offer", effect, at });
  }
  return { state: next, effects, writes };
}

function conditionsMet(state: PlaneState, row: PlaneQueueRow): boolean {
  return row.conditions.every((c) => !state.liveThreads.includes(c.threadKey));
}
