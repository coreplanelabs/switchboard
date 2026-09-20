import { describe, expect, it } from "vitest";
import type { ChatMessage } from "../chatMessage.js";
import { utf8ByteLength } from "../runRecord.js";
import {
  actorOfStoredRow,
  attachmentRefsOf,
  DEFAULT_SESSION_LOG_MAX_BYTES,
  droppedToolResultRow,
  isRunSession,
  planSessionTrim,
  requestIndex,
  rowKind,
  SESSION_KEY_PATTERN,
  sessionKey,
  sessionsToDrop,
  SNIPPET_CHARS,
  snippetOf,
  tailCut,
  textOfStoredRow,
  threadSessionKey,
  workingSessionKey,
  connectorRowId,
  shipUnitRowId,
  storedTurnRow,
  silentOfStoredRow,
  foldedOfStoredRow,
  migrationOrder,
  migrationRowId,
} from "./sessionLog.js";

// Feature: docs/reference/specs/session-log.md — the pure rules of the session
// log: the object's name, the run's range on a row and a record, the tail cut,
// the byte policy's choice of what to drop, the sweep's drop decision, and the
// text the full-text index sees for a stored row.

const stored = (role: ChatMessage["role"], part: unknown) => JSON.stringify({ role, part });

describe("sessionKey — one object per thread and agent", () => {
  it("is the thread key, a colon, the agent; an agentless run keys on a dash; every key matches the pattern", () => {
    expect(sessionKey("slack:C1:1700000000.000100", "coding")).toBe("slack:C1:1700000000.000100:coding");
    expect(sessionKey("slack:C1:1.0", undefined)).toBe("slack:C1:1.0:-");
    expect(SESSION_KEY_PATTERN.test(sessionKey("slack:C1:1.0", "coding"))).toBe(true);
    expect(SESSION_KEY_PATTERN.test(sessionKey("http:ingress/abc", "general"))).toBe(true);
    expect(SESSION_KEY_PATTERN.test("")).toBe(false);
    expect(SESSION_KEY_PATTERN.test("has space")).toBe(false);
  });

  it("two threads of one agent, and two agents of one thread, never share an object", () => {
    expect(sessionKey("slack:C1:1.0", "coding")).not.toBe(sessionKey("slack:C1:2.0", "coding"));
    expect(sessionKey("slack:C1:1.0", "coding")).not.toBe(sessionKey("slack:C1:1.0", "review"));
  });
});

describe("isRunSession — the range a row and a record carry", () => {
  const session = { key: "slack:C1:1.0:coding", seedFrom: 0, request: 2, range: { from: 0 } };
  it("accepts an open range, a closed range and `broken`; also after a JSON round-trip", () => {
    expect(isRunSession(session)).toBe(true);
    expect(isRunSession({ ...session, range: { from: 0, to: 41 } })).toBe(true);
    expect(isRunSession({ ...session, range: "broken" })).toBe(true);
    expect(isRunSession(JSON.parse(JSON.stringify({ ...session, range: { from: 0, to: 41 } })))).toBe(true);
    // A follow-up's seed began before its own rows.
    expect(isRunSession({ key: "k", seedFrom: 148, request: 213, range: { from: 213, to: 260 } })).toBe(true);
  });

  it("refuses a malformed key, a negative or fractional index, a request before the seed, a range before the seed, an end before its start, another word for the range", () => {
    expect(isRunSession({ ...session, key: "" })).toBe(false);
    expect(isRunSession({ ...session, key: "a key" })).toBe(false);
    expect(isRunSession({ ...session, seedFrom: -1 })).toBe(false);
    expect(isRunSession({ ...session, request: 1.5 })).toBe(false);
    expect(isRunSession({ key: "k", seedFrom: 5, request: 4, range: { from: 5 } })).toBe(false);
    expect(isRunSession({ key: "k", seedFrom: 5, request: 5, range: { from: 4 } })).toBe(false);
    expect(isRunSession({ ...session, range: { from: 3, to: 2 } })).toBe(false);
    expect(isRunSession({ ...session, range: "lost" })).toBe(false);
    expect(isRunSession({ ...session, range: undefined })).toBe(false);
    expect(isRunSession(null)).toBe(false);
    expect(isRunSession("k")).toBe(false);
  });
});

describe("requestIndex — the request is the seed's last user turn", () => {
  const user = (t: string): ChatMessage => ({ role: "user", content: [{ type: "text", text: t }] });
  const assistant = (t: string): ChatMessage => ({ role: "assistant", content: [{ type: "text", text: t }] });
  it("names the last user turn; a seed of one turn is its own request; a seed ending on an assistant turn still names the last user turn", () => {
    expect(requestIndex([user("earlier"), assistant("sure"), user("go")])).toBe(2);
    expect(requestIndex([user("go")])).toBe(0);
    expect(requestIndex([user("a"), assistant("b")])).toBe(0);
  });
  it("a seed with no user turn has no request: the first row stands in", () => {
    expect(requestIndex([assistant("b")])).toBe(0);
    expect(requestIndex([])).toBe(0);
  });
});

describe("tailCut — the newest turns within a byte budget, whole turns only", () => {
  // Rows newest first, as the object reads them: idx desc, part desc.
  const rows = [
    { idx: 5, bytes: 100 },
    { idx: 4, bytes: 300 },
    { idx: 4, bytes: 300 }, // turn 4 has two parts: 600 bytes together
    { idx: 3, bytes: 50 },
    { idx: 2, bytes: 1000 },
  ];
  it("walks newest first and returns the first index of the oldest turn that still fits", () => {
    expect(tailCut(rows, 10_000)).toBe(2); // everything fits
    expect(tailCut(rows, 750)).toBe(3); // 100 + 600 + 50 = 750 fits exactly; turn 2 would not
    expect(tailCut(rows, 749)).toBe(4); // turn 3 would cross
    expect(tailCut(rows, 699)).toBe(5); // turn 4's second part would cross: the whole turn is out
    expect(tailCut(rows, 100)).toBe(5);
  });
  it("a newest turn that alone exceeds the budget yields nothing, as does an empty log", () => {
    expect(tailCut(rows, 99)).toBeUndefined();
    expect(tailCut([], 1000)).toBeUndefined();
  });
});

describe("planSessionTrim — the byte policy drops the oldest tool results first", () => {
  it("picks candidates oldest first until the bytes they free cover the excess; each replacement leaves a marker's bytes behind", () => {
    const candidates = [
      { id: 1, bytes: 1000 },
      { id: 7, bytes: 5000 },
      { id: 9, bytes: 200 },
    ];
    expect(planSessionTrim(candidates, 900, 100)).toEqual([1]);
    expect(planSessionTrim(candidates, 901, 100)).toEqual([1, 7]);
    expect(planSessionTrim(candidates, 5800, 100)).toEqual([1, 7]);
    expect(planSessionTrim(candidates, 5801, 100)).toEqual([1, 7, 9]);
  });
  it("no excess drops nothing; an excess the candidates cannot cover takes them all — user and assistant text are never candidates", () => {
    expect(planSessionTrim([{ id: 1, bytes: 100 }], 0, 10)).toEqual([]);
    expect(planSessionTrim([{ id: 1, bytes: 100 }], -5, 10)).toEqual([]);
    expect(planSessionTrim([{ id: 1, bytes: 100 }], 10_000, 10)).toEqual([1]);
    expect(planSessionTrim([], 10_000, 10)).toEqual([]);
  });
  it("a candidate no larger than the marker frees nothing and is skipped", () => {
    expect(
      planSessionTrim(
        [
          { id: 1, bytes: 50 },
          { id: 2, bytes: 500 },
        ],
        100,
        100,
      ),
    ).toEqual([2]);
  });
});

describe("droppedToolResultRow — the marker that replaces a dropped tool result", () => {
  it("keeps the role, the call id and the error flag, names the dropped size, and says the record keeps the first 8,000 characters", () => {
    const original = stored("user", {
      type: "tool_result",
      toolUseId: "c1",
      content: "x".repeat(40_000),
      isError: true,
    });
    const marker = droppedToolResultRow(original);
    expect(marker).toBeDefined();
    const parsed = JSON.parse(marker!) as { role: string; part: Record<string, unknown> };
    expect(parsed.role).toBe("user");
    expect(parsed.part.type).toBe("tool_result");
    expect(parsed.part.toolUseId).toBe("c1");
    expect(parsed.part.isError).toBe(true);
    expect(parsed.part.content).toMatch(/dropped/);
    expect(parsed.part.content).toMatch(new RegExp(String(utf8ByteLength(original))));
    expect(parsed.part.content).toMatch(/8,000 characters/);
    expect(utf8ByteLength(marker!)).toBeLessThan(400);
  });
  it("only a tool result is replaceable: a text part, an image and a compaction row are not", () => {
    expect(droppedToolResultRow(stored("user", { type: "text", text: "keep me" }))).toBeUndefined();
    expect(
      droppedToolResultRow(stored("user", { type: "image", mediaType: "image/png", data: "AAA=" })),
    ).toBeUndefined();
    expect(droppedToolResultRow(JSON.stringify({ compaction: { summary: "s" } }))).toBeUndefined();
    expect(droppedToolResultRow("not json")).toBeUndefined();
  });
});

describe("snippetOf — a hit's text as one line", () => {
  it("collapses whitespace to one line, trims, and cuts at the cap with an ellipsis; a short text is itself", () => {
    expect(snippetOf("  the  lockfile\n\tis fine \n")).toBe("the lockfile is fine");
    const long = snippetOf(`${"w".repeat(SNIPPET_CHARS)} more`);
    expect(long).toHaveLength(SNIPPET_CHARS);
    expect(long.endsWith("…")).toBe(true);
    expect(snippetOf("x".repeat(SNIPPET_CHARS))).toBe("x".repeat(SNIPPET_CHARS));
  });
});

describe("rowKind and textOfStoredRow — what the index sees", () => {
  it("text parts index their text; a tool result its text (string or parts); a tool call its name and arguments; a compaction row its summary", () => {
    expect(rowKind(stored("user", { type: "text", text: "hello" }))).toBe("text");
    expect(textOfStoredRow(stored("user", { type: "text", text: "hello" }))).toBe("hello");
    const result = stored("user", { type: "tool_result", toolUseId: "c1", content: "FAIL src/x.test.ts > names it" });
    expect(rowKind(result)).toBe("tool_result");
    expect(textOfStoredRow(result)).toBe("FAIL src/x.test.ts > names it");
    const parts = stored("user", {
      type: "tool_result",
      toolUseId: "c1",
      content: [
        { type: "text", text: "a" },
        { type: "image", mediaType: "image/png", data: "AAA=" },
        { type: "text", text: "b" },
      ],
    });
    expect(textOfStoredRow(parts)).toBe("a\nb");
    const call = stored("assistant", { type: "tool_use", id: "c1", name: "bash", input: { command: "git status" } });
    expect(rowKind(call)).toBe("tool_use");
    expect(textOfStoredRow(call)).toBe('bash {"command":"git status"}');
    const compaction = JSON.stringify({ compaction: { summary: "the user asked for X", tokensBefore: 1 } });
    expect(rowKind(compaction)).toBe("compaction");
    expect(textOfStoredRow(compaction)).toBe("the user asked for X");
  });
  it("an image, a document, a thinking block and an unreadable row carry no text", () => {
    expect(rowKind(stored("user", { type: "image", mediaType: "image/png", data: "AAA=" }))).toBe("attachment");
    expect(textOfStoredRow(stored("user", { type: "image", mediaType: "image/png", data: "AAA=" }))).toBe("");
    expect(textOfStoredRow(stored("user", { type: "document", mediaType: "application/pdf", data: "AAA=" }))).toBe("");
    expect(rowKind(stored("assistant", { type: "thinking", thinking: "t", signature: "s" }))).toBe("other");
    expect(textOfStoredRow(stored("assistant", { type: "thinking", thinking: "t", signature: "s" }))).toBe("");
    expect(rowKind("{")).toBe("other");
    expect(textOfStoredRow("{")).toBe("");
  });
});

describe("sessionsToDrop — the sweep's decision, per candidate on what it re-reads at the drop", () => {
  it("drops a session only when no kept run names it and no live run holds its thread, and says which fact kept the others", () => {
    expect(
      sessionsToDrop([
        { key: "t1:coding", hasKeptRun: false, threadLive: false },
        { key: "t1:review", hasKeptRun: false, threadLive: false },
        { key: "t2:coding", hasKeptRun: true, threadLive: false },
        { key: "t3:coding", hasKeptRun: false, threadLive: true },
        { key: "t4:coding", hasKeptRun: true, threadLive: true },
      ]),
    ).toEqual([
      { key: "t1:coding", decision: "drop" },
      { key: "t1:review", decision: "drop" },
      { key: "t2:coding", decision: "kept-run" },
      { key: "t3:coding", decision: "thread-live" },
      { key: "t4:coding", decision: "kept-run" },
    ]);
  });
  it("no candidates, no decisions", () => {
    expect(sessionsToDrop([])).toEqual([]);
  });
});

describe("attachmentRefsOf — the attachments a stored row references", () => {
  it("finds a part's own reference and the references of a tool result's nested parts; a row with none, or an unreadable row, references nothing", () => {
    expect(
      attachmentRefsOf(stored("user", { type: "image", mediaType: "image/png", data: "", dataRef: "t1p0" })),
    ).toEqual(["t1p0"]);
    expect(
      attachmentRefsOf(
        stored("user", {
          type: "tool_result",
          toolUseId: "c1",
          content: [
            { type: "text", text: "see" },
            { type: "image", mediaType: "image/png", data: "", dataRef: "t2p0" },
            { type: "image", mediaType: "image/png", data: "", dataRef: "t2p1" },
          ],
        }),
      ),
    ).toEqual(["t2p0", "t2p1"]);
    expect(attachmentRefsOf(stored("user", { type: "text", text: "plain" }))).toEqual([]);
    expect(attachmentRefsOf(JSON.stringify({ compaction: { summary: "s" } }))).toEqual([]);
    expect(attachmentRefsOf("{")).toEqual([]);
  });
});

describe("the default byte policy", () => {
  it("is 200 MiB — tens of megabytes is a heavy coding session, so a session hits it only when it outgrows what any window could hold", () => {
    expect(DEFAULT_SESSION_LOG_MAX_BYTES).toBe(200 * 1024 * 1024);
  });
});

// docs/reference/specs/session-log.md item 12: authored session rows (record 0057).
describe("actorOfStoredRow — the author's id, absent for bot turns and old rows", () => {
  it("a stored row with an actor field returns that actor id", () => {
    const row = JSON.stringify({ role: "user", part: { type: "text", text: "hello" }, actor: "slack:UALICE" });
    expect(actorOfStoredRow(row)).toBe("slack:UALICE");
  });

  it("a stored row without an actor field — an old row from before this unit — reads actor as absent (undefined)", () => {
    const row = stored("user", { type: "text", text: "hello" }); // no actor field
    expect(actorOfStoredRow(row)).toBeUndefined();
  });

  it("a compaction row and an unreadable row have no actor", () => {
    expect(actorOfStoredRow(JSON.stringify({ compaction: { summary: "s" } }))).toBeUndefined();
    expect(actorOfStoredRow("{")).toBeUndefined();
  });
});

describe("threadSessionKey and workingSessionKey — the thread session and the working lanes (item 13)", () => {
  it("the thread session is keyed by the thread alone and can never collide with a per-agent key", () => {
    expect(threadSessionKey("slack:C1:1.0")).toBe("slack:C1:1.0:@thread");
    expect(SESSION_KEY_PATTERN.test(threadSessionKey("slack:C1:1.0"))).toBe(true);
    // No agent id starts with `@`, so `sessionKey` never produces the thread session's name.
    expect(threadSessionKey("slack:C1:1.0")).not.toBe(sessionKey("slack:C1:1.0", "thread"));
  });

  it("a unit's lanes continue one working session across rounds: every coding round of the unit derives the same key, the review lane its own", () => {
    const instance = { id: "plan-the-one-door" };
    const round1 = workingSessionKey(instance, "U16", "coding");
    const round2 = workingSessionKey(instance, "U16", "coding");
    const round3 = workingSessionKey(instance, "U16", "coding");
    expect(round1).toBe("plan-the-one-door:U16:coding");
    expect(round2).toBe(round1);
    expect(round3).toBe(round1);
    expect(workingSessionKey(instance, "U16", "review")).toBe("plan-the-one-door:U16:review");
    expect(SESSION_KEY_PATTERN.test(round1)).toBe(true);
  });

  it("a re-issue of the same plan continues the prior instance's lanes: the attempt suffix is stripped", () => {
    const first = workingSessionKey({ id: "plan-x" }, "U16", "coding");
    const reissue = workingSessionKey({ id: "plan-x-2", attempt: 2 }, "U16", "coding");
    expect(reissue).toBe(first);
    // An id that does not carry the attempt suffix (trimmed differently) is kept as it is.
    expect(workingSessionKey({ id: "plan-y", attempt: 2 }, "U16", "review")).toBe("plan-y:U16:review");
  });
});

describe("connectorRowId and shipUnitRowId — the keyed append's identities (item 13)", () => {
  it("an edited message appends a second row: the edit stamp changes the id, a re-delivered unedited message does not", () => {
    const original = connectorRowId("slack:C1:2.0");
    expect(connectorRowId("slack:C1:2.0")).toBe(original);
    const edited = connectorRowId("slack:C1:2.0", "3.0");
    expect(edited).not.toBe(original);
    expect(connectorRowId("slack:C1:2.0", "3.0")).toBe(edited);
  });

  it("a fold's row id is the ship_unit event's identity, so the same event read twice folds one row", () => {
    const id = shipUnitRowId({ unit: "U16", state: "started", seq: 4 });
    expect(id).toBe("ship-unit:U16:started:4");
    expect(shipUnitRowId({ unit: "U16", state: "started", seq: 4 })).toBe(id);
    expect(shipUnitRowId({ unit: "U16", state: "coded", seq: 9 })).not.toBe(id);
    // A unit reopened at a second segment repeats a state under a new seq:
    // two distinct events, two distinct ids — the second fold is not dropped.
    expect(shipUnitRowId({ unit: "U16", state: "started", seq: 20 })).not.toBe(id);
  });
});

describe("storedTurnRow — a thread-session row and its marks (item 13)", () => {
  it("a silent reply is the person's turn marked silent; a fold is marked folded; an ordinary turn carries neither", () => {
    const silent = storedTurnRow({ role: "user", text: "ship it", actor: "slack:UALICE", silent: true });
    expect(silentOfStoredRow(silent)).toBe(true);
    expect(foldedOfStoredRow(silent)).toBe(false);
    expect(actorOfStoredRow(silent)).toBe("slack:UALICE");
    expect(textOfStoredRow(silent)).toBe("ship it");
    const fold = storedTurnRow({ role: "assistant", text: "the unit started", folded: true });
    expect(foldedOfStoredRow(fold)).toBe(true);
    expect(silentOfStoredRow(fold)).toBe(false);
    const plain = storedTurnRow({ role: "user", text: "hello" });
    expect(silentOfStoredRow(plain)).toBe(false);
    expect(foldedOfStoredRow(plain)).toBe(false);
    expect(silentOfStoredRow("not json")).toBe(false);
  });
});

describe("migrationOrder — old per-agent logs read once into the thread session (item 13)", () => {
  it("a thread with two agents' logs migrates in the order of their runs' start times, each run's rows in index order, rows outside any range after the runs before them", () => {
    const runs = [
      { key: "t:coding", startedAt: 1_000, range: { from: 0, to: 2 } },
      { key: "t:review", startedAt: 2_000, range: { from: 0, to: 1 } },
      { key: "t:coding", startedAt: 3_000, range: { from: 3, to: 4 } },
    ];
    const logs = [
      { key: "t:coding", rows: [0, 1, 2, 3, 4, 5] }, // 5 is outside every range: after the runs before it
      { key: "t:review", rows: [0, 1, 2] }, // 2 is outside: after the review run
    ];
    expect(migrationOrder(runs, logs)).toEqual([
      { key: "t:coding", idx: 0 },
      { key: "t:coding", idx: 1 },
      { key: "t:coding", idx: 2 },
      { key: "t:review", idx: 0 },
      { key: "t:review", idx: 1 },
      { key: "t:review", idx: 2 },
      { key: "t:coding", idx: 3 },
      { key: "t:coding", idx: 4 },
      { key: "t:coding", idx: 5 },
    ]);
  });

  it("a row before any run of its log comes first, and the migration's row ids are stable so the read-once replay appends nothing twice", () => {
    const runs = [{ key: "t:coding", startedAt: 1_000, range: { from: 1, to: 1 } }];
    const logs = [{ key: "t:coding", rows: [0, 1] }];
    expect(migrationOrder(runs, logs)).toEqual([
      { key: "t:coding", idx: 0 },
      { key: "t:coding", idx: 1 },
    ]);
    expect(migrationRowId("t:coding", 0)).toBe(migrationRowId("t:coding", 0));
    expect(migrationRowId("t:coding", 0)).not.toBe(migrationRowId("t:coding", 1));
    expect(migrationRowId("t:coding", 0)).not.toBe(migrationRowId("t:review", 0));
  });
});
