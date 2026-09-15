// The transcript mirror (docs/reference/specs/harness-pi.md item 8): pi's
// messages, as they finish, become the ledger's transcript in the runner's own
// vocabulary — the assistant turn with its tool calls, the results as one user
// turn — written through the same step records a native run writes, before
// the step's tools run, so `planResume` reads a pi run's row exactly as it
// reads a native one. The way back: a pi that died with its container is
// restarted on a session file rebuilt from that transcript, one linear branch
// of pi's own entries, so the model continues from the last finished turn;
// a pi that outlived the bot is read again from the last record the ledger
// holds, and the mirror knows the transcript's last row by sight so a row
// read twice is written once. The same file is how a fresh run hands pi the
// thread's earlier turns (the seed rule, item 9): the turns before the
// request become the session, the request alone is the prompt.

import { isDeepStrictEqual } from "node:util";
import type { StepReport } from "../../../runner.js";
import type { ChatMessage, ContentPart } from "../../../providers/types.js";
import type { AssembledCompaction } from "../../runLedger/transcript.js";
import type { CompactionEntry } from "../../runLedger/types.js";

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null;

/** pi's user or assistant content blocks → the runner's parts. Thinking blocks
 *  are pi's provider-specific replay material and are dropped; the record's
 *  transcript is what the model said and was told. */
function partsOf(content: unknown): ContentPart[] {
  if (typeof content === "string") return [{ type: "text", text: content }];
  if (!Array.isArray(content)) return [];
  const parts: ContentPart[] = [];
  for (const block of content) {
    if (!isRecord(block)) continue;
    if (block.type === "text" && typeof block.text === "string") parts.push({ type: "text", text: block.text });
    else if (block.type === "image" && typeof block.data === "string")
      parts.push({ type: "image", mediaType: String(block.mimeType ?? "image/png"), data: block.data });
    else if (block.type === "toolCall")
      parts.push({ type: "tool_use", id: String(block.id), name: String(block.name), input: block.arguments ?? {} });
  }
  return parts;
}

/** One pi message as the runner would have it, or nothing for a kind the
 *  runner's transcript has no place for (a bash execution, a custom entry). */
export function chatMessageOf(message: Record<string, unknown>): ChatMessage | undefined {
  switch (message.role) {
    case "user":
      return { role: "user", content: partsOf(message.content) };
    case "assistant":
      return { role: "assistant", content: partsOf(message.content) };
    case "toolResult": {
      const content = Array.isArray(message.content) ? partsOf(message.content) : [];
      const text = content
        .filter((p): p is Extract<ContentPart, { type: "text" }> => p.type === "text")
        .map((p) => p.text)
        .join("\n");
      const images = content.filter((p): p is Extract<ContentPart, { type: "image" }> => p.type === "image");
      return {
        role: "user",
        content: [
          {
            type: "tool_result",
            toolUseId: String(message.toolCallId),
            content: images.length > 0 ? [{ type: "text", text }, ...images] : text,
            ...(message.isError === true ? { isError: true } : {}),
          },
        ],
      };
    }
    default:
      return undefined;
  }
}

/** One row of the ledger's transcript as the mirror writes it: an assistant turn, or pi's compaction entry. */
export type LedgerTail = { turn: ChatMessage } | { compaction: CompactionEntry };

export interface MirrorDeps {
  /** The ledger's step hook (`LedgerRun.step`); absent, nothing is mirrored. */
  onStep?: (report: StepReport) => Promise<void>;
  /** How many rows the transcript holds before the first step — the index it
   *  takes; a resumed transcript's compaction rows count. The seed's own echo
   *  (`expectSeedEcho`) is on the ledger already and is not written again. */
  seedLength: number;
  remainingMs: () => number;
  /** The last row the ledger holds — an assistant turn, or the compaction
   *  that closed the transcript — on a re-attach (harness-pi item 8): the
   *  row's offset is saved after the ledger's write, so a bot that died
   *  between the two left it one row behind, and that row is read again. The
   *  first row the mirror is about to write that equals it is that row, and
   *  is not written twice. */
  mirroredTail?: LedgerTail;
}

/** Feeds pi's finished messages to the ledger as the runner would: every
 *  message since the last assistant turn — tool results, a steer's text — is
 *  the one user turn the next step record carries with the assistant turn. */
export class PiMirror {
  private idx: number;
  private pendingUser: ContentPart[] = [];
  /** pi is about to echo the seed's prompt as a user message (see `expectSeedEcho`). */
  private seedEchoPending = false;
  private mirroredTail: LedgerTail | undefined;
  private iteration = 0;
  /** The highest ledger inbox seq folded in so far (run-history item 40). */
  inboxConsumedSeq = 0;

  constructor(private readonly deps: MirrorDeps) {
    this.idx = deps.seedLength;
    this.mirroredTail = deps.mirroredTail;
  }

  /** Whether a report is owed: the mirror is wired and something happened. */
  get wired(): boolean {
    return this.deps.onStep !== undefined;
  }

  /** pi answered the seed's prompt: the first user message without results
   *  that follows is its echo — the seed, on the ledger already — and is not
   *  written twice. A continue prompt (harness-pi item 8) expects none: its
   *  echo is a turn the model was told, folded in like a steer's text. */
  expectSeedEcho(): void {
    this.seedEchoPending = true;
  }

  /** The row about to be written, against the transcript's tail — compared
   *  once, with the first row the mirror meets: equal means the ledger holds
   *  it already (read again, harness-pi item 8), together with the results
   *  pending before it, which were its step's user turn. */
  private alreadyHeld(row: LedgerTail): boolean {
    const tail = this.mirroredTail;
    if (tail === undefined) return false;
    this.mirroredTail = undefined;
    if (!isDeepStrictEqual(row, tail)) return false;
    this.pendingUser = [];
    return true;
  }

  /** Feeds one finished message; answers whether the ledger now holds
   *  everything up to it — a step written, or an assistant turn found already
   *  there — so the harness can move the row's offset past it. A result or a
   *  steer's text waits in memory for the next step, and the answer is no. */
  async onMessage(message: Record<string, unknown>, turn: number): Promise<boolean> {
    if (!this.deps.onStep) return false;
    const chat = chatMessageOf(message);
    if (!chat) return false;
    // A message with no parts is not a turn (session-log item 2, one index per
    // row): it would write no row and still spend a log index, and the next
    // reclaim would read the hole as an incomplete transcript. Nothing is
    // reported for it and the index stays; results pending ride the next turn.
    if (chat.content.length === 0) return false;
    if (chat.role === "user") {
      if (this.seedEchoPending && !chat.content.some((p) => p.type === "tool_result")) {
        this.seedEchoPending = false;
        return false;
      }
      this.pendingUser.push(...chat.content);
      return false;
    }
    if (this.alreadyHeld({ turn: chat })) return true;
    const turns: ChatMessage[] = [];
    if (this.pendingUser.length > 0) turns.push({ role: "user", content: this.pendingUser });
    this.pendingUser = [];
    turns.push(chat);
    const inFlight = chat.content
      .filter((p): p is Extract<ContentPart, { type: "tool_use" }> => p.type === "tool_use")
      .map((p) => ({ callId: p.id, tool: p.name }));
    const report: StepReport = {
      turns,
      firstIdx: this.idx,
      inFlight,
      turn,
      iteration: this.iteration++,
      remainingMs: Math.max(0, this.deps.remainingMs()),
      inboxConsumedSeq: this.inboxConsumedSeq,
    };
    this.idx += turns.length;
    await this.deps.onStep(report);
    return true;
  }

  /** pi compacted (session-log item 6): the results pending since the last
   *  assistant turn go as the user turn they would have been, the entry as the
   *  row after them — its own step with nothing in flight, so the log holds
   *  the summary where pi wrote it and the index moves past it. Answers as
   *  `onMessage` does: the ledger holds everything up to the entry. */
  async onCompaction(entry: CompactionEntry, turn: number): Promise<boolean> {
    if (!this.deps.onStep) return false;
    if (this.alreadyHeld({ compaction: entry })) return true;
    const turns: ChatMessage[] = [];
    if (this.pendingUser.length > 0) turns.push({ role: "user", content: this.pendingUser });
    this.pendingUser = [];
    const report: StepReport = {
      turns,
      firstIdx: this.idx,
      compaction: entry,
      inFlight: [],
      turn,
      iteration: this.iteration,
      remainingMs: Math.max(0, this.deps.remainingMs()),
      inboxConsumedSeq: this.inboxConsumedSeq,
    };
    this.idx += turns.length + 1;
    await this.deps.onStep(report);
    return true;
  }
}

/** A pi session file (docs/session-format.md, version 3) built from the
 *  runner's transcript — the thread's earlier turns a fresh run starts on, or
 *  the mirrored transcript a restarted pi continues from: the header, then one
 *  linear branch of entries — user turns, assistant turns with their tool
 *  calls, one toolResult per result part — each with an id and its parent's,
 *  so pi's `--session <path>` loads it as a session it wrote. The header's
 *  `cwd` is the directory the pi that loads the file runs in, the container
 *  seam's answer (`PiContainer.cwd`), never a constant: pi exits at once on a
 *  stored directory that does not exist where it runs, and the same transcript
 *  is resumed in a checkout on a container and in the run's own root on the
 *  bot host. The assistant
 *  entries carry the model the run resolved and no usage: the proxy is the
 *  meter. A document part is named in a text block: the session carries none.
 *  The log's compaction rows (docs/reference/specs/session-log.md item 6) become
 *  pi's `compaction` entries where they sat: pi keeps the entries from
 *  `firstKeptEntryId` to the compaction and everything after it, so with the
 *  kept message known that id names its entry, and without it pi's own id —
 *  which names nothing here — leaves the window the summary and the turns
 *  after it. */
export function piSessionFile(
  messages: readonly ChatMessage[],
  opts: { cwd: string; model: { provider: string; id: string; api: string }; at: number },
  compactions: readonly AssembledCompaction[] = [],
): string {
  const lines: string[] = [];
  const stamp = new Date(opts.at).toISOString();
  lines.push(
    JSON.stringify({ type: "session", version: 3, id: sessionIdOf(opts.at), timestamp: stamp, cwd: opts.cwd }),
  );
  let parentId: string | null = null;
  let n = 0;
  const toolNames = new Map<string, string>();
  /** The entry id each message's FIRST entry got (a user turn with results is several). */
  const firstEntryOf: string[] = [];
  const nextId = () => (n++).toString(16).padStart(8, "0");
  const push = (message: Record<string, unknown>) => {
    const id = nextId();
    lines.push(JSON.stringify({ type: "message", id, parentId, timestamp: stamp, message }));
    parentId = id;
    return id;
  };
  const pushCompaction = (c: AssembledCompaction) => {
    const id = nextId();
    const kept = c.keptBefore !== undefined ? firstEntryOf[c.keptBefore] : undefined;
    lines.push(
      JSON.stringify({
        type: "compaction",
        id,
        parentId,
        timestamp: stamp,
        summary: c.entry.summary,
        firstKeptEntryId: kept ?? c.entry.firstKeptEntryId ?? "",
        tokensBefore: c.entry.tokensBefore ?? 0,
      }),
    );
    parentId = id;
  };
  const byPosition = new Map<number, AssembledCompaction[]>();
  for (const c of compactions) byPosition.set(c.before, [...(byPosition.get(c.before) ?? []), c]);
  messages.forEach((message, i) => {
    for (const c of byPosition.get(i) ?? []) pushCompaction(c);
    firstEntryOf[i] = n.toString(16).padStart(8, "0");
    if (message.role === "assistant") {
      const content: Record<string, unknown>[] = [];
      for (const p of message.content) {
        if (p.type === "text") content.push({ type: "text", text: p.text });
        else if (p.type === "tool_use") {
          toolNames.set(p.id, p.name);
          content.push({ type: "toolCall", id: p.id, name: p.name, arguments: isRecord(p.input) ? p.input : {} });
        }
      }
      const hasTool = content.some((b) => b.type === "toolCall");
      push({
        role: "assistant",
        content,
        api: opts.model.api,
        provider: opts.model.provider,
        model: opts.model.id,
        usage: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        stopReason: hasTool ? "toolUse" : "stop",
        timestamp: opts.at,
      });
      return;
    }
    const results = message.content.filter(
      (p): p is Extract<ContentPart, { type: "tool_result" }> => p.type === "tool_result",
    );
    for (const r of results) {
      const text =
        typeof r.content === "string"
          ? r.content
          : r.content.map((c) => (c.type === "text" ? c.text : `[${c.type}]`)).join("\n");
      push({
        role: "toolResult",
        toolCallId: r.toolUseId,
        toolName: toolNames.get(r.toolUseId) ?? "tool",
        content: [{ type: "text", text }],
        isError: r.isError === true,
        timestamp: opts.at,
      });
    }
    const rest: Record<string, unknown>[] = [];
    for (const p of message.content) {
      if (p.type === "text") rest.push({ type: "text", text: p.text });
      else if (p.type === "image") rest.push({ type: "image", data: p.data, mimeType: p.mediaType });
      else if (p.type === "document")
        rest.push({
          type: "text",
          text: `[document ${p.name ?? "document"} (${p.mediaType}) — not carried into this session]`,
        });
    }
    if (rest.length > 0) push({ role: "user", content: rest, timestamp: opts.at });
  });
  // A compaction that closed the span sits after the last message.
  for (const c of byPosition.get(messages.length) ?? []) pushCompaction(c);
  return lines.join("\n") + "\n";
}

/** A session id pi accepts: UUID-shaped, derived from the write-back's clock. */
function sessionIdOf(at: number): string {
  const hex = at.toString(16).padStart(12, "0").slice(-12);
  return `00000000-0000-4000-8000-${hex}`;
}
