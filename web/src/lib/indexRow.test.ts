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
} from "./indexRow";
import { formatLocalIso } from "./format";

// The row model, ported from the old isomorphic indexRowRenderer — the same
// vocabulary and rules, as pure functions.

const base: IndexRow = {
  id: "run-1",
  label: 'coding · acme/web · "fix the build"',
  channelId: "slack:C1",
  userId: "slack:U1",
  threadKey: "slack:C1:1.0",
  finished: false,
  startedAt: 1_000_000,
  eventCount: 4,
};
const row = (over: Partial<IndexRow> = {}): IndexRow => ({ ...base, ...over });
const finished = (status: IndexRow["status"], over: Partial<IndexRow> = {}) =>
  row({ finished: true, finishedAt: 1_000_000 + 63_000, status, ...over });

describe("status vocabulary", () => {
  it("shows display words, not the enum: succeeded / failed / killed / stopped early", () => {
    expect(statusLabel("completed")).toBe("succeeded");
    expect(statusLabel("failed")).toBe("failed");
    expect(statusLabel("stopped_hard")).toBe("killed");
    expect(statusLabel("stopped_soft")).toBe("stopped early");
  });

  it("statusWord: live, else the status word, else finished", () => {
    expect(statusWord(row())).toBe("live");
    expect(statusWord(finished("completed"))).toBe("succeeded");
    expect(statusWord(row({ finished: true }))).toBe("finished");
  });

  it("dot tone: green live, red failed/killed, amber stopped early, grey succeeded", () => {
    expect(statusDot(row())).toBe("green");
    expect(statusDot(finished("failed"))).toBe("red");
    expect(statusDot(finished("stopped_hard"))).toBe("red");
    expect(statusDot(finished("stopped_soft"))).toBe("amber");
    expect(statusDot(finished("completed"))).toBe("grey");
  });

  it("stop badge: stopping (mode) in flight, the outcome word once stopped", () => {
    expect(stopLabel({ state: "stopping", mode: "soft" })).toBe("stopping (soft)");
    expect(stopLabel({ state: "stopped", mode: "hard" })).toBe("killed");
    expect(stopLabel({ state: "stopped", mode: "soft" })).toBe("stopped early");
  });
});

describe("hrefs", () => {
  it("a live row links with its capability token; a finished row never does (R10), even while the registry still holds one", () => {
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

  it("the started column's tip: exact local stamps, one per line", () => {
    const s = Date.UTC(2026, 7, 30, 5, 0, 0);
    const f = Date.UTC(2026, 7, 30, 5, 2, 0);
    expect(whenTip(row({ startedAt: s }))).toBe(`started ${formatLocalIso(s)}`);
    expect(whenTip(row({ finished: true, startedAt: s, finishedAt: f }))).toBe(`started ${formatLocalIso(s)}\nfinished ${formatLocalIso(f)}`);
  });

  it("the source tip: via <surface> · <resolved identity>, falling back to the id suffix", () => {
    expect(sourceTip(row({ userName: "justin" }))).toBe("via Slack · justin");
    expect(sourceTip(row())).toBe("via Slack · U1");
    expect(sourceTip(row({ channelId: "cli:local", userId: "cli:justin" }))).toBe("via CLI · justin");
    expect(sourceTip(row({ channelId: "weird" }))).toBe("via unknown · U1");
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
    expect(repoOf(row({ repo: "acme/web" }), "#dev · justin")).toBe("acme/web");
    expect(repoOf(row(), "#dev · justin")).toBe("");
    expect(repoOf(row(), "javascript:alert(1)//x")).toBe("");
  });

  it("only http(s) sourceUrls survive — a hand-built record cannot plant a javascript: click target", () => {
    expect(safeSourceUrl(row({ sourceUrl: "https://acme.slack.com/archives/C1/p1" }))).toBe("https://acme.slack.com/archives/C1/p1");
    expect(safeSourceUrl(row({ sourceUrl: "javascript:alert(1)" }))).toBe("");
    expect(safeSourceUrl(row())).toBe("");
  });
});

describe("feed reconciliation (R11)", () => {
  it("default view: drops a finished upsert (the row leaves as the run ends), honors every removed", () => {
    expect(feedAction({ type: "upsert", run: finished("completed") }, false, false)).toEqual({ op: "remove", id: "run-1" });
    expect(feedAction({ type: "upsert", run: row() }, false, false)).toEqual({ op: "upsert", run: row() });
    expect(feedAction({ type: "removed", id: "x" }, false, true)).toEqual({ op: "remove", id: "x" });
  });

  it("?all=1: keeps finished rows, ignores removed only for a store-confirmed row", () => {
    expect(feedAction({ type: "upsert", run: finished("completed") }, true, false)).toEqual({ op: "upsert", run: finished("completed") });
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
    // the summary's own fields always win
    const withOwn = mergeRow(kept, finished("failed", { finishedAt: 42 }));
    expect(withOwn.status).toBe("failed");
    expect(withOwn.finishedAt).toBe(42);
  });
});

describe("expiry", () => {
  it("expiresAt = finishedAt + retention; nothing without a retention or for live rows", () => {
    expect(expiresAt(finished("completed"), 1000)).toBe(1_063_000 + 1000);
    expect(expiresAt(finished("completed"), undefined)).toBeUndefined();
    expect(expiresAt(row(), 1000)).toBeUndefined();
  });
});
