import { describe, expect, it } from "vitest";
import { liveStateWords, type PlaneEndingCause } from "./plane/decide.js";
import {
  LIVE_STATE_DETAIL_MAX,
  RUN_LIVE_STATE_NAMES,
  assignRunLiveState,
  foldRunLiveState,
  safeLiveStateDetail,
  type RunLiveState,
  type RunStateEvent,
} from "./runLiveState.js";

const cause: PlaneEndingCause = "completed";

function state(state: Exclude<RunLiveState["state"], "ended">, since = 100, bound = 1_000): RunLiveState {
  return { state, since, bound };
}

describe("run live state", () => {
  it("defines one closed nine-member state table and requires an absolute bound for every live member", () => {
    expect(RUN_LIVE_STATE_NAMES).toEqual([
      "admitted",
      "waiting_deploy",
      "waiting_repository",
      "falling_back",
      "preparing",
      "working",
      "waiting_provider",
      "wrapping_up",
      "ended",
    ]);
    for (const name of RUN_LIVE_STATE_NAMES.filter((name) => name !== "ended")) {
      const current = name === "admitted" ? undefined : state(name);
      const currentSeq = current ? 1 : 0;
      const result = assignRunLiveState(current, currentSeq, {
        expectedSeq: currentSeq,
        at: 100,
        state: name,
        bound: 1_000,
      });
      expect(result.ok, name).toBe(true);
      expect(result.ok && result.liveState.bound, name).toBe(1_000);
    }
    expect(assignRunLiveState(state("working"), 1, { expectedSeq: 1, at: 100, state: "working" })).toEqual({
      ok: false,
      reason: "bound-required",
    });
    expect(assignRunLiveState(undefined, 0, { expectedSeq: 0, at: 100, state: "working", bound: 1_000 })).toEqual({
      ok: false,
      reason: "invalid-transition",
    });
  });

  it("keeps ended terminal and ties its boundary to an existing ending cause", () => {
    expect(
      assignRunLiveState(state("wrapping_up"), 8, { expectedSeq: 8, at: 900, state: "ended", cause }),
    ).toMatchObject({
      ok: true,
      liveState: { state: "ended", since: 900 },
      event: { type: "run_state", state: "ended", cause: "completed" },
    });
    expect(
      assignRunLiveState(state("ended" as never), 9, { expectedSeq: 9, at: 901, state: "working", bound: 1_000 }),
    ).toEqual({
      ok: false,
      reason: "terminal",
    });
    expect(assignRunLiveState(state("wrapping_up"), 8, { expectedSeq: 8, at: 900, state: "ended" })).toEqual({
      ok: false,
      reason: "cause-required",
    });
  });

  it("allows re-attach and provider recovery cycles while refusing unrelated jumps", () => {
    expect(
      assignRunLiveState(state("waiting_repository"), 3, { expectedSeq: 3, at: 200, state: "preparing", bound: 800 })
        .ok,
    ).toBe(true);
    expect(
      assignRunLiveState(state("working"), 4, { expectedSeq: 4, at: 300, state: "waiting_provider", bound: 900 }).ok,
    ).toBe(true);
    expect(
      assignRunLiveState(state("waiting_provider"), 5, { expectedSeq: 5, at: 400, state: "working", bound: 950 }).ok,
    ).toBe(true);
    expect(
      assignRunLiveState(state("admitted"), 1, { expectedSeq: 1, at: 120, state: "waiting_provider", bound: 900 }),
    ).toEqual({
      ok: false,
      reason: "invalid-transition",
    });
  });

  it("orders drain wait to repository wake to fallback and refuses a late drain observation", () => {
    const admitted = assignRunLiveState(undefined, 0, {
      expectedSeq: 0,
      at: 100,
      state: "admitted",
      bound: 1_000,
    });
    if (!admitted.ok) throw new Error(admitted.reason);
    const drain = assignRunLiveState(admitted.liveState, 1, {
      expectedSeq: 1,
      at: 200,
      state: "waiting_deploy",
      bound: 800,
    });
    if (!drain.ok) throw new Error(drain.reason);
    const wake = assignRunLiveState(drain.liveState, 2, {
      expectedSeq: 2,
      at: 300,
      state: "waiting_repository",
      bound: 850,
    });
    if (!wake.ok) throw new Error(wake.reason);
    const fallback = assignRunLiveState(wake.liveState, 3, {
      expectedSeq: 3,
      at: 400,
      state: "falling_back",
      bound: 900,
    });
    if (!fallback.ok) throw new Error(fallback.reason);
    expect([admitted, drain, wake, fallback].map((result) => result.ok && result.liveState.state)).toEqual([
      "admitted",
      "waiting_deploy",
      "waiting_repository",
      "falling_back",
    ]);
    expect(
      assignRunLiveState(fallback.liveState, 4, {
        expectedSeq: 2,
        at: 450,
        state: "waiting_deploy",
        bound: 950,
      }),
    ).toEqual({ ok: false, reason: "stale-sequence" });
  });

  it("preserves since on a same-state refresh and refuses a stale expected sequence", () => {
    const current: RunLiveState = { state: "working", since: 100, bound: 500, detail: "model turn" };
    expect(
      assignRunLiveState(current, 7, {
        expectedSeq: 7,
        at: 300,
        state: "working",
        bound: 900,
        detail: "running a bounded tool",
      }),
    ).toEqual({
      ok: true,
      liveState: { state: "working", since: 100, bound: 900, detail: "running a bounded tool" },
    });
    expect(assignRunLiveState(current, 7, { expectedSeq: 6, at: 300, state: "working", bound: 900 })).toEqual({
      ok: false,
      reason: "stale-sequence",
    });
  });

  it("refreshes a bounded tool without another boundary and replay restores the model-turn projection", () => {
    const events = [
      { type: "lease", endsAt: 1_000, seq: 1, at: 100 },
      { type: "run_state", state: "working" as const, since: 100, bound: 1_000, detail: "model turn", seq: 2, at: 100 },
      { type: "tool_call", boundMs: 250, seq: 3, at: 200 },
      { type: "tool_result", seq: 4, at: 300 },
    ];
    expect(foldRunLiveState(events.slice(0, 3))).toEqual({
      liveState: { state: "working", since: 100, bound: 450, detail: "running a tool" },
      liveStateSeq: 3,
    });
    expect(foldRunLiveState(events)).toEqual({
      liveState: { state: "working", since: 100, bound: 1_000, detail: "model turn" },
      liveStateSeq: 4,
    });
    expect(events.filter((event) => event.type === "run_state")).toHaveLength(1);
  });

  it("folds the highest event sequence over a stale materialized cache", () => {
    const events: RunStateEvent[] = [
      { type: "run_state", state: "working", since: 100, bound: 500, seq: 4, at: 100 },
      { type: "run_state", state: "waiting_provider", since: 200, bound: 800, seq: 6, at: 200 },
    ];
    expect(foldRunLiveState(events, { liveState: state("working"), liveStateSeq: 5 })).toEqual({
      liveState: { state: "waiting_provider", since: 200, bound: 800 },
      liveStateSeq: 6,
    });
  });

  it("gives every state token one wording without accepting raw mechanism detail", () => {
    expect(RUN_LIVE_STATE_NAMES.map(liveStateWords)).toEqual([
      "admitted",
      "waiting for the current deploy",
      "waiting for the repository container",
      "switching to a fallback workspace",
      "preparing the workspace",
      "working",
      "waiting for the model provider",
      "wrapping up",
      "ended",
    ]);
    expect(liveStateWords).not.toHaveProperty("image-stale");
  });

  it("caps safe details and drops internal codes and gateway bodies", () => {
    expect(safeLiveStateDetail("x".repeat(LIVE_STATE_DETAIL_MAX + 20))).toHaveLength(LIVE_STATE_DETAIL_MAX);
    for (const raw of ["image-stale", "attach-failed", "parked-provider", "<html>502 bad gateway</html>"]) {
      expect(safeLiveStateDetail(raw), raw).toBeUndefined();
    }
  });
});
