import { describe, expect, it } from "vitest";
import {
  decide,
  emptyPlaneState,
  planeAskAnswerOf,
  planeAskWordOf,
  type PlaneAskEvent,
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
    expect(out.effects.map((e) => e.runId)).toEqual(["run-a"]);
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
    expect(one.effects.map((e) => e.runId)).toEqual(["run-b"]);
    const two = decide(one.state, { kind: "sealed", at: 4_000, threadKey: "slack:C1:1.1" });
    expect(two.effects.map((e) => e.runId)).toEqual(["run-a"]);
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
    expect(lifted.effects.map((e) => e.runId)).toEqual(["run-a"]);
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
    expect(landed.effects.map((e) => e.runId)).toEqual(["run-a"]);
    expect(landed.state.queue.find((r) => r.runId === "run-a")!.state).toBe("admitted");
  });

  it("a reserved thread queues a second ask until the seal deletes the reservation and admits it", () => {
    const first = decide(emptyPlaneState(), ask());
    const second = decide(first.state, ask({ runId: "run-b", at: 2_000 }));
    expect(planeAskAnswerOf(second, "run-b")).toMatchObject({ kind: "queued" });
    const sealed = decide(second.state, { kind: "sealed", at: 3_000, threadKey: "slack:C1:1.1" });
    expect(sealed.writes).toContainEqual({ table: "plane_reservations", op: "del", key: "slack:C1:1.1" });
    expect(sealed.effects.map((e) => e.runId)).toEqual(["run-b"]);
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
