import { describe, expect, it } from "vitest";
import {
  classifyReply,
  completeCommand,
  composerMode,
  conversationTitle,
  enterSubmits,
  filterCommands,
  filterRows,
  fuzzyScore,
  greeting,
  liveUrls,
  matchSteer,
  placeholderFor,
  shortcutFor,
  slashQuery,
  shouldFollow,
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
  it("⇧⌘O (or ⌃⇧O) is a new chat; ⌘K (or ⌃K) is the filter; anything else is nothing", () => {
    expect(shortcutFor({ key: "O", metaKey: true, ctrlKey: false, shiftKey: true })).toBe("newChat");
    expect(shortcutFor({ key: "o", metaKey: false, ctrlKey: true, shiftKey: true })).toBe("newChat");
    expect(shortcutFor({ key: "k", metaKey: true, ctrlKey: false, shiftKey: false })).toBe("search");
    expect(shortcutFor({ key: "k", metaKey: true, ctrlKey: false, shiftKey: true })).toBeNull();
    expect(shortcutFor({ key: "o", metaKey: true, ctrlKey: false, shiftKey: false })).toBeNull();
    expect(shortcutFor({ key: "k", metaKey: false, ctrlKey: false, shiftKey: false })).toBeNull();
  });
});

describe("slashQuery / filterCommands / completeCommand — the / palette (rule 8)", () => {
  it("a message that is `/` and one word is a lookup; prose, a second line or a slash mid-sentence is not", () => {
    expect(slashQuery("/")).toBe("");
    expect(slashQuery("/con")).toBe("con");
    expect(slashQuery("/config set")).toBeNull();
    expect(slashQuery("review /x")).toBeNull();
    expect(slashQuery("/con\nfig")).toBeNull();
    expect(slashQuery("hello")).toBeNull();
  });
  it("narrows by the chat form or the description, tightest first; an empty query keeps every command", () => {
    const cmds = [
      { chat: "help", describe: "What Switchboard can do" },
      { chat: "config set", describe: "Set a scope's agent, model, effort" },
      { chat: "mcp add", describe: "Add an MCP server to a tier" },
    ];
    expect(filterCommands(cmds, "").map((c) => c.chat)).toEqual(["help", "config set", "mcp add"]);
    expect(filterCommands(cmds, "mcp").map((c) => c.chat)).toEqual(["mcp add"]);
    expect(filterCommands(cmds, "agent").map((c) => c.chat)).toEqual(["config set"]);
    expect(filterCommands(cmds, "zzz")).toEqual([]);
  });
  it("a pick inserts the chat form and a space, never the slash", () => {
    expect(completeCommand("config set")).toBe("config set ");
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
