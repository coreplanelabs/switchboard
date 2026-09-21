import { describe, expect, it } from "vitest";
import {
  causeOfClose,
  causeOfReclaim,
  conditionOfRefusal,
  decide,
  endingCauseWords,
  PLANE_ENDING_CAUSES,
  emptyPlaneState,
  planeAskAnswerOf,
  planeAskWordOf,
  residentSideOf,
  RESIDENT_DRAIN_WINDOW,
  type PlaneAskEvent,
  type PlaneLevelRow,
  type PlaneState,
} from "./decide.js";

// Feature: docs/reference/specs/orchestration-plane.md — the plane's decider
// (record 0064, "Where it lives"): a pure function over a closed event union.
// The object applies it inside one transactionSync; these tests pin the
// transitions alone.

const ask = (over: Partial<PlaneAskEvent> = {}): PlaneAskEvent => ({
  kind: "ask",
  at: 1_000,
  runId: "run-a",
  requester: "slack:U77",
  threadKey: "slack:C1:1.1",
  stage: "admission",
  request: { text: "do the thing" },
  ...over,
});

const stateWith = (over: Partial<PlaneState> = {}): PlaneState => ({
  ...emptyPlaneState(),
  ...over,
});

describe("decide — the plane's pure decider (orchestration-plane, record 0064)", () => {
  it("an ask on a free thread is admitted: no queue row, a reservation on the thread written in the same decision, no effects", () => {
    const out = decide(emptyPlaneState(), ask());
    expect(out.state.queue).toEqual([]);
    expect(out.writes).toEqual([
      {
        table: "plane_reservations",
        op: "put",
        row: { kind: "thread", key: "slack:C1:1.1", runId: "run-a", at: 1_000 },
      },
    ]);
    expect(out.effects).toEqual([]);
    expect(planeAskWordOf(out, "run-a")).toBe("proceed");
    expect(planeAskAnswerOf(out, "run-a")).toEqual({ kind: "admitted", reservation: "run-a" });
  });

  it("two asks a second apart on one thread: the first is admitted with a reservation, the second queues with position 1 behind it", () => {
    const first = decide(emptyPlaneState(), ask());
    const out = decide(first.state, ask({ runId: "run-b", at: 2_000 }));
    expect(planeAskAnswerOf(out, "run-b")).toEqual({
      kind: "queued",
      id: "run-b",
      position: 1,
      waiting: [{ kind: "thread_free", threadKey: "slack:C1:1.1", met: false }],
    });
  });

  it("an ask on a live thread queues with a thread_free condition and position 1", () => {
    const out = decide(stateWith({ liveThreads: ["slack:C1:1.1"] }), ask());
    expect(out.state.queue).toHaveLength(1);
    const row = out.state.queue[0]!;
    expect(row.state).toBe("waiting");
    expect(row.position).toBe(1);
    expect(row.conditions).toEqual([{ kind: "thread_free", threadKey: "slack:C1:1.1", met: false }]);
    expect(out.writes).toEqual([{ table: "plane_queue", op: "put", row }]);
    expect(out.effects).toEqual([]);
    expect(planeAskWordOf(out, "run-a")).toBe("queued");
  });

  it("a second ask on the same live thread queues behind the first, position 2", () => {
    const first = decide(stateWith({ liveThreads: ["slack:C1:1.1"] }), ask());
    const out = decide(first.state, ask({ runId: "run-b", at: 2_000 }));
    expect(out.state.queue.map((r) => r.runId)).toEqual(["run-a", "run-b"]);
    expect(out.state.queue[1]!.position).toBe(2);
  });

  it("a thread_free condition flips on a seal and the oldest waiting row is admitted, with an effect carrying its id", () => {
    const queued = decide(stateWith({ liveThreads: ["slack:C1:1.1"] }), ask());
    const out = decide(queued.state, { kind: "sealed", at: 3_000, threadKey: "slack:C1:1.1" });
    expect(out.effects).toEqual([
      {
        id: "admit:run-a",
        kind: "admit",
        runId: "run-a",
        threadKey: "slack:C1:1.1",
        request: { text: "do the thing" },
      },
    ]);
    const row = out.state.queue.find((r) => r.runId === "run-a")!;
    expect(row.state).toBe("admitted");
    expect(out.writes).toContainEqual({ table: "plane_queue", op: "state", runId: "run-a", state: "admitted" });
    expect(out.writes).toContainEqual({
      table: "plane_effects",
      op: "offer",
      effect: out.effects[0],
      at: 3_000,
    });
  });

  it("a queue walk admits oldest first and re-evaluates after each admission: the admitted run's thread is live again, so its follower keeps waiting", () => {
    let s = stateWith({ liveThreads: ["slack:C1:1.1"] });
    s = decide(s, ask()).state;
    s = decide(s, ask({ runId: "run-b", at: 2_000 })).state;
    const out = decide(s, { kind: "sealed", at: 3_000, threadKey: "slack:C1:1.1" });
    // Only the oldest is admitted; its admission reserves the thread again.
    expect(out.effects.map((e) => e.id)).toEqual(["admit:run-a"]);
    expect(out.state.reservations.map((r) => r.key)).toContain("slack:C1:1.1");
    expect(out.writes).toContainEqual({
      table: "plane_reservations",
      op: "put",
      row: { kind: "thread", key: "slack:C1:1.1", runId: "run-a", at: 3_000 },
    });
    expect(out.state.queue.find((r) => r.runId === "run-b")!.state).toBe("waiting");
  });

  it("two waiting rows on different threads are both admitted on their seals, oldest first", () => {
    let s = stateWith({ liveThreads: ["slack:C1:1.1", "slack:C2:2.2"] });
    s = decide(s, ask()).state;
    s = decide(s, ask({ runId: "run-b", threadKey: "slack:C2:2.2", at: 2_000 })).state;
    const one = decide(s, { kind: "sealed", at: 3_000, threadKey: "slack:C2:2.2" });
    expect(one.effects.map((e) => e.id)).toEqual(["admit:run-b"]);
    const two = decide(one.state, { kind: "sealed", at: 4_000, threadKey: "slack:C1:1.1" });
    expect(two.effects.map((e) => e.id)).toEqual(["admit:run-a"]);
  });

  it("an event with no transition returns the state unchanged: a seal nothing waits on", () => {
    const s = stateWith({ liveThreads: ["slack:C9:9.9"] });
    const out = decide(s, { kind: "sealed", at: 5_000, threadKey: "slack:C9:9.9" });
    expect(out.state.queue).toEqual([]);
    expect(out.state.liveThreads).toEqual([]);
    expect(out.effects).toEqual([]);
    expect(out.writes).toEqual([]);
  });

  it("a withdraw marks the waiting row withdrawn and a withdraw of an unknown run changes nothing", () => {
    const queued = decide(stateWith({ liveThreads: ["slack:C1:1.1"] }), ask());
    const out = decide(queued.state, { kind: "withdraw", at: 4_000, runId: "run-a" });
    expect(out.state.queue.find((r) => r.runId === "run-a")!.state).toBe("withdrawn");
    expect(out.writes).toEqual([{ table: "plane_queue", op: "state", runId: "run-a", state: "withdrawn" }]);
    const noop = decide(out.state, { kind: "withdraw", at: 5_000, runId: "run-x" });
    expect(noop.state).toEqual(out.state);
    expect(noop.writes).toEqual([]);
    expect(noop.effects).toEqual([]);
  });

  it("a withdrawn row is never admitted by a later seal", () => {
    const queued = decide(stateWith({ liveThreads: ["slack:C1:1.1"] }), ask());
    const withdrawn = decide(queued.state, { kind: "withdraw", at: 4_000, runId: "run-a" });
    const out = decide(withdrawn.state, { kind: "sealed", at: 5_000, threadKey: "slack:C1:1.1" });
    expect(out.effects).toEqual([]);
  });

  it("effects carry stable ids derived from the run they admit", () => {
    const queued = decide(stateWith({ liveThreads: ["slack:C1:1.1"] }), ask({ runId: "run-z" }));
    const out = decide(queued.state, { kind: "sealed", at: 3_000, threadKey: "slack:C1:1.1" });
    expect(out.effects[0]!.id).toBe("admit:run-z");
  });

  it("an ask that meets an open window queues on window_open and is admitted by the window's lift", () => {
    const opened = decide(emptyPlaneState(), { kind: "window", at: 500, window: "quiet", phase: "opened" });
    expect(opened.writes).toEqual([{ table: "plane_windows", op: "put", window: "quiet", at: 500 }]);
    const queued = decide(opened.state, ask());
    expect(planeAskAnswerOf(queued, "run-a")).toEqual({
      kind: "queued",
      id: "run-a",
      position: 1,
      waiting: [{ kind: "window_open", window: "quiet", met: false }],
    });
    const lifted = decide(queued.state, { kind: "window", at: 2_000, window: "quiet", phase: "lifted" });
    expect(lifted.writes).toContainEqual({ table: "plane_windows", op: "del", window: "quiet" });
    expect(lifted.effects.map((e) => e.id)).toEqual(["admit:run-a"]);
  });

  it("an ask that meets a pending deploy queues on deploy_settled and deploy.landed flips it", () => {
    const pending = decide(emptyPlaneState(), { kind: "window", at: 500, window: "deploy", phase: "opened" });
    const queued = decide(pending.state, ask());
    expect(planeAskAnswerOf(queued, "run-a")).toEqual({
      kind: "queued",
      id: "run-a",
      position: 1,
      waiting: [{ kind: "deploy_settled", met: false }],
    });
    // The deploy runner's `deploy.landed` post lifts the deploy window and the queue walks.
    const landed = decide(queued.state, { kind: "window", at: 2_000, window: "deploy", phase: "lifted" });
    expect(landed.effects.map((e) => e.id)).toEqual(["admit:run-a"]);
    expect(landed.state.queue.find((r) => r.runId === "run-a")!.state).toBe("admitted");
  });

  it("a reserved thread queues a second ask until the seal deletes the reservation and admits it", () => {
    const first = decide(emptyPlaneState(), ask());
    const second = decide(first.state, ask({ runId: "run-b", at: 2_000 }));
    expect(planeAskAnswerOf(second, "run-b")).toMatchObject({ kind: "queued" });
    const sealed = decide(second.state, { kind: "sealed", at: 3_000, threadKey: "slack:C1:1.1" });
    expect(sealed.writes).toContainEqual({ table: "plane_reservations", op: "del", key: "slack:C1:1.1" });
    expect(sealed.effects.map((e) => e.id)).toEqual(["admit:run-b"]);
  });

  it("position counts waiting rows sharing the unmet condition, per condition", () => {
    // Two threads live; one waiting row on each. A third ask on the first
    // thread ranks only among that thread's waiters.
    let s = stateWith({ liveThreads: ["slack:C1:1.1", "slack:C2:2.2"] });
    s = decide(s, ask()).state;
    s = decide(s, ask({ runId: "run-b", threadKey: "slack:C2:2.2", at: 2_000 })).state;
    const third = decide(s, ask({ runId: "run-c", at: 3_000 }));
    expect(planeAskAnswerOf(third, "run-c")).toMatchObject({ kind: "queued", position: 2 });
  });
});

// Feature: docs/reference/specs/orchestration-plane.md — the resident stage's
// conditions (record 0064, "The queue"): seat and memory levels queue
// a write ask at stage three, a `below` report admits it, a refusal-by-name
// re-enters an admitted run at its old position, and a silent resident is
// probed at the re-ask cadence, never waited on forever.
describe("decide — the resident stage's conditions (record 0064)", () => {
  const level = (over: Partial<PlaneLevelRow> = {}): PlaneLevelRow => ({
    resident: "acme/app",
    name: "memory",
    side: "above",
    reportedAt: 500,
    generation: "gen-1",
    ...over,
  });
  const residentAsk = (over: Partial<PlaneAskEvent> = {}): PlaneAskEvent =>
    ask({ stage: "resident", resident: "acme/app", ...over });

  it("a write ask on a resident above the soft memory line queues at stage three on the memory condition", () => {
    const out = decide(stateWith({ levels: [level()] }), residentAsk());
    expect(planeAskAnswerOf(out, "run-a")).toEqual({
      kind: "queued",
      id: "run-a",
      position: 1,
      waiting: [{ kind: "memory", resident: "acme/app", met: false }],
    });
    // Queued at stage three holds nothing: no reservation, no run row — only the queue row.
    expect(out.writes).toEqual([{ table: "plane_queue", op: "put", row: out.state.queue[0] }]);
  });

  it("an exhausted seat pool queues the ask on the seat condition", () => {
    const out = decide(stateWith({ levels: [level({ name: "seat" })] }), residentAsk());
    expect(planeAskAnswerOf(out, "run-a")).toMatchObject({
      kind: "queued",
      waiting: [{ kind: "seat", resident: "acme/app", met: false }],
    });
  });

  it("a level report below the line admits the queued ask, with an admit effect and no earlier", () => {
    const queued = decide(stateWith({ levels: [level()] }), residentAsk());
    const still = decide(queued.state, {
      kind: "level",
      at: 2_000,
      resident: "acme/app",
      name: "memory",
      side: "above",
      generation: "gen-1",
    });
    expect(still.effects).toEqual([]);
    const below = decide(still.state, {
      kind: "level",
      at: 3_000,
      resident: "acme/app",
      name: "memory",
      side: "below",
      generation: "gen-1",
    });
    expect(below.effects).toEqual([
      {
        id: "admit:run-a",
        kind: "admit",
        runId: "run-a",
        threadKey: "slack:C1:1.1",
        request: { text: "do the thing" },
      },
    ]);
    expect(below.writes).toContainEqual({
      table: "plane_levels",
      op: "put",
      row: { resident: "acme/app", name: "memory", side: "below", reportedAt: 3_000, generation: "gen-1" },
    });
  });

  it("another resident's below report admits nothing here", () => {
    const queued = decide(stateWith({ levels: [level()] }), residentAsk());
    const other = decide(queued.state, {
      kind: "level",
      at: 2_000,
      resident: "acme/other",
      name: "memory",
      side: "below",
      generation: "gen-9",
    });
    expect(other.effects).toEqual([]);
  });

  it("a resident ask under levels below both lines proceeds and writes nothing — its thread is already this run's", () => {
    const out = decide(
      stateWith({ levels: [level({ side: "below" }), level({ name: "seat", side: "below" })] }),
      residentAsk(),
    );
    expect(planeAskAnswerOf(out, "run-a")).toEqual({ kind: "admitted", reservation: "run-a" });
    expect(out.writes).toEqual([]);
  });

  it("a restartOf ask passes the windows and the memory line (record 0064)", () => {
    const out = decide(
      stateWith({ levels: [level()], openWindows: [RESIDENT_DRAIN_WINDOW, "deploy"] }),
      residentAsk({ restartOf: true }),
    );
    expect(planeAskAnswerOf(out, "run-a")).toEqual({ kind: "admitted", reservation: "run-a" });
  });

  it("an unknown resident — never reported, or a report from an older generation — queues nothing: the bot falls cold for it (record 0064)", () => {
    expect(residentSideOf([], "acme/app", "memory")).toBe("unknown");
    expect(residentSideOf([level()], "acme/app", "memory", "gen-2")).toBe("unknown");
    expect(residentSideOf([level()], "acme/app", "memory", "gen-1")).toBe("above");
    const out = decide(emptyPlaneState(), residentAsk());
    expect(planeAskAnswerOf(out, "run-a")).toEqual({ kind: "admitted", reservation: "run-a" });
    expect(out.writes).toEqual([]);
  });

  it("an admitted run refused a seat re-enters the queue at its old position, and the refusal writes the level above (record 0064)", () => {
    const queued = decide(stateWith({ levels: [level()] }), residentAsk());
    const admitted = decide(queued.state, {
      kind: "level",
      at: 2_000,
      resident: "acme/app",
      name: "memory",
      side: "below",
      generation: "gen-1",
    });
    const observed = decide(admitted.state, {
      kind: "observation",
      at: 3_000,
      runId: "run-a",
      resident: "acme/app",
      refusal: "user-pool-exhausted: all 16 thread users are allocated",
    });
    const row = observed.state.queue.find((r) => r.runId === "run-a");
    expect(row).toMatchObject({
      state: "waiting",
      position: 1,
      conditions: [{ kind: "seat", resident: "acme/app", met: false }],
    });
    expect(observed.writes).toContainEqual({
      table: "plane_levels",
      op: "put",
      row: { resident: "acme/app", name: "seat", side: "above", reportedAt: 3_000, generation: "gen-1" },
    });
    // The next below report re-admits it — same id, same effect.
    const readmitted = decide(observed.state, {
      kind: "level",
      at: 4_000,
      resident: "acme/app",
      name: "seat",
      side: "below",
      generation: "gen-1",
    });
    expect(readmitted.effects.map((e) => e.id)).toEqual(["admit:run-a"]);
  });

  it("an observation for a run the queue never admitted, or a refusal with no condition, is a no-op", () => {
    const out = decide(emptyPlaneState(), {
      kind: "observation",
      at: 1_000,
      runId: "run-x",
      resident: "acme/app",
      refusal: "user-pool-exhausted: full",
    });
    expect(out.writes).toEqual([]);
    expect(conditionOfRefusal("something-else entirely", "acme/app")).toBeUndefined();
  });

  it("conditionOfRefusal maps every named refusal: pool → seat, gate → memory, drain → the drain window, runtime → seat", () => {
    expect(conditionOfRefusal("user-pool-exhausted: full", "a/b")).toEqual({
      kind: "seat",
      resident: "a/b",
      met: false,
    });
    expect(conditionOfRefusal("memory-pressure: 92% of cap", "a/b")).toEqual({
      kind: "memory",
      resident: "a/b",
      met: false,
    });
    expect(conditionOfRefusal("draining: the resident fleet is closed", "a/b")).toEqual({
      kind: "window_open",
      window: RESIDENT_DRAIN_WINDOW,
      met: false,
    });
    expect(conditionOfRefusal("runtime-replaced: the container rolled", "a/b")).toEqual({
      kind: "seat",
      resident: "a/b",
      met: false,
    });
  });

  it("the registry's drain opens the resident-drain window and its cleared or expired post lifts it, admitting the waiters", () => {
    const opened = decide(emptyPlaneState(), {
      kind: "window",
      at: 1_000,
      window: RESIDENT_DRAIN_WINDOW,
      phase: "opened",
    });
    const queued = decide(opened.state, ask({ at: 2_000 }));
    expect(planeAskAnswerOf(queued, "run-a")).toMatchObject({
      kind: "queued",
      waiting: [{ kind: "window_open", window: RESIDENT_DRAIN_WINDOW, met: false }],
    });
    const lifted = decide(queued.state, { kind: "window", at: 3_000, window: RESIDENT_DRAIN_WINDOW, phase: "lifted" });
    expect(lifted.effects.map((e) => e.id)).toEqual(["admit:run-a"]);
  });

  it("a reask emits one probe per silent resident a waiting row waits on — and none for one that reported within the cadence (record 0064)", () => {
    const queued = decide(stateWith({ levels: [level({ reportedAt: 500 })] }), residentAsk());
    const probed = decide(queued.state, { kind: "reask", at: 121_000, cadenceMs: 120_000 });
    expect(probed.effects).toEqual([{ id: "probe:acme/app", kind: "probe", resident: "acme/app" }]);
    expect(probed.writes).toEqual([{ table: "plane_effects", op: "offer", effect: probed.effects[0], at: 121_000 }]);
    // A report within the cadence silences the probe.
    const fresh = decide(queued.state, {
      kind: "level",
      at: 100_000,
      resident: "acme/app",
      name: "memory",
      side: "above",
      generation: "gen-1",
    });
    const quiet = decide(fresh.state, { kind: "reask", at: 121_000, cadenceMs: 120_000 });
    expect(quiet.effects).toEqual([]);
  });

  it("a reask with nothing waiting on a resident emits nothing", () => {
    const queued = decide(stateWith({ liveThreads: ["slack:C1:1.1"] }), ask());
    const out = decide(queued.state, { kind: "reask", at: 500_000, cadenceMs: 120_000 });
    expect(out.effects).toEqual([]);
  });
});

describe("decide — the checkpoint steers and the provider condition (record 0064)", () => {
  const MIN = 60_000;
  const facts = (over: Partial<import("./decide.js").HeartbeatFacts> = {}) => ({
    round: 3,
    coding: true,
    startedAt: 0,
    ...over,
  });
  const beat = (at: number, f = facts(), runId = "run-a") => ({ kind: "heartbeat", at, runId, facts: f }) as const;
  const decideEvent = (e: unknown) => e as Parameters<typeof decide>[1];

  it("a heartbeat whose in-flight call is past its declared bound writes ONE inbox row with the fixed sentence and the plane sender, plus the steer's dedupe row", () => {
    const f = facts({
      inFlight: { callId: "c1", tool: "bash", sinceAt: 0, boundMs: 5 * MIN },
      pushedHead: { ref: "b", sha: "s", at: 5 * MIN },
    });
    const out = decide(emptyPlaneState(), decideEvent(beat(6 * MIN, f)));
    const inbox = out.writes.filter((w) => w.table === "run_inbox");
    expect(inbox).toEqual([
      {
        table: "run_inbox",
        op: "push",
        runId: "run-a",
        message: {
          text: "finish the step you are on, push a checkpoint and end the round; start no new command; the resident takes your push",
          at: 6 * MIN,
          userId: "plane",
          userName: "plane",
          plane: { steer: "checkpoint", causes: ["long_call"], round: 3 },
        },
      },
    ]);
    expect(out.writes.filter((w) => w.table === "plane_reservations")).toEqual([
      {
        table: "plane_reservations",
        op: "put",
        row: { kind: "steer", key: "run-a#3#long_call", runId: "run-a", at: 6 * MIN },
      },
    ]);
  });

  it("a call within its bound, a call with no bound within the no-bound line, and a non-coding run all steer nothing", () => {
    const within = facts({
      inFlight: { callId: "c1", tool: "bash", sinceAt: 0, boundMs: 10 * MIN },
      pushedHead: { ref: "b", sha: "s", at: 5 * MIN },
    });
    expect(decide(emptyPlaneState(), decideEvent(beat(6 * MIN, within))).writes).toEqual([]);
    const noBound = facts({
      inFlight: { callId: "c1", tool: "bash", sinceAt: 0 },
      pushedHead: { ref: "b", sha: "s", at: 14 * MIN },
    });
    expect(decide(emptyPlaneState(), decideEvent(beat(15 * MIN, noBound))).writes).toEqual([]);
    const readonly = facts({ coding: false, inFlight: { callId: "c1", tool: "bash", sinceAt: 0, boundMs: MIN } });
    expect(decide(emptyPlaneState(), decideEvent(beat(60 * MIN, readonly))).writes).toEqual([]);
  });

  it("a coding round with no pushed head past noPushMinutes steers no_push; a second heartbeat in the same round writes none; a new round writes one again", () => {
    const first = decide(emptyPlaneState(), decideEvent(beat(16 * MIN)));
    expect(first.writes.filter((w) => w.table === "run_inbox")).toHaveLength(1);
    const second = decide(first.state, decideEvent(beat(17 * MIN)));
    expect(second.writes).toEqual([]);
    const nextRound = decide(second.state, decideEvent(beat(18 * MIN, facts({ round: 4 }))));
    expect(nextRound.writes.filter((w) => w.table === "run_inbox")).toHaveLength(1);
  });

  it("the same sentence from two causes is written once per round: both dedupe rows land, one inbox row", () => {
    const f = facts({ inFlight: { callId: "c1", tool: "bash", sinceAt: 0, boundMs: MIN } });
    const out = decide(emptyPlaneState(), decideEvent(beat(16 * MIN, f)));
    expect(out.writes.filter((w) => w.table === "plane_reservations")).toHaveLength(2);
    expect(out.writes.filter((w) => w.table === "run_inbox")).toHaveLength(1);
    // The second cause arriving on a later heartbeat of the same round records its row but repeats no sentence.
    const noPushOnly = decide(
      decide(emptyPlaneState(), decideEvent(beat(2 * MIN, f))).state, // long_call steered at 2min (no_push not yet due)
      decideEvent(beat(16 * MIN, facts())),
    );
    expect(noPushOnly.writes.filter((w) => w.table === "plane_reservations")).toEqual([
      {
        table: "plane_reservations",
        op: "put",
        row: { kind: "steer", key: "run-a#3#no_push", runId: "run-a", at: 16 * MIN },
      },
    ]);
    expect(noPushOnly.writes.filter((w) => w.table === "run_inbox")).toEqual([]);
  });

  it("a fresh push resets the no-push clock: a head pushed within the window steers nothing", () => {
    const pushed = facts({ pushedHead: { ref: "b", sha: "s", at: 10 * MIN, clean: true } });
    expect(decide(emptyPlaneState(), decideEvent(beat(16 * MIN, pushed))).writes).toEqual([]);
  });

  it("a provider down report writes the level row and nothing else; a park writes one park row, a second park of the same run is a no-op", () => {
    const down = decide(emptyPlaneState(), { kind: "provider_level", at: 1_000, provider: "anthropic", level: "down" });
    expect(down.writes).toEqual([
      {
        table: "plane_levels",
        op: "put",
        row: { resident: "anthropic", name: "provider", side: "above", reportedAt: 1_000, generation: "" },
      },
    ]);
    const parked = decide(down.state, { kind: "park", at: 1_100, runId: "run-a", provider: "anthropic" });
    expect(parked.writes).toEqual([
      {
        table: "plane_reservations",
        op: "put",
        row: { kind: "park", key: "anthropic#run-a", runId: "run-a", at: 1_100 },
      },
    ]);
    expect(decide(parked.state, { kind: "park", at: 1_200, runId: "run-a", provider: "anthropic" }).writes).toEqual([]);
  });

  it("the provider's next up report — from any run — writes each held turn's durable row and typed live steer together, then deletes the park; a repeat up steers nothing", () => {
    let s = stateWith({
      liveRuns: {
        "run-a": { channelId: "slack:C1", threadKey: "slack:C1:1.0" },
        "run-b": { channelId: "slack:C2", threadKey: "slack:C2:2.0" },
      },
      inboxSeqs: { "run-a": 4, "run-b": 8 },
    });
    s = decide(s, {
      kind: "provider_level",
      at: 1_000,
      provider: "anthropic",
      level: "down",
    }).state;
    s = decide(s, { kind: "park", at: 1_100, runId: "run-a", provider: "anthropic" }).state;
    s = decide(s, { kind: "park", at: 1_200, runId: "run-b", provider: "anthropic" }).state;
    const up = decide(s, { kind: "provider_level", at: 2_000, provider: "anthropic", level: "up" });
    const inbox = up.writes.filter((w) => w.table === "run_inbox");
    expect(inbox.map((w) => (w as { runId: string }).runId).sort()).toEqual(["run-a", "run-b"]);
    for (const w of inbox)
      expect((w as unknown as { message: { text: string; userId: string } }).message).toMatchObject({
        text: "the model provider anthropic is answering again — re-issue the held turn and continue",
        userId: "plane",
      });
    expect(up.effects).toEqual([
      {
        id: "steer:run-a:5",
        kind: "steer",
        runId: "run-a",
        seq: 5,
        message: {
          channelId: "slack:C1",
          threadKey: "slack:C1:1.0",
          text: "the model provider anthropic is answering again — re-issue the held turn and continue",
          at: 2_000,
          userId: "plane",
          userName: "plane",
          plane: { steer: "reissue", provider: "anthropic" },
        },
      },
      {
        id: "steer:run-b:9",
        kind: "steer",
        runId: "run-b",
        seq: 9,
        message: {
          channelId: "slack:C2",
          threadKey: "slack:C2:2.0",
          text: "the model provider anthropic is answering again — re-issue the held turn and continue",
          at: 2_000,
          userId: "plane",
          userName: "plane",
          plane: { steer: "reissue", provider: "anthropic" },
        },
      },
    ]);
    expect(up.writes.filter((w) => w.table === "plane_effects")).toEqual(
      up.effects.map((effect) => ({ table: "plane_effects", op: "offer", effect, at: 2_000 })),
    );
    expect(up.writes.filter((w) => w.table === "plane_reservations" && w.op === "del")).toEqual([
      { table: "plane_reservations", op: "del", key: "anthropic#run-a", kind: "park" },
      { table: "plane_reservations", op: "del", key: "anthropic#run-b", kind: "park" },
    ]);
    expect(
      decide(up.state, { kind: "provider_level", at: 3_000, provider: "anthropic", level: "up" }).writes.filter(
        (w) => w.table === "run_inbox" || w.table === "plane_effects",
      ),
    ).toEqual([]);
  });

  it("a provider up after the parked run is no longer live deletes the stale park and offers no steer", () => {
    const s = decide(emptyPlaneState(), { kind: "park", at: 1_100, runId: "run-sealed", provider: "anthropic" }).state;
    const up = decide(s, { kind: "provider_level", at: 2_000, provider: "anthropic", level: "up" });
    expect(up.effects).toEqual([]);
    expect(up.writes.filter((w) => w.table === "run_inbox" || w.table === "plane_effects")).toEqual([]);
    expect(up.writes).toContainEqual({
      table: "plane_reservations",
      op: "del",
      key: "anthropic#run-sealed",
      kind: "park",
    });
  });

  it("a queued row waiting on provider_up is admitted by the up report and not before", () => {
    const row = {
      runId: "run-q",
      requester: "slack:UQ",
      threadKey: "slack:C1:9.9",
      stage: "admission" as const,
      request: {},
      conditions: [{ kind: "provider_up" as const, provider: "anthropic", met: false }],
      position: 1,
      queuedAt: 500,
      state: "waiting" as const,
    };
    const s = stateWith({ queue: [row] });
    expect(decide(s, { kind: "provider_level", at: 1_000, provider: "anthropic", level: "down" }).effects).toEqual([]);
    const up = decide(s, { kind: "provider_level", at: 2_000, provider: "anthropic", level: "up" });
    expect(up.effects.map((e) => e.kind)).toEqual(["admit"]);
  });
});

describe("endings and their causes", () => {
  it("causeOfClose maps a closing record's status onto the closed set: completed, failed and the stops to themselves; interrupted with `restarting` to resident_replaced; any other close to lease_lapsed, which blames nobody", () => {
    expect(causeOfClose("completed")).toBe("completed");
    expect(causeOfClose("failed")).toBe("failed");
    expect(causeOfClose("stopped_soft")).toBe("stopped");
    expect(causeOfClose("stopped_hard")).toBe("stopped");
    expect(causeOfClose("interrupted", true)).toBe("resident_replaced");
    expect(causeOfClose("interrupted")).toBe("lease_lapsed");
    expect(causeOfClose("interrupted", false)).toBe("lease_lapsed");
  });

  it("causeOfReclaim assigns a cause only to `closed` — a row resumed, restarted or re-hosted did not close, so a roll that resumes every row assigns nothing", () => {
    expect(causeOfReclaim("closed")).toBe("lease_lapsed");
    expect(causeOfReclaim("resume")).toBeUndefined();
    expect(causeOfReclaim("restart")).toBeUndefined();
    expect(causeOfReclaim("rehost")).toBeUndefined();
  });

  it("endingCauseWords renders every cause of the closed set in the user's nouns — the one rendering every surface shares, so no note composes its own", () => {
    for (const cause of PLANE_ENDING_CAUSES) expect(endingCauseWords(cause).length).toBeGreaterThan(0);
    expect(endingCauseWords("lease_lapsed")).toBe("its lease lapsed with no heartbeat");
    expect(endingCauseWords("resident_replaced")).toBe("the resident container running it was replaced");
    expect(endingCauseWords("runner_gone")).toBe("the runner instance driving it is gone");
  });
});

describe("the moves (record 0064, 'Endings and the watches')", () => {
  it("unit_title: a tracked pull request whose title fails the rule gets one `retitle` effect under the pull request's own id; a passing title is a no-op", () => {
    const failed = decide(emptyPlaneState(), {
      kind: "pr_tracked",
      at: 1_000,
      repo: "acme/api",
      number: 7,
      titleOk: false,
    });
    expect(failed.effects).toEqual([{ id: "retitle:acme/api#7", kind: "retitle", repo: "acme/api", number: 7 }]);
    expect(failed.writes).toEqual([{ table: "plane_effects", op: "offer", effect: failed.effects[0], at: 1_000 }]);
    const passed = decide(emptyPlaneState(), {
      kind: "pr_tracked",
      at: 1_000,
      repo: "acme/api",
      number: 7,
      titleOk: true,
    });
    expect(passed.effects).toEqual([]);
    expect(passed.writes).toEqual([]);
  });

  it("orphaned_child: a child sealed with a pushed branch, no pull request and no live runner gets a `pr_open` effect from the branch", () => {
    const out = decide(emptyPlaneState(), {
      kind: "child_sealed",
      at: 2_000,
      runId: "run-dead",
      runnerLive: false,
      repo: "acme/api",
      branch: "plan/x/u1",
    });
    expect(out.effects).toEqual([
      { id: "pr_open:acme/api#plan/x/u1", kind: "pr_open", repo: "acme/api", branch: "plan/x/u1", runId: "run-dead" },
    ]);
    expect(out.writes).toEqual([{ table: "plane_effects", op: "offer", effect: out.effects[0], at: 2_000 }]);
  });

  it("orphaned_child: a seal with a pull request, a live runner, or no pushed branch is a no-op — the watch's precondition is not met", () => {
    const base = { kind: "child_sealed" as const, at: 2_000, runId: "run-x", repo: "acme/api", branch: "b" };
    expect(decide(emptyPlaneState(), { ...base, runnerLive: true }).effects).toEqual([]);
    expect(decide(emptyPlaneState(), { ...base, runnerLive: false, prNumber: 9 }).effects).toEqual([]);
    expect(decide(emptyPlaneState(), { ...base, branch: undefined, runnerLive: false }).effects).toEqual([]);
  });

  it("orphaned_child: a pushed branch whose repository the seal could not name degrades to a finding carrying the watch and the timeline, never a guessed move", () => {
    const out = decide(emptyPlaneState(), {
      kind: "child_sealed",
      at: 3_000,
      runId: "run-dead",
      runnerLive: false,
      branch: "plan/x/u1",
    });
    expect(out.effects).toEqual([]);
    expect(out.writes).toHaveLength(1);
    const write = out.writes[0]!;
    if (write.table !== "plane_findings") throw new Error("expected a finding write");
    expect(write.finding.watch).toBe("orphaned_child");
    expect(write.finding.subject).toBe("run-dead");
    expect(write.finding.timeline).toHaveLength(1);
    expect(write.finding.timeline[0]!.what).toContain("plan/x/u1");
  });

  it("dirty_at_approval: mergeableState `dirty` on an approved head opens a rebase round briefed to rebase onto the base and push, keyed by the head; any other state is a no-op", () => {
    const dirty = decide(emptyPlaneState(), {
      kind: "approval",
      at: 4_000,
      repo: "acme/api",
      number: 12,
      headSha: "abc123",
      mergeableState: "dirty",
    });
    expect(dirty.effects).toEqual([
      {
        id: "rebase_round:acme/api#12@abc123",
        kind: "rebase_round",
        repo: "acme/api",
        number: 12,
        headSha: "abc123",
        brief: "rebase onto the base and push",
      },
    ]);
    for (const mergeableState of ["clean", "unknown", undefined])
      expect(
        decide(emptyPlaneState(), {
          kind: "approval",
          at: 4_000,
          repo: "acme/api",
          number: 12,
          headSha: "abc123",
          mergeableState,
        }).effects,
      ).toEqual([]);
  });

  it("runner_gone: an errored or terminated instance with units unfinished emits one `reissue` keyed by the attempt number — the same status read twice is the same effect id", () => {
    for (const status of ["errored", "terminated"]) {
      const out = decide(emptyPlaneState(), {
        kind: "runner_status",
        at: 5_000,
        instanceId: "plan-x",
        status,
        unfinishedUnits: ["U12", "U13"],
        attempt: 2,
      });
      expect(out.effects).toEqual([
        { id: "reissue:plan-x#2", kind: "reissue", instanceId: "plan-x", attempt: 2, units: ["U12", "U13"] },
      ]);
    }
  });

  it("runner_gone: the hosting deadline passed on an instance not `waiting` reissues; a `waiting` instance at its deadline does nothing (an idle unit is alive), and a plan with nothing unfinished has no move — the precondition is gone", () => {
    const overdue = decide(emptyPlaneState(), {
      kind: "runner_status",
      at: 6_000,
      instanceId: "plan-x",
      status: "running",
      unfinishedUnits: ["U12"],
      attempt: 1,
      deadlinePassed: true,
    });
    expect(overdue.effects.map((e) => e.kind)).toEqual(["reissue"]);
    const waiting = decide(emptyPlaneState(), {
      kind: "runner_status",
      at: 6_000,
      instanceId: "plan-x",
      status: "waiting",
      unfinishedUnits: ["U12"],
      attempt: 1,
      deadlinePassed: true,
    });
    expect(waiting.effects).toEqual([]);
    const done = decide(emptyPlaneState(), {
      kind: "runner_status",
      at: 6_000,
      instanceId: "plan-x",
      status: "errored",
      unfinishedUnits: [],
      attempt: 1,
    });
    expect(done.effects).toEqual([]);
    expect(
      decide(emptyPlaneState(), {
        kind: "runner_status",
        at: 6_000,
        instanceId: "plan-x",
        status: "running",
        unfinishedUnits: ["U12"],
        attempt: 1,
      }).effects,
    ).toEqual([]);
  });
});
