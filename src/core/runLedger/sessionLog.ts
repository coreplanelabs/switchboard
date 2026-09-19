// The session log's pure rules (docs/decisions/0035-a-session-log-outlives-its-runs-compaction-is-a-pointer.md;
// docs/reference/specs/session-log.md): one log per thread and agent holds the
// transcript rows of every run of the session, each run a range of it. This
// file is node-free — the bot and `deploy/cloudflare-memory/worker.ts` import
// it alike — and holds what both sides must agree on: the object's name, the
// text the full-text index sees for a row, the byte policy's choice of what to
// drop, the tail cut a follow-up seeds from, and the sweep's drop decision.

import type { ChatMessage, ContentPart } from "../chatMessage.js";
import { DEFAULT_RETENTION_POLICY, utf8ByteLength } from "../runRecord.js";
import type { StoredRow } from "./transcript.js";

export { isRunSession, SESSION_KEY_PATTERN, type RunSession } from "../runRecord.js";

/** The byte policy's default: `RetentionPolicy.sessionLogMaxBytes`. */
export const DEFAULT_SESSION_LOG_MAX_BYTES = DEFAULT_RETENTION_POLICY.sessionLogMaxBytes;

/** How much of a hit's text a search answers with (item 10): one line, at most this many characters. */
export const SNIPPET_CHARS = 300;
/** The most hits one search answers — the object's cap, `recall`'s and the search route's alike. */
export const SEARCH_MAX_HITS = 50;

/** A hit's text as one line of at most `SNIPPET_CHARS` — what `recall` and
 *  the session search route answer beside the turn, so a reader sees where
 *  the words fell without the turn's whole body. */
export function snippetOf(text: string): string {
  const line = text.replace(/\s+/g, " ").trim();
  return line.length > SNIPPET_CHARS ? `${line.slice(0, SNIPPET_CHARS - 1)}…` : line;
}

/** The object's name: the thread and the agent, the pair record 0034 calls a
 *  session. A run without a resolved agent keys on a dash so the name still
 *  has both halves. */
export function sessionKey(threadKey: string, agent: string | undefined): string {
  return `${threadKey}:${agent ?? "-"}`;
}

/** The thread session's key (record 0057; the one-door plan's memory unit,
 *  item 13): one log per thread, read and written by the operator — every
 *  connector event the intake gate admits, every child's report, every
 *  question and answer is a turn in it. The `@thread` half can never collide
 *  with `sessionKey`'s agent half: no agent id starts with `@`. */
export function threadSessionKey(threadKey: string): string {
  return `${threadKey}:@thread`;
}

/** A working session's lane: a unit's coding rounds continue one log, its
 *  review rounds another (item 13). */
export type WorkingLane = "coding" | "review";

/** A working session's key `<instance>:<unit>:<lane>` (item 13). A re-issue of the
 *  same plan carries an attempt suffix on its instance id (`planInstanceId`:
 *  `plan-<id>-<attempt>`, attempt ≥ 2); the key strips it, so a re-issue
 *  continues the prior instance's lanes rather than starting cold. */
export function workingSessionKey(instance: { id: string; attempt?: number }, unit: string, lane: WorkingLane): string {
  const suffix = instance.attempt !== undefined ? `-${instance.attempt}` : "";
  const base =
    suffix !== "" && instance.id.endsWith(suffix)
      ? instance.id.slice(0, instance.id.length - suffix.length)
      : instance.id;
  return `${base}:${unit}:${lane}`;
}

/** A connector turn's row id (item 13): the message id, with its edit timestamp
 *  when the message was edited — an edited message appends a second row (the
 *  first said what the person first said), a re-delivered unedited one
 *  appends nothing. */
export function connectorRowId(messageId: string, editedAt?: string | number): string {
  return editedAt === undefined ? messageId : `${messageId}:edit-${editedAt}`;
}

/** The fold's row id for a hosted parent's `ship_unit` event (item 13): the
 *  event's own identity — its unit, its state and the registry seq it was
 *  published under — so the same event read twice folds one row. The seq is
 *  required (the registry stamps every published event with one): without it,
 *  a unit reopened at a second segment would repeat a state — two `started`
 *  events — and the second fold would be dropped as a duplicate. */
export function shipUnitRowId(event: { unit: string; state: string; seq: number }): string {
  return `ship-unit:${event.unit}:${event.state}:${event.seq}`;
}

/** One thread-session row as its JSON is stored (item 13): a text turn with
 *  its author when a person wrote it, `silent` when the intake gate withheld
 *  the reply (the person's words are context all the same), `folded` when the
 *  row is a child's report folded whole — what `operatorTail` keeps ahead of
 *  older turns. */
export function storedTurnRow(turn: {
  role: "user" | "assistant";
  text: string;
  actor?: string;
  silent?: boolean;
  folded?: boolean;
}): string {
  return JSON.stringify({
    role: turn.role,
    part: { type: "text", text: turn.text },
    ...(turn.actor !== undefined ? { actor: turn.actor } : {}),
    ...(turn.silent === true ? { silent: true } : {}),
    ...(turn.folded === true ? { folded: true } : {}),
  });
}

/** Whether a stored row is a reply the intake gate withheld as silent (item 13). */
export function silentOfStoredRow(json: string): boolean {
  const stored = parseStored(json);
  return stored !== undefined && !("compaction" in stored) && (stored as { silent?: unknown }).silent === true;
}

/** Whether a stored row is a folded report (item 13) — kept whole by the
 *  operator's cap ahead of older turns. */
export function foldedOfStoredRow(json: string): boolean {
  const stored = parseStored(json);
  return stored !== undefined && !("compaction" in stored) && (stored as { folded?: unknown }).folded === true;
}

/** A run of an old `<thread>:<agent>` log, as the cutover migration reads it
 *  (item 13): its log's key, when it started and the row range its record closed. */
export interface MigrationRun {
  key: string;
  startedAt: number;
  range: { from: number; to?: number };
}

/** The order the cutover migration reads an old thread's per-agent logs into
 *  the thread session (item 13): the runs by their start times, each run's rows in
 *  its session range in index order, and rows outside any run's range after
 *  the runs that precede them in their own log (before every run of that log
 *  when none does). The read is once: each row lands under the row id
 *  `migrationRowId(key, idx)`, so a replay appends nothing twice, and the old
 *  keys stay read-only for recall. */
export function migrationOrder(
  runs: readonly MigrationRun[],
  logs: readonly { key: string; rows: readonly number[] }[],
): Array<{ key: string; idx: number }> {
  const byStart = [...runs].sort((a, b) => a.startedAt - b.startedAt);
  // A row's place: inside a run's range it rides at that run's start (phase 0);
  // past a run's closed range it rides after that run's rows (phase 1); before
  // every run of its log it comes first of all (start -Infinity).
  const placed = logs.flatMap((log, logOrder) =>
    log.rows.map((idx) => {
      let at = Number.NEGATIVE_INFINITY;
      let phase = 1;
      for (const r of byStart) {
        if (r.key !== log.key) continue;
        const to = r.range.to;
        if (idx >= r.range.from && (to === undefined || idx <= to)) {
          at = r.startedAt;
          phase = 0;
          break;
        }
        if (to !== undefined && to < idx && r.startedAt > at) at = r.startedAt;
      }
      return { key: log.key, idx, at, phase, logOrder };
    }),
  );
  placed.sort((a, b) => a.at - b.at || a.phase - b.phase || a.logOrder - b.logOrder || a.idx - b.idx);
  return placed.map(({ key, idx }) => ({ key, idx }));
}

/** The row id a migrated row lands under (item 13): the old log's key and the
 *  row's index there — stable, so the read-once migration is idempotent. */
export function migrationRowId(key: string, idx: number): string {
  return `migrated:${key}#${idx}`;
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

/** Whose turn a stored row is: the role the row's JSON carries; a compaction
 *  row or an unreadable one has none. What `recall` reports beside a hit. */
export function roleOfStoredRow(json: string): "user" | "assistant" | undefined {
  const stored = parseStored(json);
  if (!stored || "compaction" in stored) return undefined;
  const role = (stored as { role?: unknown }).role;
  return role === "user" || role === "assistant" ? role : undefined;
}

/** The platform-namespaced id of the person who authored the turn a stored
 *  row belongs to (e.g. `slack:U…`); absent for machine turns, compaction
 *  rows, unreadable rows, and rows written before record 0057. */
export function actorOfStoredRow(json: string): string | undefined {
  const stored = parseStored(json);
  if (!stored || "compaction" in stored) return undefined;
  const actor = (stored as { actor?: unknown }).actor;
  return typeof actor === "string" ? actor : undefined;
}

/** The notepad's size (record 0035, "The notepad"): one document per session,
 *  written whole, at most this many UTF-8 bytes; `notes` refuses over it naming
 *  the size, and the object's write route does too. */
export const NOTEPAD_MAX_BYTES = 8_192;

/** The row a follow-up appends when the previous run's record says `broken`
 *  (session-log item 9): a user text turn saying the log ends short of what
 *  that run saw. Named here so the object can tell a gap row apart for
 *  `recall`, which says when a search straddles one. */
export const GAP_MARKER =
  "[The log of this conversation ends short of what the previous run saw: its connection to the ledger broke, " +
  "so its later turns and its final reply are not here.]";

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
