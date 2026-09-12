import { describe, expect, it } from "vitest";
import { channelOf, startRequestRoot } from "../requestTrace.js";
import { RunControl } from "../runRegistry/runControl.js";
import { ThreadAdmission } from "../threadAdmission.js";
import type { ChannelIO } from "../types.js";
import type { DispatchFollowUp } from "./admission.js";
import {
  FOLLOW_UP_DROPPED_BY_STOP,
  prepareFreshTurn,
  settleThread,
  tellDropped,
  type PersonFollowUp,
} from "./settle.js";

// Feature: docs/reference/specs/thread-admission.md item 4 — the settle stage's
// own contract: the slot is freed, a quiet thread settles quiet, a stopped run's
// follow-ups are dropped with the note, a run that ended by itself hands them on
// as one fresh turn pinned to its agent. The end-to-end behavior (the fresh turn
// running, the root order) is proven through `dispatch()` in
// `src/core/dispatcher.test.ts` (`thread admission`, `no gaps`).

const NOW = 10_000;
const THREAD = "slack:CX:1.0";
const msg = { channelId: "slack:CX", userId: "slack:UX", threadKey: THREAD, text: "hello" };

function io(replies: string[]): ChannelIO {
  return {
    reply: async (t) => void replies.push(t),
    status: async () => ({ update: () => {}, done: async () => {} }),
    history: async () => [],
  };
}

function followUp(text: string, at: number, replies: string[], user = "slack:UY"): PersonFollowUp {
  return { text, userId: user, at, msg: { ...msg, userId: user, text, ts: `${at}` } as never, io: io(replies) };
}

function setup() {
  const admission = new ThreadAdmission<DispatchFollowUp>();
  const claim = admission.claim(THREAD, { agent: "coding", now: NOW });
  const trace = startRequestRoot({ clock: () => NOW }, { channel: channelOf(msg.channelId), receivedAt: NOW });
  return { admission, admitted: claim.live, root: trace.root };
}

describe("settleThread — the thread when the request is over", () => {
  it("quiet: nothing unconsumed frees the slot and reports the stop mode (none here); a later claim starts fresh", async () => {
    const s = setup();
    const out = settleThread(
      { admission: s.admission },
      { msg, admitted: s.admitted, runLoopStarted: true, control: new RunControl() },
    );
    expect(out).toEqual({ kind: "quiet", stopMode: undefined });
    expect(s.admission.get(THREAD)).toBeUndefined();
    expect(s.admission.claim(THREAD, { agent: "general" }).kind).toBe("start");
  });

  it("no slot (admission never granted one): quiet, nothing released", async () => {
    const s = setup();
    const out = settleThread(
      { admission: s.admission },
      { msg, admitted: undefined, runLoopStarted: false, control: undefined },
    );
    expect(out).toEqual({ kind: "quiet", stopMode: undefined });
    expect(s.admission.get(THREAD)).toBe(s.admitted); // another dispatch's slot is untouched
  });

  it("dropped: after an operator stop the unconsumed follow-ups are not run — each sender gets the note, the stop mode is reported", async () => {
    const s = setup();
    const a: string[] = [];
    const b: string[] = [];
    s.admitted.inbox.push(followUp("and this", NOW + 1, a));
    s.admitted.inbox.push(followUp("and that", NOW + 2, b));
    const control = new RunControl();
    control.requestStop("soft");
    const out = settleThread({ admission: s.admission }, { msg, admitted: s.admitted, runLoopStarted: true, control });
    expect(out).toMatchObject({ kind: "dropped", stopMode: "soft" });
    expect((out as { pending: DispatchFollowUp[] }).pending.map((p) => p.text)).toEqual(["and this", "and that"]);
    expect(s.admission.get(THREAD)).toBeUndefined();
    // Nothing is sent until the dispatch asks — the slot is already free by then.
    expect(a).toEqual([]);
    await tellDropped(s.root, (out as { pending: PersonFollowUp[] }).pending);
    expect(a).toEqual([FOLLOW_UP_DROPPED_BY_STOP]);
    expect(b).toEqual([FOLLOW_UP_DROPPED_BY_STOP]);
  });

  // docs/reference/specs/thread-admission.md item 7: a steer a run sent is a
  // program's message — unconsumed at the child's end it is neither run fresh
  // nor answered; the parent reads the child's end through its own tools.
  it("a steer a run sent (`from`, no handle) is never handed on nor told: alone it settles quiet; beside a person's follow-up only the person's is handed on or dropped", async () => {
    const s = setup();
    const fromRun: DispatchFollowUp = {
      text: "narrow it",
      userId: "slack:UX",
      at: NOW + 1,
      from: { runId: "run-parent" },
      msg: { ...msg, text: "narrow it" } as never,
    };
    s.admitted.inbox.push(fromRun);
    const alone = settleThread(
      { admission: s.admission },
      { msg, admitted: s.admitted, runLoopStarted: true, control: new RunControl() },
    );
    expect(alone).toEqual({ kind: "quiet", stopMode: undefined });
    expect(s.admission.get(THREAD)).toBeUndefined();

    const t = setup();
    const replies: string[] = [];
    t.admitted.inbox.push(fromRun);
    t.admitted.inbox.push(followUp("and this", NOW + 2, replies));
    const handed = settleThread(
      { admission: t.admission },
      { msg, admitted: t.admitted, runLoopStarted: true, control: new RunControl() },
    );
    expect(handed).toMatchObject({ kind: "handed-on", agent: "coding" });
    expect((handed as { pending: DispatchFollowUp[] }).pending.map((p) => p.text)).toEqual(["and this"]);

    const u = setup();
    const told: string[] = [];
    u.admitted.inbox.push(fromRun);
    u.admitted.inbox.push(followUp("and that", NOW + 2, told));
    const control = new RunControl();
    control.requestStop("soft");
    const dropped = settleThread(
      { admission: u.admission },
      { msg, admitted: u.admitted, runLoopStarted: true, control },
    );
    expect(dropped).toMatchObject({ kind: "dropped", stopMode: "soft" });
    expect((dropped as { pending: DispatchFollowUp[] }).pending.map((p) => p.text)).toEqual(["and that"]);
    await tellDropped(u.root, (dropped as { pending: PersonFollowUp[] }).pending);
    expect(told).toEqual([FOLLOW_UP_DROPPED_BY_STOP]);
  });

  it("a stop relayed before the run loop had the run stopped nothing: the follow-ups are handed on, pinned to the slot's agent", async () => {
    const s = setup();
    const replies: string[] = [];
    s.admitted.inbox.push(followUp("and this", NOW + 1, replies));
    const control = new RunControl();
    control.requestStop("hard");
    const out = settleThread({ admission: s.admission }, { msg, admitted: s.admitted, runLoopStarted: false, control });
    expect(out).toMatchObject({ kind: "handed-on", agent: "coding" });
    expect((out as { pending: DispatchFollowUp[] }).pending.map((p) => p.text)).toEqual(["and this"]);
    expect(replies).toEqual([]);
  });
});

describe("prepareFreshTurn — the one request the unconsumed follow-ups run as", () => {
  it("merges the follow-ups into the most recent sender's message and handle, pins the agent, stamps receivedAt now and the wait since the earliest, and drops the platform stamp", () => {
    const a: string[] = [];
    const b: string[] = [];
    const pending = [followUp("first", NOW - 5_000, a, "slack:UA"), followUp("second", NOW - 1_000, b, "slack:UB")];
    const fresh = prepareFreshTurn({ clock: () => NOW }, { agent: "coding", pending, clock: () => NOW });
    expect(fresh.msg).toMatchObject({
      channelId: "slack:CX",
      threadKey: THREAD,
      userId: "slack:UB",
      text: "agent:coding first\n\nsecond",
      receivedAt: NOW,
      originAt: undefined,
    });
    expect(fresh.io).toBe(pending[1].io);
    expect(fresh.opts.queuedBehindMs).toBe(5_000);
    expect(fresh.opts.trace.receivedAt).toBe(NOW);
    expect(fresh.opts.trace.root.name).toBe("request");
  });
});
