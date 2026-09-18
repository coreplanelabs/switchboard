// The session seed (docs/reference/specs/session-log.md item 9; records 0034
// and 0035): what a follow-up starts from when its thread and agent have a
// session log. The log's newest turns within the seed budget,
// read by the object as whole turns (item 4) and cut here forward to the first
// user turn that carries text — so the conversation opens as providers
// require and no tool call is parted from its result — with thinking dropped
// and the calls a previous run left in flight settled, and the words of a
// request the provider refused under its usage policy left out (the thread's
// records name those runs); then a gap marker when
// the previous run's log ends short; then the channel's user lines written
// after that run ended; then the request. The cut costs the first kept turn
// the tool results that answer calls made before it, and the seed's notes say
// so. The rows the seed reuses are named
// so the write-through appends only what is new (item 2): the run's local
// index i is the log's index `log.from + i` throughout — which is why a
// refused request's row keeps its place with a stand-in instead of going.
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
import { requestContent, turnContent } from "./messages.js";
import { previousRunOf, refusedRequestsOf } from "./thread.js";

/** The seed budget (record 0035, "The seed"): the tail a follow-up starts
 *  from, in tokens, at the four characters a token the memory block assumes. */
export const SEED_BUDGET_TOKENS = 60_000;
export const SEED_BUDGET_BYTES = SEED_BUDGET_TOKENS * 4;

/** What stands in the seed for a request the provider refused under its
 *  usage policy: the row keeps its place and its role, the words stay in the
 *  log for `recall`, and the model reads that something was left out here. */
export const REFUSED_REQUEST_STAND_IN = "(a request the model refused under its usage policy was left out here)";

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
  /** The platform-namespaced author id for each message, by index into
   *  `messages`; absent (or the entry undefined) for machine turns and reused
   *  tail rows. Only present when at least one new message has an actor
   *  (record 0057). */
  actors?: readonly (string | undefined)[];
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
  request: {
    text: string;
    images?: ImageAttachment[];
    documents?: DocumentAttachment[];
    /** The quoted blocks of the request's referenced conversations (record 0037), text parts after the request's own. */
    references?: readonly string[];
    /** The platform-namespaced id of the requester (e.g. `slack:U…`); stored
     *  on the request row so a steer or verifier can tell the requester's words
     *  from another member's (record 0057). */
    actor?: string;
  };
  /** The log indices of the request rows the provider refused under its usage
   *  policy (`refusedRequestsOf`, off the thread's records): their words are
   *  left out of the tail. Absent or empty, the tail is reused as it is. */
  refusedRequests?: readonly number[];
}): SessionSeed | undefined {
  const { tail, previous, history, request, refusedRequests = [] } = input;
  const { from, transcript } = tail;
  if (from === 0 && transcript.turns === 0) return undefined;
  const notes: string[] = [];
  const messages: ChatMessage[] = [];
  /** Actor ids for new (non-reused) messages, keyed by their index in `messages`. */
  const actorMap = new Map<number, string>();

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
  // The first kept turn may answer calls made before the cut: pi answers a
  // tool batch and a steer in one user turn, and a compaction entry sits
  // between that batch's calls and its results, so the turn the cut lands on
  // opens with results whose calls are gone. A provider refuses a result
  // without its call, so those parts go and the text stays; the results
  // themselves are one `recall` away, and the seed's notes say what was
  // dropped.
  if (kept.length > 0 && kept[0].role === "user") {
    const first = kept[0];
    const orphans = first.content.filter((p) => p.type === "tool_result").length;
    if (orphans > 0) {
      kept[0] = { ...first, content: first.content.filter((p) => p.type !== "tool_result") };
      notes.push(
        orphans === 1
          ? "session seed: one tool result answering a call before the cut was dropped from the tail's first turn"
          : `session seed: ${orphans} tool results answering calls before the cut were dropped from the tail's first turn`,
      );
    }
  }
  // A request the provider refused under its usage policy is refused again on
  // every later request that carries its words, so those words leave the
  // tail. The row itself stays, as one text part saying so: the seed reuses
  // the log's rows by index (`log.from + i`), so a row dropped would move
  // every row after it and the write-through would write the tail again as
  // new rows. The log keeps the words for `recall`. A row before the cut, or
  // one that is not a user turn (the record would be wrong), is nothing to
  // leave out.
  let leftOut = 0;
  for (const row of new Set(refusedRequests)) {
    const k = row - logFrom;
    if (k < 0 || k >= kept.length || kept[k].role !== "user") continue;
    kept[k] = { role: "user", content: [{ type: "text", text: REFUSED_REQUEST_STAND_IN }] };
    leftOut++;
  }
  if (leftOut > 0) {
    notes.push(
      leftOut === 1
        ? "session seed: 1 request refused by the provider's policy was left out of the tail"
        : `session seed: ${leftOut} requests refused by the provider's policy were left out of the tail`,
    );
  }
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
      const idx = messages.length;
      messages.push({ role: "user", content: turnContent(h.text, h.images, h.documents) });
      if (h.user !== undefined) actorMap.set(idx, h.user);
    }
  }

  const requestIdx = messages.length;
  messages.push({
    role: "user",
    content: requestContent(request.text, request.images, request.documents, request.references),
  });
  if (request.actor !== undefined) actorMap.set(requestIdx, request.actor);

  const actors: (string | undefined)[] | undefined =
    actorMap.size > 0 ? Array.from({ length: messages.length }, (_, i) => actorMap.get(i)) : undefined;

  return {
    messages,
    log: { from: logFrom, turns: kept.length },
    ...(summary !== undefined ? { summary } : {}),
    ...(actors !== undefined ? { actors } : {}),
    notes,
  };
}

/**
 * The seed for a follow-up, read from the ledger: the log of this thread and
 * agent (`sessionKey`), its tail within the budget, the previous run of the
 * agent and the requests the provider refused off the thread's runs. A log that
 * cannot be read — a state Worker without the route, a failed request — is no
 * session: the run seeds from the channel, and the note says why.
 */
export async function sessionSeedFor(input: {
  ledger: Pick<LedgerWriteThrough, "readSessionTail" | "readNotepad">;
  threadKey: string;
  agent: string;
  thread: readonly RunView[];
  history: readonly HistoryItem[];
  request: {
    text: string;
    images?: ImageAttachment[];
    documents?: DocumentAttachment[];
    /** The quoted blocks of the request's referenced conversations (record 0037), text parts after the request's own. */
    references?: readonly string[];
    /** The platform-namespaced id of the requester (e.g. `slack:U…`); stored
     *  on the request row so a steer or verifier can tell the requester's words
     *  from another member's (record 0057). */
    actor?: string;
  };
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
    refusedRequests: refusedRequestsOf(input.thread, input.agent),
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
