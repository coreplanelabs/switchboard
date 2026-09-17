import { describe, expect, it } from "vitest";
import type { HomeConversationRowSeed, RunIndexRowSeed } from "@core/channels/webSeed.js";
import { applyIndexEvent, liveByThread, liveRailRows, railLiveState, rowThreadKey } from "./railLive";

// Feature: docs/reference/specs/web-chat.md item 7 — the rail follows the runs
// index's feed narrowed to the viewer: which threads have a run in flight, how
// many, and a thread started since the page loaded.

const run = (id: string, threadKey: string, over: Partial<RunIndexRowSeed> = {}): RunIndexRowSeed => ({
  id,
  threadKey,
  channelId: threadKey.split(":").slice(0, 2).join(":"),
  startedAt: 1_000,
  finished: false,
  eventCount: 1,
  ...over,
});

const ROWS: HomeConversationRowSeed[] = [
  { id: "conv-1", title: "review PR 7", excerpt: "review PR 7", lastAt: 900, runs: 2, live: true, surface: "web" },
  {
    id: "slack:C1:1.2",
    title: "please review",
    excerpt: "please review",
    lastAt: 800,
    runs: 1,
    live: false,
    surface: "slack",
  },
];

describe("applyIndexEvent / liveByThread", () => {
  it("keeps a live upsert by run id, drops a finished one, a removed one and a run with no thread; groups by thread", () => {
    const s = railLiveState();
    applyIndexEvent(s, { type: "upsert", run: run("r1", "web:a1:conv-1") });
    applyIndexEvent(s, { type: "upsert", run: run("r2", "web:a1:conv-1", { startedAt: 2_000 }) });
    applyIndexEvent(s, { type: "upsert", run: run("r3", "slack:C1:1.2") });
    applyIndexEvent(s, { type: "upsert", run: run("r4", "slack:C1:1.2", { finished: true }) });
    applyIndexEvent(s, { type: "upsert", run: { ...run("r5", "x"), threadKey: undefined } });
    applyIndexEvent(s, { type: "replay_note" });
    expect([...s.runs.keys()]).toEqual(["r1", "r2", "r3"]);
    expect([...liveByThread(s).entries()].map(([k, v]) => [k, v.length])).toEqual([
      ["web:a1:conv-1", 2],
      ["slack:C1:1.2", 1],
    ]);
    applyIndexEvent(s, { type: "removed", id: "r3" });
    applyIndexEvent(s, { type: "upsert", run: run("r1", "web:a1:conv-1", { finished: true }) });
    expect([...s.runs.keys()]).toEqual(["r2"]);
  });

  it("rowThreadKey: a short id is the viewer's lane, a key is itself", () => {
    expect(rowThreadKey("web:a1", "conv-1")).toBe("web:a1:conv-1");
    expect(rowThreadKey("web:a1", "slack:C1:1.2")).toBe("slack:C1:1.2");
  });
});

describe("liveRailRows — the seed's rows corrected by the feed", () => {
  it("before the feed connects the seed stands; connected, a row's live flag follows the feed and a live run the seed did not count adds to it", () => {
    const s = railLiveState();
    expect(liveRailRows(ROWS, s, "web:a1")).toEqual(ROWS);
    s.connected = true;
    // Nothing live anywhere: the seed's live row goes quiet.
    expect(liveRailRows(ROWS, s, "web:a1").map((r) => r.live)).toEqual([false, false]);
    // The Slack thread gained a run since the page loaded: live, one more run, moved to its start.
    applyIndexEvent(s, { type: "upsert", run: run("r3", "slack:C1:1.2", { startedAt: 5_000 }) });
    const rows = liveRailRows(ROWS, s, "web:a1");
    expect(rows[1]).toEqual({ ...ROWS[1], live: true, runs: 2, lastAt: 5_000 });
    // A row the seed already counted live keeps its count: the feed confirms, not adds.
    applyIndexEvent(s, { type: "upsert", run: run("r1", "web:a1:conv-1") });
    expect(liveRailRows(ROWS, s, "web:a1")[0]).toEqual({ ...ROWS[0], live: true, lastAt: 1_000 });
  });

  it("a live thread the seed did not list gets a row on top, titled by the run's label snippet, linked by its short id on the viewer's lane and by its key elsewhere", () => {
    const s = railLiveState();
    s.connected = true;
    applyIndexEvent(s, {
      type: "upsert",
      run: run("r9", "web:a1:conv-9", { startedAt: 9_000, label: 'general · #a1 · alice · "what changed today?"' }),
    });
    applyIndexEvent(s, {
      type: "upsert",
      run: run("r8", "slack:C2:3.4", { startedAt: 8_000, label: "review · acme/api" }),
    });
    const rows = liveRailRows(ROWS, s, "web:a1");
    expect(rows.slice(0, 2)).toEqual([
      {
        id: "conv-9",
        title: "what changed today?",
        excerpt: "what changed today?",
        lastAt: 9_000,
        runs: 1,
        live: true,
        surface: "web",
      },
      {
        id: "slack:C2:3.4",
        title: "review · acme/api",
        excerpt: "review · acme/api",
        lastAt: 8_000,
        runs: 1,
        live: true,
        surface: "slack",
      },
    ]);
    expect(rows).toHaveLength(4);
  });
});
