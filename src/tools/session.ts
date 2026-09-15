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
import type { ChatMessage } from "../core/chatMessage.js";
import { safeBasename } from "../artifacts/keys.js";
import { authorize } from "../core/authz/authorize.js";
import { whereIs, type ThreadAsset } from "../core/dispatch/threadAssets.js";
import { redactSecrets } from "../core/runEvents.js";
import { NOTEPAD_MAX_BYTES, SEARCH_MAX_HITS, snippetOf } from "../core/runLedger/sessionLog.js";
import type { FenceResult, Notepad, SessionHit } from "../core/runLedger/types.js";
import type { LedgerRun, LedgerWriteThrough } from "../core/runLedger/writeThrough.js";
import type { RunSession } from "../core/runRecord.js";
import { utf8ByteLength } from "../core/runRecord.js";
import { runResource } from "../core/runsService.js";
import type { RunnableTool, ToolContext } from "./runnableTool.js";

/** A run's reach into its own session log, as the dispatcher builds it. */
export interface SessionCapability {
  /** The run's place in the log: the key, where its seed began, its request, its range. */
  session: RunSession;
  search(query: string, limit: number): Promise<{ hits: SessionHit[]; gaps: number[] }>;
  /** One turn whole by its log index, or undefined when the log has none there. */
  readTurn(idx: number): Promise<ChatMessage | undefined>;
  /** The run's conversation as its log holds it: every row from where its seed
   *  began to the log's tail: the seed, then each step mirrored so far. What
   *  a run on the pi harness offers `spawn_run` as the child's seed
   *  (docs/reference/specs/agent-conductor.md item 3); a log that stops at a
   *  gap gives the turns before it. */
  readConversation(): Promise<ChatMessage[]>;
  readNotepad(): Promise<Notepad | null>;
  writeNotepad(text: string): Promise<FenceResult>;
  /** The thread's files (record 0033): the catalogue its runs' records name —
   *  received and produced, held by the store or not — read fresh on each call
   *  so a file this run just received or attached is in it. Absent without a store. */
  assets?: () => Promise<ThreadAsset[]>;
  /** Where a file sits in THIS run's workspace when this run staged it
   *  (`attachments/<index>-<basename>`); nothing for a file it did not pull. */
  workspacePathOf?: (key: string) => string | undefined;
}

/** The thread's files as the dispatcher hands them to the capability: the
 *  catalogue read and this run's workspace paths (`WorkspaceFiles`). */
export interface SessionAssets {
  read: () => Promise<ThreadAsset[]>;
  pathOf: (key: string) => string | undefined;
}

/** The capability for a run with a session, over the write-through; nothing
 *  for a run without one. The thread's files join it when the deployment has
 *  an artifact store. */
export function sessionCapabilityFor(
  run: Pick<LedgerRun, "session"> | undefined,
  ledger: Pick<LedgerWriteThrough, "readSession" | "searchSession" | "readNotepad" | "writeNotepad">,
  assets?: SessionAssets,
): SessionCapability | undefined {
  const session = run?.session;
  if (!session) return undefined;
  return {
    session,
    search: (query, limit) => ledger.searchSession(session.key, query, limit),
    readTurn: async (idx) => (await ledger.readSession(session.key, idx, idx)).messages[0],
    readConversation: async () => (await ledger.readSession(session.key, session.seedFrom)).messages,
    readNotepad: () => ledger.readNotepad(session.key),
    writeNotepad: (text) => ledger.writeNotepad(session.key, text),
    ...(assets ? { assets: assets.read, workspacePathOf: assets.pathOf } : {}),
  };
}

/** One file as `recall` answers it: what it is, which run recorded it, its key
 *  and where it is for this run — the same clause the prompt's list carries. */
function assetView(asset: ThreadAsset, path: string | undefined) {
  return {
    name: asset.name,
    size: asset.size,
    type: asset.contentType,
    [asset.direction === "in" ? "received" : "produced"]: `run ${asset.runId}`,
    key: asset.key,
    where: whereIs(asset, path),
  };
}

/** A turn that can name one of the thread's files: the attachments line a
 *  staged turn ends with, or an `attach_file` call. Only such hits pay the
 *  catalogue read. */
const FILE_BEARING = /attachments\/|attach_file|attached files/i;

/** The files a turn's text names, resolved against the catalogue by name at a
 *  word boundary — `2-clip.mp4` in an attachments line names `clip.mp4`,
 *  `myclip.mp4` does not — under the file's name as the person saw it and as
 *  the workspace spells it (`safeBasename`). */
export function filesNamedIn(text: string, catalogue: readonly ThreadAsset[]): ThreadAsset[] {
  return catalogue.filter((a) => [a.name, safeBasename(a.name)].some((n) => nameAt(n).test(text)));
}
const nameAt = (name: string): RegExp =>
  new RegExp(`(?<![A-Za-z0-9._])${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![A-Za-z0-9._-])`);

const UNAVAILABLE = "the session tools are not available in this context: this run has no session log.";
const DEFAULT_HITS = 5;
const MAX_HITS = SEARCH_MAX_HITS;

/** Whether the requester may read this run — the same `runs:read` point read
 *  `get_run_status` makes on a run; without the reads' capability the answer
 *  is no, since nothing says who is asking. */
async function mayRead(ctx: ToolContext): Promise<boolean> {
  if (!ctx.runs?.runId) return false;
  const res = await ctx.runs.service.getRun(ctx.runs.runId);
  return res.ok && authorize(ctx.runs.actor, "runs:read", runResource(res.value)).allow;
}

export const recallTool: RunnableTool = {
  name: "recall",
  description:
    "Search this conversation's whole log — every turn of this thread on this agent, earlier runs' included and " +
    "everything a compaction removed from your window — for words, and get the matching turns in relevance order " +
    "with their turn numbers and a snippet; or pass `turn` to read one turn whole (a tool result, a command, a " +
    "message). Use it when you need something said or seen earlier that is not in front of you: a failing test's " +
    "name, a command's output, a decision. `limit` defaults to 5 (at most 50). A hit that names a file of this " +
    "thread carries the file's key and where it is for this run; `assets: true` lists every file the thread " +
    "received or its runs produced instead of searching.",
  inputSchema: {
    type: "object",
    properties: {
      query: { type: "string", description: "Words to search for; matching is by word, in relevance order" },
      limit: { type: "integer", description: "How many turns to return (default 5, at most 50)" },
      turn: {
        type: "integer",
        description: "A turn number from an earlier recall: returns that turn whole instead of searching",
      },
      assets: {
        type: "boolean",
        description:
          "List the thread's files — received on its messages or produced by its runs — with their keys and where each is for this run, instead of searching",
      },
    },
  },
  sideEffectFree: true,
  async run(input, ctx) {
    if (!ctx.session) return UNAVAILABLE;
    const turn = typeof input.turn === "number" ? Math.trunc(input.turn) : undefined;
    const query = typeof input.query === "string" ? input.query.trim() : "";
    const listAssets = input.assets === true;
    if (turn === undefined && query.length === 0 && !listAssets)
      return "recall needs a query, a turn number or assets: true.";
    if (!(await mayRead(ctx))) {
      return JSON.stringify(turn !== undefined ? { turn, content: null } : listAssets ? { assets: [] } : { hits: [] });
    }
    if (turn !== undefined) {
      const message = turn >= 0 ? await ctx.session.readTurn(turn) : undefined;
      if (!message) return `no turn ${turn} in this session's log.`;
      return JSON.stringify({ turn, role: message.role, content: message.content });
    }
    if (listAssets) {
      if (!ctx.session.assets) {
        return JSON.stringify({
          assets: [],
          note: "this deployment has no artifact store: the thread's files are not catalogued",
        });
      }
      const assets = await ctx.session.assets();
      return JSON.stringify({
        assets: assets.map((a) => assetView(a, ctx.session!.workspacePathOf?.(a.key))),
        ...(assets.length === 0 ? { note: "no run of this thread has received or produced a file" } : {}),
      });
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
    // A hit that names one of the thread's files — an attachments line, an
    // attach_file call — carries the file's key and where it is for this run;
    // the catalogue is read only when some hit can name one.
    const catalogue =
      ctx.session.assets && hits.some((h) => FILE_BEARING.test(h.text)) ? await ctx.session.assets() : [];
    return JSON.stringify({
      hits: hits.map((h) => {
        const files = filesNamedIn(h.text, catalogue);
        return {
          turn: h.idx,
          ...(h.role !== undefined ? { role: h.role } : {}),
          snippet: snippetOf(h.text),
          ...(files.length > 0 ? { files: files.map((a) => assetView(a, ctx.session!.workspacePathOf?.(a.key))) } : {}),
        };
      }),
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
    "Your notes for this thread — one Markdown document, replaced whole on every write, at most 8 KiB. Keep in it " +
    "what must survive a compaction and reach the next run in this thread: decisions and their reasons, the names " +
    "of things you found (files, tests, commits), what is not yet proven. A person reads them on the run's page: " +
    "a `##` heading per section (Done, In progress, Next, Facts), one bullet per item, never one paragraph. They " +
    "ride your system prompt at the start of every later run and reach you again right after a compaction. Call " +
    "with `text` to write; with nothing to read.",
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
