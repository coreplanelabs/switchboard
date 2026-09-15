// The session tools (docs/reference/specs/session-log.md item 10; record 0035,
// "Recall" and "The notepad"): what lets a run reach past its window. `recall`
// searches the caller's own session log — the full-text index over every turn
// of this thread and agent, earlier runs' included — in relevance order with
// turn indices, or reads one turn whole; `notes` replaces the session's notepad
// whole, the one thing sure to survive a compaction and reach the next run,
// and reads it back. Both read under the requester's `runs:read` on the run
// itself, as `get_run_status` does: a read the requester may not make is
// empty, never an error, and existence is never revealed.
//
// The capability is built by the dispatcher for a run with a session (its
// place in the log off the ledger row) over the write-through's session reads
// and its notepad write under this generation; without one — an untracked run,
// a ship pipeline, a process with no ledger — the tools say they are not
// available.
import type { ChatMessage } from "../providers/types.js";
import { authorize } from "../core/authz/authorize.js";
import { redactSecrets } from "../core/runEvents.js";
import { NOTEPAD_MAX_BYTES } from "../core/runLedger/sessionLog.js";
import type { FenceResult, Notepad, SessionHit } from "../core/runLedger/types.js";
import type { LedgerRun, LedgerWriteThrough } from "../core/runLedger/writeThrough.js";
import type { RunSession } from "../core/runRecord.js";
import { utf8ByteLength } from "../core/runRecord.js";
import { runResource } from "../core/runsService.js";
import type { RunnableTool, ToolContext } from "./workspace.js";

/** A run's reach into its own session log, as the dispatcher builds it. */
export interface SessionCapability {
  /** The run's place in the log: the key, where its seed began, its request, its range. */
  session: RunSession;
  search(query: string, limit: number): Promise<{ hits: SessionHit[]; gaps: number[] }>;
  /** One turn whole by its log index, or undefined when the log has none there. */
  readTurn(idx: number): Promise<ChatMessage | undefined>;
  readNotepad(): Promise<Notepad | null>;
  writeNotepad(text: string): Promise<FenceResult>;
}

/** The capability for a run with a session, over the write-through; nothing
 *  for a run without one. */
export function sessionCapabilityFor(
  run: Pick<LedgerRun, "session"> | undefined,
  ledger: Pick<LedgerWriteThrough, "readSession" | "searchSession" | "readNotepad" | "writeNotepad">,
): SessionCapability | undefined {
  const session = run?.session;
  if (!session) return undefined;
  return {
    session,
    search: (query, limit) => ledger.searchSession(session.key, query, limit),
    readTurn: async (idx) => (await ledger.readSession(session.key, idx, idx)).messages[0],
    readNotepad: () => ledger.readNotepad(session.key),
    writeNotepad: (text) => ledger.writeNotepad(session.key, text),
  };
}

const UNAVAILABLE = "the session tools are not available in this context: this run has no session log.";
const DEFAULT_HITS = 5;
const MAX_HITS = 50;
const SNIPPET_CHARS = 300;

/** Whether the requester may read this run — the same `runs:read` point read
 *  `get_run_status` makes on a run; without the reads' capability the answer
 *  is no, since nothing says who is asking. */
async function mayRead(ctx: ToolContext): Promise<boolean> {
  if (!ctx.runs?.runId) return false;
  const res = await ctx.runs.service.getRun(ctx.runs.runId);
  return res.ok && authorize(ctx.runs.actor, "runs:read", runResource(res.value)).allow;
}

const snippetOf = (text: string): string => {
  const line = text.replace(/\s+/g, " ").trim();
  return line.length > SNIPPET_CHARS ? `${line.slice(0, SNIPPET_CHARS - 1)}…` : line;
};

export const recallTool: RunnableTool = {
  name: "recall",
  description:
    "Search this conversation's whole log — every turn of this thread on this agent, earlier runs' included and " +
    "everything a compaction removed from your window — for words, and get the matching turns in relevance order " +
    "with their turn numbers and a snippet; or pass `turn` to read one turn whole (a tool result, a command, a " +
    "message). Use it when you need something said or seen earlier that is not in front of you: a failing test's " +
    "name, a command's output, a decision. `limit` defaults to 5 (at most 50).",
  inputSchema: {
    type: "object",
    properties: {
      query: { type: "string", description: "Words to search for; matching is by word, in relevance order" },
      limit: { type: "integer", description: "How many turns to return (default 5, at most 50)" },
      turn: {
        type: "integer",
        description: "A turn number from an earlier recall: returns that turn whole instead of searching",
      },
    },
  },
  sideEffectFree: true,
  async run(input, ctx) {
    if (!ctx.session) return UNAVAILABLE;
    const turn = typeof input.turn === "number" ? Math.trunc(input.turn) : undefined;
    const query = typeof input.query === "string" ? input.query.trim() : "";
    if (turn === undefined && query.length === 0) return "recall needs a query or a turn number.";
    if (!(await mayRead(ctx))) return JSON.stringify(turn !== undefined ? { turn, content: null } : { hits: [] });
    if (turn !== undefined) {
      const message = turn >= 0 ? await ctx.session.readTurn(turn) : undefined;
      if (!message) return `no turn ${turn} in this session's log.`;
      return JSON.stringify({ turn, role: message.role, content: message.content });
    }
    const limit = Math.min(
      MAX_HITS,
      Math.max(1, typeof input.limit === "number" ? Math.trunc(input.limit) : DEFAULT_HITS),
    );
    const { hits, gaps } = await ctx.session.search(query, limit);
    const notes: string[] = [];
    if (hits.length === 0)
      notes.push("no turn of this session's log matches; your notes (notes {}) may hold what you look for");
    if (ctx.session.session.seedFrom === 0) notes.push("this is the first run of its session: the log begins with it");
    return JSON.stringify({
      hits: hits.map((h) => ({
        turn: h.idx,
        ...(h.role !== undefined ? { role: h.role } : {}),
        snippet: snippetOf(h.text),
      })),
      ...(gaps.length
        ? {
            gaps: `the log has a gap at ${gaps.map((g) => `turn ${g}`).join(", ")}: a run before it detached from the ledger, so turns it saw after that point are not here`,
          }
        : {}),
      ...(notes.length ? { note: notes.join("; ") } : {}),
    });
  },
};

export const notesTool: RunnableTool = {
  name: "notes",
  description:
    "Your notes for this thread — one document, replaced whole on every write, at most 8 KiB. Keep in it what " +
    "must survive a compaction and reach the next run in this thread: decisions and their reasons, the names of " +
    "things you found (files, tests, commits), what is not yet proven. They ride your system prompt at the start " +
    "of every later run and reach you again right after a compaction. Call with `text` to write; with nothing to read.",
  inputSchema: {
    type: "object",
    properties: { text: { type: "string", description: "The whole notepad as it should read from now on" } },
  },
  async run(input, ctx) {
    if (!ctx.session) return UNAVAILABLE;
    if (typeof input.text !== "string") {
      const current = await ctx.session.readNotepad();
      return current && current.text.length > 0 ? current.text : "(your notes for this thread are empty)";
    }
    const bytes = utf8ByteLength(input.text);
    if (bytes > NOTEPAD_MAX_BYTES)
      return `your notes are ${bytes} bytes; the notepad holds at most ${NOTEPAD_MAX_BYTES} — shorten them and write again.`;
    const written = await ctx.session.writeNotepad(input.text);
    if (!written.ok) return `notes not saved (${written.reason}): another generation drives this run now.`;
    // Redacted like every narrative event on the record; the notepad itself is the session's.
    ctx.publish?.({ type: "notes", text: redactSecrets(input.text) });
    return `notes saved (${bytes} bytes); they ride your system prompt at the next run in this thread and reach you again after a compaction.`;
  },
};

/** The two session tools, in the order the toolsets list them. */
export const SESSION_TOOLS: readonly RunnableTool[] = [recallTool, notesTool];
