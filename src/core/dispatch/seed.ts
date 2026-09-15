// The session seed (docs/reference/specs/session-log.md item 9; records 0034
// and 0035): what a follow-up on the pi harness starts from when its thread
// and agent have a session log. The log's newest turns within the seed budget,
// read by the object as whole turns (item 4) and cut here forward to the first
// user turn that carries text — so the conversation opens as providers
// require and no tool call is parted from its result — with thinking dropped
// and the calls a previous run left in flight settled; then a gap marker when
// the previous run's log ends short; then the channel's user lines written
// after that run ended; then the request. The rows the seed reuses are named
// so the write-through appends only what is new (item 2): the run's local
// index i is the log's index `log.from + i` throughout.
//
// pi's compaction entries never ride the seed as rows: the tail begins after
// the newest one, and that entry's summary is handed back for the system
// prompt, where the record keeps it a pointer to the log and never a loss.
import type { ChatMessage, ContentPart } from "../chatMessage.js";
import { GAP_MARKER, sessionKey } from "../runLedger/sessionLog.js";
import type { AssembledTranscript } from "../runLedger/transcript.js";
import type { LedgerWriteThrough } from "../runLedger/writeThrough.js";
import type { RunView } from "../runsService.js";
import type { DocumentAttachment, HistoryItem, ImageAttachment } from "../types.js";
import { turnContent } from "./messages.js";
import { previousRunOf } from "./thread.js";

/** The seed budget (record 0035, "The seed"): the tail a follow-up starts
 *  from, in tokens, at the four characters a token the memory block assumes. */
export const SEED_BUDGET_TOKENS = 60_000;
export const SEED_BUDGET_BYTES = SEED_BUDGET_TOKENS * 4;

/** What the ledger's tail read answers (`readSessionTail`): the log index the
 *  rows start at and the transcript assembled from them, counted from 0. */
export interface SessionTail {
  from: number;
  transcript: AssembledTranscript;
}

/** The thread's previous finished run of this agent, as the seed needs it:
 *  when it ended, so the lines written after it can be told apart, and whether
 *  its record says the log ends short of what it saw. */
export interface PreviousRun {
  finishedAt?: number;
  broken: boolean;
}

export interface SessionSeed {
  /** The conversation the run starts from, in order: the tail's rows as they
   *  are, the settlement of its calls in flight, the gap marker, the lines
   *  since, the request. Not merged across the tail's end: every message
   *  after the tail is a new row of its own. */
  messages: ChatMessage[];
  /** The rows the seed reuses: the log index the tail begins at and how many
   *  of `messages`, from the first, are those rows — one row each. */
  log: { from: number; turns: number };
  /** The newest compaction entry's summary when the log has one: for the
   *  system prompt, never a row. */
  summary?: string;
  /** The session's notepad as the `notes` tool last wrote it (item 10): for the
   *  system prompt, never a row. Read by `sessionSeedFor`, absent when empty. */
  notepad?: string;
  /** What the seed could not do, one line each, for the record's notes. */
  notes: string[];
}

const settledResult = (toolName: string): string =>
  `The run that made this call ended before this ${toolName} call's result was recorded; its effects are unknown — ` +
  "re-check them before repeating it.";

/**
 * The seed, or undefined when the log has no rows (the thread has no session
 * of this agent: the run seeds from the channel as before).
 */
export function sessionSeed(input: {
  tail: SessionTail;
  previous: PreviousRun | undefined;
  history: readonly HistoryItem[];
  request: { text: string; images?: ImageAttachment[]; documents?: DocumentAttachment[] };
}): SessionSeed | undefined {
  const { tail, previous, history, request } = input;
  const { from, transcript } = tail;
  if (from === 0 && transcript.turns === 0) return undefined;
  const notes: string[] = [];
  const messages: ChatMessage[] = [];

  // The tail begins after the newest compaction row (its entry sits before the
  // message `before`), then at the first user turn carrying text from there.
  const compactions = transcript.compactions;
  const afterCompaction = compactions.reduce((n, c) => Math.max(n, c.before), 0);
  let start = -1;
  for (let i = afterCompaction; i < transcript.messages.length; i++) {
    const m = transcript.messages[i];
    if (m.role === "user" && m.content.some((p) => p.type === "text")) {
      start = i;
      break;
    }
  }
  const summary = compactions.length ? compactions[compactions.length - 1].entry.summary : undefined;
  // Every message before `start` is a row, and so is every compaction entry —
  // all of which sit before `start` by construction.
  const logFrom = start < 0 ? from + transcript.turns : from + start + compactions.length;
  const kept = start < 0 ? [] : transcript.messages.slice(start).map(withoutThinking);
  if (kept.length === 0) {
    notes.push(
      transcript.turns === 0
        ? "session seed: the log's newest turn alone is over the seed budget — the run starts from the request"
        : "session seed: no user text turn in the tail within the seed budget — the run starts from the request",
    );
  }
  messages.push(...kept);

  // A tail that ends on calls in flight: each answered, as a resume answers
  // them, so no dangling call reaches a provider.
  const last = kept[kept.length - 1];
  if (last?.role === "assistant") {
    const calls = last.content.filter((p): p is Extract<ContentPart, { type: "tool_use" }> => p.type === "tool_use");
    if (calls.length > 0) {
      messages.push({
        role: "user",
        content: calls.map((c) => ({
          type: "tool_result" as const,
          toolUseId: c.id,
          content: settledResult(c.name),
          isError: true,
        })),
      });
    }
  }

  if (previous?.broken) messages.push({ role: "user", content: [{ type: "text", text: GAP_MARKER }] });

  // The channel's user lines after the previous run ended; the bot's own posts
  // are left out because the run's final reply is the tail's last assistant turn.
  if (previous?.finishedAt === undefined) {
    notes.push(
      "session seed: the previous run's end is unknown, so the lines written since could not be told apart — only the request follows the tail",
    );
  } else {
    const end = previous.finishedAt;
    for (const h of history) {
      if (h.role !== "user" || h.at === undefined || h.at <= end) continue;
      messages.push({ role: "user", content: turnContent(h.text, h.images, h.documents) });
    }
  }

  messages.push({ role: "user", content: turnContent(request.text, request.images, request.documents) });
  return {
    messages,
    log: { from: logFrom, turns: kept.length },
    ...(summary !== undefined ? { summary } : {}),
    notes,
  };
}

/**
 * The seed for a follow-up whose agent runs on the pi harness, read from the
 * ledger: the log of this thread and agent (`sessionKey`), its tail within the
 * budget, the previous run of the agent off the thread's runs. A log that
 * cannot be read — a state Worker without the route, a failed request — is no
 * session: the run seeds from the channel, and the note says why.
 */
export async function sessionSeedFor(input: {
  ledger: Pick<LedgerWriteThrough, "readSessionTail" | "readNotepad">;
  threadKey: string;
  agent: string;
  thread: readonly RunView[];
  history: readonly HistoryItem[];
  request: { text: string; images?: ImageAttachment[]; documents?: DocumentAttachment[] };
}): Promise<{ seed?: SessionSeed; notes: string[] }> {
  const key = sessionKey(input.threadKey, input.agent);
  let tail: SessionTail;
  try {
    tail = await input.ledger.readSessionTail(key, SEED_BUDGET_BYTES);
  } catch (err) {
    const why = err instanceof Error ? err.message : String(err);
    return { notes: [`session seed: the log ${key} could not be read (${why}) — the run seeds from the channel`] };
  }
  const seed = sessionSeed({
    tail,
    previous: previousRunOf(input.thread, input.agent),
    history: input.history,
    request: input.request,
  });
  if (!seed) return { notes: [] };
  // The notepad rides the prompt, never a row (item 10); a notepad that cannot
  // be read is a note, and the seed stands.
  try {
    const notepad = await input.ledger.readNotepad(key);
    if (notepad && notepad.text.trim().length > 0) seed.notepad = notepad.text;
  } catch (err) {
    const why = err instanceof Error ? err.message : String(err);
    seed.notes.push(`session seed: the notepad of ${key} could not be read (${why}) — the run starts without it`);
  }
  return { seed, notes: seed.notes };
}

/** The message without its thinking blocks; an assistant turn of nothing but
 *  thinking keeps one text part so the row keeps its place and its role. */
function withoutThinking(message: ChatMessage): ChatMessage {
  if (message.role !== "assistant") return message;
  const content = message.content.filter((p) => p.type !== "thinking" && p.type !== "redacted_thinking");
  if (content.length === message.content.length) return message;
  return { ...message, content: content.length ? content : [{ type: "text", text: "(reasoning omitted)" }] };
}
