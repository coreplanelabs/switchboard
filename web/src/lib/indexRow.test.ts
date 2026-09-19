import { describe, expect, it } from "vitest";
import {
  agentHue,
  dotTip,
  elapsedText,
  expiresAt,
  feedAction,
  mergeRow,
  repoOf,
  runHref,
  safeSourceUrl,
  sourceTip,
  statusDot,
  statusLabel,
  statusWord,
  stopHref,
  stopLabel,
  surfaceOf,
  whenTip,
  type IndexRow,
  delivering,
  countTip,
  countText,
  PROVISIONAL_LABEL,
  rowPace,
  rowStalled,
  rowBound,
  paceTip,
  groupRuns,
} from "./indexRow";
import { formatLocalIso } from "./format";

// The row model, ported from the old isomorphic indexRowRenderer — the same
// vocabulary and rules, as pure functions.

const base: IndexRow = {
  id: "run-1",
  label: 'coding · acme/web · "fix the build"',
  channelId: "slack:C1",
  userId: "slack:UACME1",
  threadKey: "slack:C1:1.0",
  finished: false,
  startedAt: 1_000_000,
  eventCount: 4,
};
const row = (over: Partial<IndexRow> = {}): IndexRow => ({ ...base, ...over });
const finished = (status: IndexRow["status"], over: Partial<IndexRow> = {}) =>
  row({ finished: true, finishedAt: 1_000_000 + 63_000, sealedAt: 1_000_000 + 65_000, status, ...over });

describe("status vocabulary", () => {
  it("shows display words, not the enum: succeeded / failed / killed / stopped early", () => {
    expect(statusLabel("completed")).toBe("succeeded");
    expect(statusLabel("failed")).toBe("failed");
    expect(statusLabel("stopped_hard")).toBe("killed");
    expect(statusLabel("stopped_soft")).toBe("stopped early");
    expect(statusLabel("interrupted")).toBe("interrupted"); // already a display word, passes through
  });

  it("statusWord: live, else the status word, else finished", () => {
    expect(statusWord(row())).toBe("live");
    expect(statusWord(finished("completed"))).toBe("succeeded");
    expect(statusWord(row({ finished: true }))).toBe("finished");
  });

  it("the count cell prints the content-event count when the row carries it, else the published total, always as `events`", () => {
    expect(countText({ eventCount: 12, stepCount: 8 })).toBe("8 events");
    expect(countText({ eventCount: 12 })).toBe("12 events");
    expect(countText({ eventCount: 3, stepCount: 1 })).toBe("1 event");
    expect(countTip({ stepCount: 8 })).toBe("content events; span records excluded");
    expect(countTip({})).toBe("events published, span records included"); // a row without stepCount counts them
  });

  it("a finished row with no seal yet and no record is `delivering`: amber, whatever its status, and its tip says so; a seal or a persisted record ends it", () => {
    const unsealed = row({ finished: true, finishedAt: 1_000_000 + 63_000, status: "completed" });
    expect(delivering(unsealed)).toBe(true);
    expect(statusDot(unsealed)).toBe("amber");
    expect(dotTip(unsealed)).toBe("succeeded in 1m 03s · delivering the reply");
    const failedUnsealed = row({
      finished: true,
      finishedAt: 1_000_000 + 63_000,
      status: "failed",
      activity: "⚠️ boom",
    });
    expect(statusDot(failedUnsealed)).toBe("amber"); // the reply (the failure text) is still on its way
    expect(dotTip(failedUnsealed)).toBe("failed in 1m 03s · delivering the reply\n⚠️ boom");
    expect(delivering(finished("completed"))).toBe(false); // sealed
    expect(delivering(row({ finished: true, finishedAt: 1_000_000 + 63_000, persisted: true }))).toBe(false); // written after its seal
    expect(statusDot(row({ finished: true, finishedAt: 1_000_000 + 63_000, persisted: true, status: "failed" }))).toBe(
      "red",
    );
    expect(delivering(row())).toBe(false); // live
  });

  it("dot tone: green live, red failed/killed/interrupted, amber stopped early, grey succeeded", () => {
    expect(statusDot(row())).toBe("green");
    expect(statusDot(finished("failed"))).toBe("red");
    expect(statusDot(finished("stopped_hard"))).toBe("red");
    expect(statusDot(finished("interrupted"))).toBe("red"); // cut down before finish
    expect(statusDot(finished("stopped_soft"))).toBe("amber");
    expect(statusDot(finished("completed"))).toBe("grey");
  });

  it("provisional: a tombstone-first record still in its window renders as 'unfinished — no finish recorded', amber dot; a real `interrupted` record (no provisional flag) is unaffected", () => {
    // The provisional tombstone: the start-of-run interrupted marker (run-history item 27)
    const provisional = finished("interrupted", { provisional: true });
    expect(statusWord(provisional)).toBe(PROVISIONAL_LABEL);
    expect(statusDot(provisional)).toBe("amber"); // not red — the run may still be live
    expect(dotTip(provisional)).toContain(PROVISIONAL_LABEL);
    // A real interrupted record (no provisional flag) is unchanged
    const realInterrupted = finished("interrupted");
    expect(statusWord(realInterrupted)).toBe("interrupted");
    expect(statusDot(realInterrupted)).toBe("red");
  });

  it("stop badge: stopping (mode) in flight, the outcome word once stopped", () => {
    expect(stopLabel({ state: "stopping", mode: "soft" })).toBe("stopping (soft)");
    expect(stopLabel({ state: "stopped", mode: "hard" })).toBe("killed");
    expect(stopLabel({ state: "stopped", mode: "soft" })).toBe("stopped early");
  });
});

describe("hrefs", () => {
  it("a live row links with its capability token; a finished row never does, even while the registry still holds one", () => {
    expect(runHref(row({ token: "tok-1" }))).toBe("/runs/run-1?t=tok-1");
    expect(runHref(row({ token: "tok-1", finished: true }))).toBe("/runs/run-1");
    expect(runHref(row())).toBe("/runs/run-1");
  });

  it("percent-encodes ids and tokens", () => {
    expect(runHref(row({ id: "a/b?x", token: "t&1" }))).toBe("/runs/a%2Fb%3Fx?t=t%261");
    expect(stopHref(row({ token: "t&1" }), "soft")).toBe("/runs/run-1/stop?t=t%261&mode=soft");
  });
});

describe("agent hue allow-list", () => {
  it("only the four built-in agents get a hue; anything else — hostile names included — the neutral chip", () => {
    expect(agentHue("coding")).toBe("coding");
    expect(agentHue("review")).toBe("review");
    expect(agentHue("research")).toBe("research");
    expect(agentHue("general")).toBe("general");
    expect(agentHue("triage")).toBe("other");
    expect(agentHue('evil"><b')).toBe("other");
  });
});

describe("stopwatch", () => {
  it("live = since start from the clock, finished = start to finish fixed, no clock → empty", () => {
    expect(elapsedText(row(), 1_000_000 + 252_000)).toBe("4m 12s");
    expect(elapsedText(row({ finished: true, finishedAt: 1_000_000 + 3_780_000 }), 99)).toBe("1h 03m");
    expect(elapsedText(row(), undefined)).toBe("");
  });

  it("receivedAt opens the window when present (docs/reference/specs/tracing.md): live and finished rows both measure from it; a tombstone is empty", () => {
    expect(elapsedText(row({ receivedAt: 1_000_000 - 20_000 }), 1_000_000 + 40_000)).toBe("1m 00s");
    expect(
      elapsedText(row({ finished: true, receivedAt: 1_000_000 - 20_000, finishedAt: 1_000_000 + 40_000 }), 99),
    ).toBe("1m 00s");
    expect(elapsedText(row({ finished: true }), 99)).toBe("");
  });
});

describe("tooltips", () => {
  it("the dot's tip: a live run's activity (or starting…); a finished run's outcome + duration, plus the last activity when it did not complete", () => {
    expect(dotTip(row({ activity: "$ npm test" }))).toBe("now: $ npm test");
    expect(dotTip(row())).toBe("starting…");
    expect(dotTip(finished("failed", { activity: "⚠️ resident not onboarded: acme/web" }))).toBe(
      "failed in 1m 03s\n⚠️ resident not onboarded: acme/web",
    );
    expect(dotTip(finished("stopped_hard", { activity: "$ npm test" }))).toBe("killed in 1m 03s\n$ npm test");
    expect(dotTip(finished("completed", { activity: "done" }))).toBe("succeeded in 1m 03s");
  });

  it("the tooltips switch to the received basis together, and only when the run carries receivedAt", () => {
    const r = 1_000_000 - 7_000;
    expect(dotTip(finished("completed", { receivedAt: r, activity: "done" }))).toBe(
      "succeeded in 1m 10s (received to finish)",
    );
    expect(whenTip(row({ receivedAt: r }))).toBe(`received ${formatLocalIso(r)}\nstarted ${formatLocalIso(1_000_000)}`);
    expect(whenTip(row())).toBe(`started ${formatLocalIso(1_000_000)}`);
  });

  it("the started column's tip: exact local stamps, one per line", () => {
    const s = Date.UTC(2026, 7, 30, 5, 0, 0);
    const f = Date.UTC(2026, 7, 30, 5, 2, 0);
    expect(whenTip(row({ startedAt: s }))).toBe(`started ${formatLocalIso(s)}`);
    expect(whenTip(row({ finished: true, startedAt: s, finishedAt: f }))).toBe(
      `started ${formatLocalIso(s)}\nfinished ${formatLocalIso(f)}`,
    );
  });

  it("the source tip: via <surface> · <resolved identity>, falling back to the id suffix", () => {
    expect(sourceTip(row({ userName: "alice" }))).toBe("via Slack · alice");
    expect(sourceTip(row())).toBe("via Slack · UACME1");
    expect(sourceTip(row({ channelId: "cli:local", userId: "cli:alice" }))).toBe("via CLI · alice");
    expect(sourceTip(row({ channelId: "weird" }))).toBe("via unknown · UACME1");
  });
});

describe("surface + repo + sourceUrl", () => {
  it("derives the surface from the channel id's platform prefix", () => {
    expect(surfaceOf(row()).kind).toBe("slack");
    expect(surfaceOf(row({ channelId: "http:hooks" })).kind).toBe("http");
    expect(surfaceOf(row({ channelId: "mcp:claude" })).kind).toBe("mcp");
    expect(surfaceOf(row({ channelId: "weird" })).kind).toBe("unknown");
  });

  it("repo comes from RunView.repo or a repo-shaped label scope; hostile shapes never qualify", () => {
    expect(repoOf(row(), "acme/web")).toBe("acme/web");
    expect(repoOf(row({ repo: "acme/web" }), "#dev · alice")).toBe("acme/web");
    expect(repoOf(row(), "#dev · alice")).toBe("");
    expect(repoOf(row(), "javascript:alert(1)//x")).toBe("");
  });

  it("only http(s) sourceUrls survive — a hand-built record cannot plant a javascript: click target", () => {
    expect(safeSourceUrl(row({ sourceUrl: "https://acme.slack.com/archives/C1/p1" }))).toBe(
      "https://acme.slack.com/archives/C1/p1",
    );
    expect(safeSourceUrl(row({ sourceUrl: "javascript:alert(1)" }))).toBe("");
    expect(safeSourceUrl(row())).toBe("");
  });
});

describe("feed reconciliation", () => {
  it("default view: drops a finished upsert (the row leaves as the run ends), honors every removed", () => {
    expect(feedAction({ type: "upsert", run: finished("completed") }, false, false)).toEqual({
      op: "remove",
      id: "run-1",
    });
    expect(feedAction({ type: "upsert", run: row() }, false, false)).toEqual({ op: "upsert", run: row() });
    expect(feedAction({ type: "removed", id: "x" }, false, true)).toEqual({ op: "remove", id: "x" });
  });

  it("?all=1: keeps finished rows, ignores removed only for a store-confirmed row", () => {
    expect(feedAction({ type: "upsert", run: finished("completed") }, true, false)).toEqual({
      op: "upsert",
      run: finished("completed"),
    });
    expect(feedAction({ type: "removed", id: "x" }, true, true)).toEqual({ op: "keep" });
    expect(feedAction({ type: "removed", id: "x" }, true, false)).toEqual({ op: "remove", id: "x" });
    expect(feedAction({ type: "bogus" }, true, false)).toEqual({ op: "keep" });
  });

  it("a repaint merges the kept record fields under an incoming summary — it overrides only what it carries", () => {
    const kept = finished("completed");
    const summary = row({ finished: true });
    const merged = mergeRow(kept, summary);
    expect(merged.finishedAt).toBe(kept.finishedAt);
    expect(merged.status).toBe("completed");
    // a live previous row keeps nothing
    expect(mergeRow(row(), summary)).toEqual(summary);
    // the tracing stamps ride the record, never a registry upsert: a repaint keeps them
    const stamped = row({
      finished: true,
      finishedAt: 2_000_000,
      receivedAt: 990_000,
      sealedAt: 2_000_500,
      replyOk: true,
    });
    const repaint = mergeRow(stamped, row({ finished: true }));
    expect(repaint).toMatchObject({ receivedAt: 990_000, sealedAt: 2_000_500, replyOk: true, finishedAt: 2_000_000 });
    // the summary's own fields always win
    const withOwn = mergeRow(kept, finished("failed", { finishedAt: 42 }));
    expect(withOwn.status).toBe("failed");
    expect(withOwn.finishedAt).toBe(42);
  });
});

// Feature: docs/reference/specs/live-view.md item 32 — the stall
// signal on the row: events per minute over the last five minutes, or "no tool
// call for N min"; a call past its declared bound named with the bound; only a
// row that carries the fact can stall (an older writer's row has no signal).
describe("the stall signal (item 32)", () => {
  const MIN = 60_000;
  const live = (over: Partial<IndexRow> = {}) => row({ startedAt: 0, ...over });

  it("rowPace: a healthy live row reads events per minute; a stalled one `no tool call for N min`", () => {
    expect(rowPace(live({ eventsLast5m: 14, lastToolCallAt: 60 * MIN - 9_000 }), 60 * MIN)).toBe("2.8/min");
    expect(rowPace(live({ eventsLast5m: 0, lastToolCallAt: 16 * MIN }), 60 * MIN)).toBe("no tool call for 44 min");
  });

  it("rowPace is empty for a finished row and for a row without the fact", () => {
    expect(rowPace(live({ finished: true, eventsLast5m: 3 }), 60 * MIN)).toBe("");
    expect(rowPace(live(), 60 * MIN)).toBe("");
  });

  it("rowStalled: live with no tool call for a window — never a finished row, never a row without the fact", () => {
    expect(rowStalled(live({ eventsLast5m: 0, lastToolCallAt: 16 * MIN }), 60 * MIN)).toBe(true);
    expect(rowStalled(live({ eventsLast5m: 2, lastToolCallAt: 59 * MIN }), 60 * MIN)).toBe(false);
    expect(rowStalled(live({ finished: true, eventsLast5m: 0, lastToolCallAt: 16 * MIN }), 60 * MIN)).toBe(false);
    expect(rowStalled(live(), 60 * MIN)).toBe(false);
  });

  it("rowBound names a call past its declared bound — `bash 2083s, bound 600s` — and nothing inside it or without one", () => {
    const hung = live({ inFlight: { tool: "bash", since: 0, boundMs: 600_000 } });
    expect(rowBound(hung, 2_083_000)).toBe("bash 2083s, bound 600s");
    expect(rowBound(hung, 500_000)).toBeUndefined();
    expect(rowBound(live({ inFlight: { tool: "bash", since: 0 } }), 2_083_000)).toBeUndefined();
    expect(rowBound(live({ finished: true, inFlight: { tool: "bash", since: 0, boundMs: 1 } }), 9)).toBeUndefined();
  });

  it("paceTip says what the cell shows: the rate's window, the stall's clock, or the outrun bound", () => {
    expect(paceTip(live({ eventsLast5m: 14, lastToolCallAt: 60 * MIN - 9_000 }), 60 * MIN)).toBe(
      "events per minute over the last five minutes",
    );
    expect(paceTip(live({ eventsLast5m: 0, lastToolCallAt: 16 * MIN }), 60 * MIN)).toBe(
      "time since the run's last tool call",
    );
    expect(paceTip(live({ eventsLast5m: 0, inFlight: { tool: "bash", since: 0, boundMs: 600_000 } }), 2_083_000)).toBe(
      "this call ran past the bound it declared — it should have been cut",
    );
  });
});

describe("the pipeline nesting (item 33)", () => {
  const MIN = 60_000;
  const at = (id: string, startedAt: number, over: Partial<IndexRow> = {}): IndexRow => row({ id, startedAt, ...over });

  it("nests a ship unit's runs under the parent whose instanceId their parentInstanceId names, and a conductor's child under its parentRunId row — children oldest-first, heads newest-first", () => {
    const ship = at("ship", 1_000, { hosted: true, instanceId: "wf-1" });
    const c0 = at("c0", 2_000, { parentInstanceId: "wf-1" });
    const r1 = at("r1", 3_000, { parentInstanceId: "wf-1" });
    const cond = at("cond", 4_000);
    const kid = at("kid", 5_000, { parentRunId: "cond" });
    const stranger = at("solo", 6_000);
    const groups = groupRuns([c0, stranger, ship, kid, r1, cond], 60 * MIN);
    expect(groups.map((g) => [g.head.id, g.children.map((c) => c.id)])).toEqual([
      ["solo", []],
      ["cond", ["kid"]],
      ["ship", ["c0", "r1"]],
    ]);
  });

  it("a row whose parent is not on the page stays a head — nesting never hides a run — and a grandchild lands under the top of its chain", () => {
    const orphan = at("orphan", 2_000, { parentInstanceId: "wf-9", parentRunId: "gone" });
    expect(groupRuns([orphan], 0).map((g) => g.head.id)).toEqual(["orphan"]);
    const top = at("top", 1_000);
    const mid = at("mid", 2_000, { parentRunId: "top" });
    const leaf = at("leaf", 3_000, { parentRunId: "mid" });
    expect(groupRuns([leaf, mid, top], 0).map((g) => [g.head.id, g.children.map((c) => c.id)])).toEqual([
      ["top", ["mid", "leaf"]],
    ]);
    // A malformed cycle names nobody as the top: each row stays its own head.
    const a = at("a", 1_000, { parentRunId: "b" });
    const b = at("b", 2_000, { parentRunId: "a" });
    expect(groupRuns([a, b], 0).map((g) => g.head.id)).toEqual(["b", "a"]);
  });

  it("a stalled child surfaces its whole group first — the group is stalled when any of its rows is", () => {
    const ship = at("ship", 1_000, { hosted: true, instanceId: "wf-1", eventsLast5m: 3, lastToolCallAt: 59 * MIN });
    const stuck = at("c0", 2_000, { parentInstanceId: "wf-1", eventsLast5m: 0, lastToolCallAt: 16 * MIN });
    const fresh = at("solo", 9_000, { eventsLast5m: 2, lastToolCallAt: 59 * MIN });
    expect(groupRuns([fresh, ship, stuck], 60 * MIN).map((g) => g.head.id)).toEqual(["ship", "solo"]);
  });
});

describe("expiry", () => {
  it("expiresAt = finishedAt + retention; nothing without a retention or for live rows", () => {
    expect(expiresAt(finished("completed"), 1000)).toBe(1_063_000 + 1000);
    expect(expiresAt(finished("completed"), undefined)).toBeUndefined();
    expect(expiresAt(row(), 1000)).toBeUndefined();
  });
});
