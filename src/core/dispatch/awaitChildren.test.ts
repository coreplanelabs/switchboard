import { describe, expect, it } from "vitest";
import { RUN_DEADLINE_RESERVE_MS } from "../../execution/bashTimeout.js";
import { RunRegistry } from "../runRegistry.js";
import { RunControl } from "../runRegistry/runControl.js";
import { FollowUpInbox } from "../threadAdmission.js";
import {
  AWAIT_POLL_MS,
  budgetEndOf,
  ChildrenWatch,
  decideWait,
  waitCapabilityFor,
  type ChildState,
  type WaitInputs,
} from "./awaitChildren.js";

// Feature: docs/reference/specs/agent-conductor.md item 8 — the pure wait
// decision behind `await_runs`: which children are terminal, and what ends
// the wait — every child ended, the parent's remaining budget less the
// wrap-up reserve, the caller's own timeout, a stop, a follow-up landing in
// the parent's inbox — in that order of precedence; a terminal state, once
// seen, never changes. The tool that drives it (the reads, the report) is
// proven in `src/tools/runs.test.ts`.

const NOW = 1_000_000;
const running: ChildState = { kind: "running" };
const ended = (status: "completed" | "failed" | "interrupted" = "completed"): ChildState => ({ kind: "ended", status });

function inputs(over: Partial<WaitInputs> = {}): WaitInputs {
  return {
    children: new Map([
      ["a", running],
      ["b", running],
    ]),
    now: NOW,
    budgetEndsAt: NOW + 10 * 60_000,
    stop: undefined,
    followUpPending: false,
    ...over,
  };
}

describe("ChildrenWatch — the children's states as the wait accumulates them", () => {
  it("starts every named child running, records what a read found, and a terminal state never changes: a second end frame, or a read that finds nothing after one that found a record, is ignored", () => {
    const w = new ChildrenWatch(["a", "b"]);
    expect(w.pending()).toEqual(["a", "b"]);
    expect(w.allEnded).toBe(false);
    expect(w.observe("a", { kind: "running", activity: "reading" })).toBe(true);
    expect(w.get("a")).toEqual({ kind: "running", activity: "reading" });
    expect(w.observe("a", ended("completed"))).toBe(true);
    expect(w.pending()).toEqual(["b"]);
    // A duplicate end frame changes nothing — neither the status nor the count.
    expect(w.observe("a", ended("failed"))).toBe(false);
    expect(w.observe("a", { kind: "not_found" })).toBe(false);
    expect(w.observe("a", running)).toBe(false);
    expect(w.get("a")).toEqual(ended("completed"));
    // `not_found` is terminal too: the wait goes on for the rest.
    expect(w.observe("b", { kind: "not_found" })).toBe(true);
    expect(w.pending()).toEqual([]);
    expect(w.allEnded).toBe(true);
    expect([...w.snapshot().keys()]).toEqual(["a", "b"]);
  });

  it("an id the watch was not built with is not a child of the wait: the observation is dropped", () => {
    const w = new ChildrenWatch(["a"]);
    expect(w.observe("zzz", ended())).toBe(false);
    expect(w.get("zzz")).toBeUndefined();
    expect([...w.snapshot().keys()]).toEqual(["a"]);
  });
});

describe("decideWait — what ends the wait", () => {
  it("every child ended (whatever the status, not_found included) ends the wait as all_ended, ahead of anything else", () => {
    const children = new Map<string, ChildState>([
      ["a", ended("completed")],
      ["b", ended("interrupted")],
      ["c", { kind: "not_found" }],
    ]);
    expect(decideWait(inputs({ children }))).toEqual({ kind: "end", why: "all_ended" });
    // Even with a stop or a follow-up pending: the wait is complete, and says so.
    expect(decideWait(inputs({ children, stop: "hard", followUpPending: true, budgetEndsAt: NOW - 1 }))).toEqual({
      kind: "end",
      why: "all_ended",
    });
  });

  it("a stop ends it at once, soft or hard, before the budget is even read", () => {
    expect(decideWait(inputs({ stop: "soft" }))).toEqual({ kind: "end", why: "stop" });
    expect(decideWait(inputs({ stop: "hard", followUpPending: true }))).toEqual({ kind: "end", why: "stop" });
  });

  it("a follow-up landing in the parent's own inbox ends it, so the steer is heard at the parent's next step", () => {
    expect(decideWait(inputs({ followUpPending: true }))).toEqual({ kind: "end", why: "follow_up" });
  });

  it("the parent's remaining budget less the wrap-up reserve ends it as budget, naming nothing itself — the report names the children still live", () => {
    expect(decideWait(inputs({ budgetEndsAt: NOW }))).toEqual({ kind: "end", why: "budget" });
    expect(decideWait(inputs({ budgetEndsAt: NOW - 5_000 }))).toEqual({ kind: "end", why: "budget" });
    expect(decideWait(inputs({ budgetEndsAt: NOW + 1 })).kind).toBe("wait");
    // The budget's edge is the deadline less the same reserve the bash tool keeps back.
    expect(budgetEndOf(NOW, 10 * 60_000)).toBe(NOW + 10 * 60_000 - RUN_DEADLINE_RESERVE_MS);
    expect(budgetEndOf(NOW, Number.POSITIVE_INFINITY)).toBe(Number.POSITIVE_INFINITY);
  });

  it("the caller's own timeout ends it as timeout; when both the budget and the timeout have passed, the budget is named (the stronger fact)", () => {
    expect(decideWait(inputs({ timeoutAt: NOW }))).toEqual({ kind: "end", why: "timeout" });
    expect(decideWait(inputs({ timeoutAt: NOW, budgetEndsAt: NOW }))).toEqual({ kind: "end", why: "budget" });
    expect(decideWait(inputs({ timeoutAt: NOW + 1 })).kind).toBe("wait");
  });

  it("otherwise the wait goes on until the earlier of the budget's edge and the timeout — Infinity when nothing bounds it", () => {
    expect(decideWait(inputs({ budgetEndsAt: NOW + 60_000, timeoutAt: NOW + 30_000 }))).toEqual({
      kind: "wait",
      until: NOW + 30_000,
    });
    expect(decideWait(inputs({ budgetEndsAt: NOW + 60_000 }))).toEqual({ kind: "wait", until: NOW + 60_000 });
    expect(decideWait(inputs({ budgetEndsAt: Number.POSITIVE_INFINITY }))).toEqual({
      kind: "wait",
      until: Number.POSITIVE_INFINITY,
    });
    expect(AWAIT_POLL_MS).toBeGreaterThan(0);
  });
});

describe("waitCapabilityFor — what a waiting tool watches", () => {
  it("reads the run's own stop control and inbox, and wakes on a watched child's finish, seal or removal in the registry — never on another run's, and never on a mere event of the child's", () => {
    let at = NOW;
    let n = 0;
    const registry = new RunRegistry({ genId: () => `run-${++n}`, genToken: () => "tok", now: () => at });
    const control = new RunControl();
    const inbox = new FollowUpInbox();
    const slept: number[] = [];
    const cap = waitCapabilityFor({
      registry,
      control,
      inbox,
      clock: () => at,
      sleep: async (ms) => {
        slept.push(ms);
        at += ms;
      },
    });
    expect(cap.stopRequested()).toBeUndefined();
    expect(cap.followUpsPending()).toBe(0);
    control.requestStop("soft");
    inbox.push({ text: "also", userId: "slack:U", at: NOW });
    expect(cap.stopRequested()).toBe("soft");
    expect(cap.followUpsPending()).toBe(1);
    expect(cap.now()).toBe(NOW);

    const child = registry.create("child", { channelId: "slack:C", userId: "slack:U", threadKey: "slack:C:1" });
    const other = registry.create("other", { channelId: "slack:C", userId: "slack:U", threadKey: "slack:C:2" });
    let wakes = 0;
    const stop = cap.watch(new Set([child.id]), () => void wakes++);
    registry.publish(child.id, { type: "tool_call", tool: "web_fetch", summary: "GET x" });
    expect(wakes).toBe(0); // activity is not an end
    registry.finish(other.id, "completed");
    registry.seal(other.id, { replyOk: true });
    expect(wakes).toBe(0); // another run's end is not this child's
    registry.finish(child.id, "completed");
    expect(wakes).toBe(1); // the finished frame
    registry.seal(child.id, { replyOk: true });
    expect(wakes).toBe(2); // the end frame
    stop();
    registry.discard(child.id); // a no-op on a finished run, and the watch is off anyway
    expect(wakes).toBe(2);

    // A child discarded before it started (its row gone, no record) wakes the wait too.
    const gone = registry.create("gone", { channelId: "slack:C", userId: "slack:U", threadKey: "slack:C:3" });
    const stop2 = cap.watch(new Set([gone.id]), () => void wakes++);
    registry.discard(gone.id);
    expect(wakes).toBe(3);
    stop2();
  });

  it("a watched child that already ended wakes the wait at once (the feed replays the active set), so nothing waits on an end that has passed", () => {
    const registry = new RunRegistry({ genId: () => "run-done", genToken: () => "tok", now: () => NOW });
    const child = registry.create("child", { channelId: "slack:C", userId: "slack:U", threadKey: "slack:C:1" });
    registry.finish(child.id, "completed");
    const cap = waitCapabilityFor({
      registry,
      control: new RunControl(),
      inbox: new FollowUpInbox(),
      clock: () => NOW,
    });
    let wakes = 0;
    const stop = cap.watch(new Set([child.id]), () => void wakes++);
    expect(wakes).toBe(1);
    stop();
  });

  it("the default sleep resolves after its delay and at once on an aborted signal, never rejecting", async () => {
    const cap = waitCapabilityFor({
      registry: new RunRegistry(),
      control: new RunControl(),
      inbox: new FollowUpInbox(),
      clock: () => NOW,
    });
    const aborted = new AbortController();
    aborted.abort();
    await expect(cap.sleep(60_000, aborted.signal)).resolves.toBeUndefined();
    const controller = new AbortController();
    const sleeping = cap.sleep(60_000, controller.signal);
    controller.abort();
    await expect(sleeping).resolves.toBeUndefined();
    await expect(cap.sleep(1)).resolves.toBeUndefined();
  });
});
