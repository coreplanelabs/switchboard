import { describe, expect, it } from "vitest";
import {
  clampRailWidth,
  classifyReply,
  compactAge,
  composerMode,
  conversationTitle,
  enterSubmits,
  filterRows,
  fuzzyScore,
  greeting,
  liveUrls,
  matchSteer,
  placeholderFor,
  RAIL_WIDTH,
  railPrefs,
  shortcutFor,
  shouldFollow,
  threadTip,
} from "./homeModel";

// Feature: docs/reference/specs/web-chat.md — the home page's pure rules.

describe("composerMode — one control, two states (rule 5)", () => {
  it("is send while no run is live, whatever the text", () => {
    expect(composerMode(false, "")).toBe("send");
    expect(composerMode(false, "hi")).toBe("send");
  });
  it("while a run is live: stop with an empty box, steer once there is text", () => {
    expect(composerMode(true, "")).toBe("stop");
    expect(composerMode(true, "   ")).toBe("stop");
    expect(composerMode(true, "also check the migration")).toBe("steer");
  });
});

describe("classifyReply — what a run-less reply means", () => {
  it("a hand-back is the command to paste, without its prefix", () => {
    expect(classifyReply("To run this: config set me --models.coding anthropic/claude-opus-5")).toEqual({
      kind: "handBack",
      command: "config set me --models.coding anthropic/claude-opus-5",
    });
  });
  it("a steer acknowledgement paints nothing", () => {
    const text =
      "↪ Folded into the *review* run already in flight in this thread (40s in) — it picks this up at its next step.";
    expect(classifyReply(text)).toEqual({ kind: "steerAck", text });
  });
  it("anything else is an inline turn", () => {
    expect(classifyReply("🚫 You're not on the allowlist for the `coding` agent.")).toEqual({
      kind: "inline",
      text: "🚫 You're not on the allowlist for the `coding` agent.",
    });
  });
});

describe("liveUrls — the stream and stop routes from a 202's view path", () => {
  it("carries the token onto both routes", () => {
    expect(liveUrls("/runs/r-9?t=abc")).toEqual({
      id: "r-9",
      eventsUrl: "/runs/r-9/events?t=abc",
      stopUrl: "/runs/r-9/stop?t=abc",
    });
  });
  it("a tokenless path keeps both routes tokenless; anything else is null", () => {
    expect(liveUrls("/runs/r-9")).toEqual({ id: "r-9", eventsUrl: "/runs/r-9/events", stopUrl: "/runs/r-9/stop" });
    expect(liveUrls("https://evil.example/runs/r-9?t=x")).toBeNull();
    expect(liveUrls("/residents")).toBeNull();
  });
});

describe("conversationTitle — the first request's first line, cut to 60", () => {
  it("takes the first non-empty line", () => {
    expect(conversationTitle("\n\nreview PR 1391\nplease")).toBe("review PR 1391");
  });
  it("cuts a long line with an ellipsis at 60 characters", () => {
    const title = conversationTitle("a".repeat(100));
    expect(title.length).toBe(60);
    expect(title.endsWith("…")).toBe(true);
  });
  it("an empty request is a new conversation", () => {
    expect(conversationTitle("   ")).toBe("New conversation");
  });
});

describe("greeting — names the person and the time of day (rule 7)", () => {
  it.each([
    [3, "Still up, alice."],
    [9, "Good morning, alice."],
    [14, "Good afternoon, alice."],
    [21, "Good evening, alice."],
  ])("hour %i", (hour, want) => {
    expect(greeting(hour, "alice")).toBe(want);
  });
  it("without a name, the time of day alone", () => {
    expect(greeting(9, "")).toBe("Good morning.");
  });
});

describe("matchSteer — the drained input confirms the turn already drawn (rule 3)", () => {
  it("matches the newest unfolded turn with the same words", () => {
    const turns = [
      { text: "also check the migration", folded: false, id: 1 },
      { text: "also check the migration", folded: false, id: 2 },
    ];
    expect(matchSteer(turns, " also check the migration ")?.id).toBe(2);
  });
  it("a folded turn is never matched twice; different words match nothing", () => {
    const turns = [{ text: "x", folded: true }];
    expect(matchSteer(turns, "x")).toBeNull();
    expect(matchSteer([{ text: "x", folded: false }], "y")).toBeNull();
  });
});

describe("shouldFollow — the transcript follows only a reader at the bottom (rule 2)", () => {
  it("within the slack follows; above it does not", () => {
    expect(shouldFollow(0)).toBe(true);
    expect(shouldFollow(60)).toBe(true);
    expect(shouldFollow(61)).toBe(false);
  });
});

describe("enterSubmits — Enter sends, Shift+Enter breaks a line (rule 8)", () => {
  it("decides by the key and the shift", () => {
    expect(enterSubmits({ key: "Enter", shiftKey: false })).toBe(true);
    expect(enterSubmits({ key: "Enter", shiftKey: true })).toBe(false);
    expect(enterSubmits({ key: "Enter", shiftKey: false, isComposing: true })).toBe(false);
    expect(enterSubmits({ key: "a", shiftKey: false })).toBe(false);
  });
});

describe("fuzzyScore / filterRows — the rail's filter (rule 7)", () => {
  it("matches a subsequence, case-insensitively, and scores tighter matches lower", () => {
    expect(fuzzyScore("rvw api", "review https://github.com/acme/api/pull/61")).not.toBeNull();
    expect(fuzzyScore("REVIEW", "review PR 61")).toBe(5);
    expect(fuzzyScore("zzz", "review PR 61")).toBeNull();
    expect(fuzzyScore("", "anything")).toBe(0);
  });
  it("keeps every row for an empty query and orders matches by tightness, then the rail's order", () => {
    const rows = [{ title: "bump the SDK" }, { title: "review PR 61" }, { title: "re-review after the repush" }];
    expect(filterRows(rows, "").map((r) => r.title)).toEqual(rows.map((r) => r.title));
    expect(filterRows(rows, "review").map((r) => r.title)).toEqual(["review PR 61", "re-review after the repush"]);
    expect(filterRows(rows, "sdk").map((r) => r.title)).toEqual(["bump the SDK"]);
    expect(filterRows(rows, "nothing here")).toEqual([]);
  });
});

describe("shortcutFor — the page's two shortcuts (rule 7)", () => {
  it("⇧⌘O (or ⌃⇧O) is a new thread; ⌘K (or ⌃K) is the filter; anything else is nothing", () => {
    expect(shortcutFor({ key: "O", metaKey: true, ctrlKey: false, shiftKey: true })).toBe("newThread");
    expect(shortcutFor({ key: "o", metaKey: false, ctrlKey: true, shiftKey: true })).toBe("newThread");
    expect(shortcutFor({ key: "k", metaKey: true, ctrlKey: false, shiftKey: false })).toBe("search");
    expect(shortcutFor({ key: "k", metaKey: true, ctrlKey: false, shiftKey: true })).toBeNull();
    expect(shortcutFor({ key: "o", metaKey: true, ctrlKey: false, shiftKey: false })).toBeNull();
    expect(shortcutFor({ key: "k", metaKey: false, ctrlKey: false, shiftKey: false })).toBeNull();
  });
});

describe("placeholderFor — the placeholder guides the hand (rule 8)", () => {
  it("names what to ask while nothing is live, what the box does while a run is, nothing after a hand-back", () => {
    expect(placeholderFor("send")).toMatch(/^Review a pull request, ship a fix, investigate a run/);
    expect(placeholderFor("send")).toMatch(/\/ for a command$/);
    expect(placeholderFor("steer")).toMatch(/folds into the run/);
    expect(placeholderFor("stop")).toMatch(/steer it, or stop it/);
    expect(placeholderFor("send", "Enter runs it")).toBe("");
  });
});

describe("compactAge — the rail's short distance (rule 7)", () => {
  const NOW = Date.UTC(2026, 8, 16, 20, 0, 0);
  it("now, minutes, hours, days, then the date", () => {
    expect(compactAge(NOW - 10_000, NOW)).toBe("now");
    expect(compactAge(NOW - 3 * 60_000, NOW)).toBe("3m");
    expect(compactAge(NOW - 59 * 60_000, NOW)).toBe("59m");
    expect(compactAge(NOW - 60 * 60_000, NOW)).toBe("1h");
    expect(compactAge(NOW - 23 * 3_600_000, NOW)).toBe("23h");
    expect(compactAge(NOW - 24 * 3_600_000, NOW)).toBe("1d");
    expect(compactAge(NOW - 6 * 86_400_000, NOW)).toBe("6d");
    expect(compactAge(NOW - 8 * 86_400_000, NOW)).toMatch(/^Sep \d+$/);
    expect(compactAge(NOW - 400 * 86_400_000, NOW)).toMatch(/^\w{3} \d+, 2025$/);
  });
});

describe("threadTip — what a row says on hover (rule 7)", () => {
  const NOW = Date.UTC(2026, 8, 16, 20, 0, 0);
  it("the full first line, the date and time, the source, the run count and whether a run is live", () => {
    const tip = threadTip(
      {
        title: "please review https://github.com/acme/api/pull/61 — the retry…",
        excerpt: "please review https://github.com/acme/api/pull/61 — the retry queue caps its backoff",
        lastAt: NOW - 3 * 60_000,
        runs: 3,
        live: true,
        surface: "slack",
      },
      NOW,
    );
    expect(tip.title).toBe("please review https://github.com/acme/api/pull/61 — the retry queue caps its backoff");
    expect(tip.when).toMatch(/^Sep 16, \d{1,2}:\d{2} [AP]M$/);
    expect(tip.source).toBe("Slack · read-only here");
    expect(tip.runs).toBe("3 runs");
    expect(tip.live).toBe(true);
  });
  it("a web conversation names no channel; one run is singular; no excerpt falls back to the title", () => {
    const tip = threadTip(
      {
        title: "bump the SDK",
        excerpt: "bump the SDK",
        lastAt: NOW - 86_400_000,
        runs: 1,
        live: false,
        surface: "web",
      },
      NOW,
    );
    expect(tip.title).toBe("bump the SDK");
    expect(tip.source).toBe("Web");
    expect(tip.runs).toBe("1 run");
    expect(tip.live).toBe(false);
    expect(threadTip({ title: "x", excerpt: "", lastAt: NOW, runs: 2, live: false }, NOW)).toMatchObject({
      title: "x",
      source: "Web",
    });
  });
});

describe("clampRailWidth / railPrefs — the rail's width and whether it is shown (rule 7)", () => {
  it("clamps to the band, and anything unreadable is the default", () => {
    expect(RAIL_WIDTH).toEqual({ min: 224, default: 288, max: 448, step: 16 });
    expect(clampRailWidth(300)).toBe(300);
    expect(clampRailWidth(10)).toBe(224);
    expect(clampRailWidth(9_999)).toBe(448);
    expect(clampRailWidth(Number.NaN)).toBe(288);
    expect(clampRailWidth(undefined)).toBe(288);
    expect(clampRailWidth("312")).toBe(312);
  });
  it("reads what the browser remembered: a width in the band and a collapsed flag; nothing remembered is the default, shown", () => {
    expect(railPrefs({ width: "320", collapsed: "1" })).toEqual({ width: 320, collapsed: true });
    expect(railPrefs({ width: null, collapsed: null })).toEqual({ width: 288, collapsed: false });
    expect(railPrefs({ width: "abc", collapsed: "0" })).toEqual({ width: 288, collapsed: false });
  });
});
