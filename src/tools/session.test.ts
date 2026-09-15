import { describe, expect, it, vi } from "vitest";
import type { ChatMessage } from "../providers/types.js";
import type { RunEvent } from "../core/runEvents.js";
import { NOTEPAD_MAX_BYTES } from "../core/runLedger/sessionLog.js";
import type { FenceResult, Notepad, SessionHit } from "../core/runLedger/types.js";
import type { RunsService, RunView } from "../core/runsService.js";
import type { Actor } from "../core/authz/types.js";
import type { ToolContext } from "./workspace.js";
import { notesTool, recallTool, SESSION_TOOLS, sessionCapabilityFor, type SessionCapability } from "./session.js";

// docs/reference/specs/session-log.md item 10 (record 0035, "Recall" and "The
// notepad"): `recall` searches the caller's own session log in relevance order
// with turn indices, or reads one turn whole; `notes` replaces the notepad
// whole up to 8 KiB and reads it back; both under the requester's `runs:read`.

const view: RunView = {
  id: "run-1",
  agent: "coding",
  channelId: "slack:C1",
  userId: "slack:UALICE",
  threadKey: "slack:C1:1.0",
  channelVisibility: "public",
  startedAt: 1_000,
  finished: false,
  eventCount: 0,
};
/** A member of `slack:C1` who may read runs: her own thread's run is hers to recall; a private group she is not in is not. */
const alice: Actor = {
  kind: "user",
  id: "slack:UALICE",
  grants: { actions: new Set(["runs:read"]), channels: new Set(["slack:C1"]), repos: new Set() },
};
const service = (v: RunView = view) =>
  ({
    getRun: async (id: string) => (id === v.id ? { ok: true, value: v } : { ok: false, error: "not_found" }),
  }) as unknown as RunsService;

const say = (text: string): ChatMessage => ({ role: "user", content: [{ type: "text", text }] });
const called = (id: string, command: string): ChatMessage => ({
  role: "assistant",
  content: [{ type: "tool_use", id, name: "bash", input: { command } }],
});

/** A capability over a scripted log: three turns, a notepad, a write that records. */
function capability(
  over: {
    seedFrom?: number;
    hits?: SessionHit[];
    gaps?: number[];
    turns?: Record<number, ChatMessage>;
    notepad?: Notepad | null;
    write?: FenceResult;
  } = {},
) {
  const writes: string[] = [];
  const cap: SessionCapability = {
    session: { key: "slack:C1:1.0:coding", seedFrom: over.seedFrom ?? 0, request: 2, range: { from: 3 } },
    search: vi.fn(async () => ({ hits: over.hits ?? [], gaps: over.gaps ?? [] })),
    readTurn: vi.fn(async (idx: number) => over.turns?.[idx]),
    readNotepad: vi.fn(async () => over.notepad ?? null),
    writeNotepad: vi.fn(async (text: string): Promise<FenceResult> => {
      writes.push(text);
      return over.write ?? { ok: true };
    }),
  };
  return { cap, writes };
}

const ctxWith = (cap: SessionCapability | undefined, over: Partial<ToolContext> = {}): ToolContext =>
  ({
    executor: {} as ToolContext["executor"],
    runs: { service: service(), actor: alice, runId: "run-1" },
    ...(cap ? { session: cap } : {}),
    ...over,
  }) as ToolContext;

describe("recall — the caller's own session log", () => {
  it("searches in relevance order and answers each hit's turn, role and a snippet, and the gaps a search straddles", async () => {
    const { cap } = capability({
      hits: [
        {
          idx: 7,
          part: 0,
          role: "user",
          kind: "tool_result",
          text: "FAIL src/x.test.ts > helper_names_it\n".repeat(20),
        },
        { idx: 2, part: 0, role: "assistant", kind: "text", text: "I renamed the helper" },
      ],
      gaps: [5],
    });
    const out = JSON.parse(String(await recallTool.run({ query: "helper_names_it", limit: 2 }, ctxWith(cap)))) as {
      hits: Array<{ turn: number; role: string; snippet: string }>;
      gaps: string;
    };
    expect(cap.search).toHaveBeenCalledWith("helper_names_it", 2);
    expect(out.hits.map((h) => [h.turn, h.role])).toEqual([
      [7, "user"],
      [2, "assistant"],
    ]);
    expect(out.hits[0].snippet.length).toBeLessThanOrEqual(300);
    expect(out.hits[0].snippet).not.toContain("\n");
    expect(out.gaps).toContain("turn 5");
  });

  it("the default limit is five; a query with no hit says so and points at the notepad; a first run is told the log begins with it", async () => {
    const first = capability({ seedFrom: 0 });
    const out = JSON.parse(String(await recallTool.run({ query: "nothing here" }, ctxWith(first.cap)))) as {
      hits: unknown[];
      note: string;
    };
    expect(first.cap.search).toHaveBeenCalledWith("nothing here", 5);
    expect(out.hits).toEqual([]);
    expect(out.note).toContain("no turn");
    expect(out.note).toContain("notes");
    expect(out.note).toContain("first run of its session");
    const later = capability({ seedFrom: 40 });
    const again = JSON.parse(String(await recallTool.run({ query: "nothing" }, ctxWith(later.cap)))) as {
      note: string;
    };
    expect(again.note).not.toContain("first run");
  });

  it("reads one turn whole by its index — every part, the role named — and names a turn the log does not have", async () => {
    const { cap } = capability({ turns: { 12: called("c9", "npm test -- x.test.ts") } });
    const out = JSON.parse(String(await recallTool.run({ turn: 12 }, ctxWith(cap)))) as {
      turn: number;
      role: string;
      content: unknown[];
    };
    expect(cap.readTurn).toHaveBeenCalledWith(12);
    expect(out).toMatchObject({ turn: 12, role: "assistant" });
    expect(JSON.stringify(out.content)).toContain("npm test -- x.test.ts");
    expect(String(await recallTool.run({ turn: 99 }, ctxWith(cap)))).toContain("no turn 99");
  });

  it("a read the requester may not make is empty, never an error; without the capability the tool says it is not available; a call naming neither query nor turn is refused by name", async () => {
    const { cap } = capability({ hits: [{ idx: 1, part: 0, role: "user", kind: "text", text: "secret" }] });
    // Another person's run in a private group she is not in: neither a member nor herself.
    const denied = ctxWith(cap, {
      runs: {
        service: service({ ...view, userId: "slack:UBOB", channelId: "slack:G_PRIV", channelVisibility: "private" }),
        actor: alice,
        runId: "run-1",
      },
    });
    expect(JSON.parse(String(await recallTool.run({ query: "secret" }, denied)))).toMatchObject({ hits: [] });
    expect(cap.search).not.toHaveBeenCalled();
    expect(String(await recallTool.run({ query: "x" }, ctxWith(undefined)))).toContain("not available");
    expect(String(await recallTool.run({}, ctxWith(cap)))).toContain("a query or a turn");
  });

  it("is side-effect free; notes is not; both are the session toolset", () => {
    expect(recallTool.sideEffectFree).toBe(true);
    expect(notesTool.sideEffectFree).toBeUndefined();
    expect(SESSION_TOOLS.map((t) => t.name)).toEqual(["recall", "notes"]);
  });
});

describe("notes — the agent's notepad for this thread", () => {
  it("replaces the notepad whole, says the size, and publishes the text as a notes event", async () => {
    const { cap, writes } = capability();
    const published: RunEvent[] = [];
    const out = String(
      await notesTool.run(
        { text: "decided: keep the helper; head green at abc123" },
        ctxWith(cap, { publish: (e) => void published.push(e) }),
      ),
    );
    expect(writes).toEqual(["decided: keep the helper; head green at abc123"]);
    expect(out).toContain("saved");
    expect(out).toContain("46 bytes");
    expect(published).toEqual([{ type: "notes", text: "decided: keep the helper; head green at abc123" }]);
  });

  it("the notes event is redacted like every narrative event on the record; the notepad itself keeps the text as written", async () => {
    const { cap, writes } = capability();
    const published: RunEvent[] = [];
    const text = "the proxy key is sk-ant-abcdefghijklmnopqrstuv, keep it out of the PR";
    await notesTool.run({ text }, ctxWith(cap, { publish: (e) => void published.push(e) }));
    expect(writes).toEqual([text]);
    expect(published).toEqual([
      { type: "notes", text: "the proxy key is «redacted-anthropic-key», keep it out of the PR" },
    ]);
  });

  it("refuses over 8 KiB naming the size, and writes nothing", async () => {
    const { cap, writes } = capability();
    const out = String(await notesTool.run({ text: "x".repeat(NOTEPAD_MAX_BYTES + 1) }, ctxWith(cap)));
    expect(out).toContain(`${NOTEPAD_MAX_BYTES + 1} bytes`);
    expect(out).toContain(String(NOTEPAD_MAX_BYTES));
    expect(writes).toEqual([]);
  });

  it("reads the notepad back, and says when it is empty; a fenced write says the notes were not saved", async () => {
    const empty = capability();
    expect(String(await notesTool.run({}, ctxWith(empty.cap)))).toContain("empty");
    const kept = capability({ notepad: { text: "keep the helper", updatedAt: 5_000 } });
    expect(String(await notesTool.run({}, ctxWith(kept.cap)))).toBe("keep the helper");
    const fenced = capability({ write: { ok: false, reason: "fenced" } });
    expect(String(await notesTool.run({ text: "late" }, ctxWith(fenced.cap)))).toContain("not saved");
    expect(String(await notesTool.run({ text: "x" }, ctxWith(undefined)))).toContain("not available");
  });
});

describe("sessionCapabilityFor — the capability the dispatcher builds for a run with a session", () => {
  it("wraps the run's session and the write-through's session reads and the notepad write; nothing for a run without a session", async () => {
    const wt = {
      readSession: vi.fn(async () => ({
        complete: true as const,
        turns: 1,
        messages: [say("turn 4")],
        compactions: [],
      })),
      searchSession: vi.fn(async () => ({ hits: [], gaps: [] })),
      readNotepad: vi.fn(async () => null),
      writeNotepad: vi.fn(async () => ({ ok: true as const })),
    };
    const session = { key: "slack:C1:1.0:coding", seedFrom: 2, request: 4, range: { from: 5 } };
    const cap = sessionCapabilityFor({ session }, wt)!;
    expect(cap.session).toEqual(session);
    expect(await cap.readTurn(4)).toEqual(say("turn 4"));
    expect(wt.readSession).toHaveBeenCalledWith("slack:C1:1.0:coding", 4, 4);
    await cap.search("x", 3);
    expect(wt.searchSession).toHaveBeenCalledWith("slack:C1:1.0:coding", "x", 3);
    await cap.writeNotepad("n");
    expect(wt.writeNotepad).toHaveBeenCalledWith("slack:C1:1.0:coding", "n");
    expect(sessionCapabilityFor({ session: undefined }, wt)).toBeUndefined();
    expect(sessionCapabilityFor(undefined, wt)).toBeUndefined();
  });
});
