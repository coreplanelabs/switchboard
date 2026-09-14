// The session log's pure rules (docs/decisions/0035-a-session-log-outlives-its-runs-compaction-is-a-pointer.md;
// docs/reference/specs/session-log.md): one log per thread and agent holds the
// transcript rows of every run of the session, each run a range of it. This
// file is node-free — the bot and `deploy/cloudflare-memory/worker.ts` import
// it alike — and holds what both sides must agree on: the object's name, the
// text the full-text index sees for a row, the byte policy's choice of what to
// drop, the tail cut a follow-up seeds from, and the sweep's drop decision.

import type { ChatMessage, ContentPart } from "../../providers/types.js";
import { DEFAULT_RETENTION_POLICY, utf8ByteLength } from "../runRecord.js";
import type { StoredRow } from "./transcript.js";

export { isRunSession, SESSION_KEY_PATTERN, type RunSession } from "../runRecord.js";

/** The byte policy's default: `RetentionPolicy.sessionLogMaxBytes`. */
export const DEFAULT_SESSION_LOG_MAX_BYTES = DEFAULT_RETENTION_POLICY.sessionLogMaxBytes;

/** The object's name: the thread and the agent, the pair record 0034 calls a
 *  session. A run without a resolved agent keys on a dash so the name still
 *  has both halves. */
export function sessionKey(threadKey: string, agent: string | undefined): string {
  return `${threadKey}:${agent ?? "-"}`;
}

/** The request is the seed's last user turn (`splitSeed` reads the seed the
 *  same way); a seed with no user turn — or no turns — puts its first row there. */
export function requestIndex(seed: readonly ChatMessage[]): number {
  for (let i = seed.length - 1; i >= 0; i--) if (seed[i].role === "user") return i;
  return 0;
}

export type RowKind = "text" | "tool_result" | "tool_use" | "attachment" | "compaction" | "other";

function parseStored(json: string): StoredRow | undefined {
  try {
    const v = JSON.parse(json) as unknown;
    return typeof v === "object" && v !== null ? (v as StoredRow) : undefined;
  } catch {
    return undefined;
  }
}

/** What a stored row holds, for the byte policy (only a `tool_result` is
 *  replaceable) and the index (only text kinds carry text). */
export function rowKind(json: string): RowKind {
  const stored = parseStored(json);
  if (!stored) return "other";
  if ("compaction" in stored) return "compaction";
  const type = (stored.part as { type?: unknown }).type;
  switch (type) {
    case "text":
      return "text";
    case "tool_result":
      return "tool_result";
    case "tool_use":
      return "tool_use";
    case "image":
    case "document":
      return "attachment";
    default:
      return "other";
  }
}

const textOfResultContent = (content: unknown): string => {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((c): c is { type: "text"; text: string } => typeof c === "object" && c !== null && c.type === "text")
    .map((c) => c.text)
    .join("\n");
};

/** The text the full-text index holds for a row: a text part's text, a tool
 *  result's text (the failing test's name in a vitest report is findable), a
 *  tool call's name and arguments (a command is findable), a compaction row's
 *  summary; an attachment, a thinking block or an unreadable row index nothing. */
export function textOfStoredRow(json: string): string {
  const stored = parseStored(json);
  if (!stored) return "";
  if ("compaction" in stored) return typeof stored.compaction?.summary === "string" ? stored.compaction.summary : "";
  const part = stored.part as ContentPart | undefined;
  if (!part) return "";
  switch (part.type) {
    case "text":
      return part.text;
    case "tool_result":
      return textOfResultContent(part.content);
    case "tool_use":
      return `${part.name} ${JSON.stringify(part.input ?? {})}`;
    default:
      return "";
  }
}

/** The run record keeps this much of a tool's output; the marker says so. */
const RECORD_TOOL_OUTPUT_CHARS = "8,000 characters";

/** The row that replaces a tool result the byte policy drops: the same role
 *  and call id (the model's `tool_use` keeps its result, so the conversation
 *  stays valid), the error flag, and a text naming what went and where the
 *  rest still is. Undefined for any row that is not a tool result — user and
 *  assistant text are never dropped. */
export function droppedToolResultRow(json: string): string | undefined {
  const stored = parseStored(json);
  if (!stored || "compaction" in stored) return undefined;
  const part = stored.part as ContentPart | undefined;
  if (!part || part.type !== "tool_result") return undefined;
  const marker: ContentPart = {
    type: "tool_result",
    toolUseId: part.toolUseId,
    content: `[session log: this tool result (${utf8ByteLength(json)} bytes) was dropped to keep the session under its byte policy; the run record keeps its first ${RECORD_TOOL_OUTPUT_CHARS}]`,
    ...(part.isError === true ? { isError: true } : {}),
  };
  return JSON.stringify({ role: stored.role, part: marker });
}

export interface TrimCandidate {
  id: number;
  bytes: number;
}

/** Which tool-result rows the byte policy replaces once a log is `excess`
 *  bytes over its budget: the oldest first (the caller passes them oldest
 *  first), each freeing its bytes less the marker's, until the excess is
 *  covered or the candidates run out — never a user or assistant text row,
 *  which are not candidates. */
export function planSessionTrim(candidates: readonly TrimCandidate[], excess: number, markerBytes: number): number[] {
  const ids: number[] = [];
  let freed = 0;
  for (const c of candidates) {
    if (freed >= excess) break;
    const gain = c.bytes - markerBytes;
    if (gain <= 0) continue;
    ids.push(c.id);
    freed += gain;
  }
  return ids;
}

export interface TailRow {
  idx: number;
  bytes: number;
}

/** The tail a follow-up seeds from: walking the rows newest first, the first
 *  index of the oldest turn that still fits `maxBytes` with every newer turn
 *  — whole turns only, so no tool call is parted from its result. Undefined
 *  when even the newest turn is over the budget, or the log is empty. */
export function tailCut(rowsNewestFirst: readonly TailRow[], maxBytes: number): number | undefined {
  let total = 0;
  let from: number | undefined;
  let i = 0;
  while (i < rowsNewestFirst.length) {
    const idx = rowsNewestFirst[i].idx;
    let turnBytes = 0;
    let j = i;
    while (j < rowsNewestFirst.length && rowsNewestFirst[j].idx === idx) turnBytes += rowsNewestFirst[j++].bytes;
    if (total + turnBytes > maxBytes) break;
    total += turnBytes;
    from = idx;
    i = j;
  }
  return from;
}

/** What the sweep re-reads about one candidate right before dropping it
 *  (session-log item 7): whether a kept run record names the session, and
 *  whether any run is live on its thread. */
export interface DropCandidate {
  key: string;
  hasKeptRun: boolean;
  threadLive: boolean;
}

export type DropDecision = "drop" | "kept-run" | "thread-live";

/** The sweep's decision (session-log item 7), one per candidate on the facts
 *  read at that moment: a session object is dropped only when no kept run
 *  record names it and no live run holds its thread — any live run on the
 *  thread blocks every session of that thread, since the live row is the
 *  conservative signal the sweep has. A kept run outranks a live thread in
 *  the answer, since it is the longer-lived reason. */
export function sessionsToDrop(candidates: readonly DropCandidate[]): Array<{ key: string; decision: DropDecision }> {
  return candidates.map((c) => ({
    key: c.key,
    decision: c.hasKeptRun ? "kept-run" : c.threadLive ? "thread-live" : "drop",
  }));
}

/** The attachments a stored row references: a part's own `dataRef`, and the
 *  `dataRef` of each of a tool result's nested parts — so a trimmed result
 *  can take with it what nothing else references (session-log item 5). */
export function attachmentRefsOf(json: string): string[] {
  const stored = parseStored(json);
  if (!stored || "compaction" in stored) return [];
  const part = stored.part as (ContentPart & { dataRef?: unknown }) | undefined;
  if (!part) return [];
  const refs: string[] = [];
  if (typeof part.dataRef === "string") refs.push(part.dataRef);
  if (part.type === "tool_result" && Array.isArray(part.content)) {
    for (const c of part.content as Array<{ dataRef?: unknown }>) {
      if (typeof c?.dataRef === "string") refs.push(c.dataRef);
    }
  }
  return refs;
}
