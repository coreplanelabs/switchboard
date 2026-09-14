// The transcript mirror (docs/reference/specs/harness-pi.md item 8): pi's
// messages, as they finish, become the ledger's transcript in the runner's own
// vocabulary — the assistant turn with its tool calls, the results as one user
// turn — written through the same step records a native run writes, before
// the step's tools run, so `planResume` reads a pi run's row exactly as it
// reads a native one. The way back: a pi that died with its container is
// restarted on a session file rebuilt from that transcript, one linear branch
// of pi's own entries, so the model continues from the last finished turn.
// The same file is how a fresh run hands pi the thread's earlier turns (the
// seed rule, item 9): the turns before the request become the session, the
// request alone is the prompt.

import type { StepReport } from "../../../runner.js";
import type { ChatMessage, ContentPart } from "../../../providers/types.js";

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

export interface MirrorDeps {
  /** The ledger's step hook (`LedgerRun.step`); absent, nothing is mirrored. */
  onStep?: (report: StepReport) => Promise<void>;
  /** How many turns the seed holds: the first user message pi echoes IS the seed. */
  seedLength: number;
  remainingMs: () => number;
}

/** Feeds pi's finished messages to the ledger as the runner would: every
 *  message since the last assistant turn — tool results, a steer's text — is
 *  the one user turn the next step record carries with the assistant turn. */
export class PiMirror {
  private idx: number;
  private pendingUser: ContentPart[] = [];
  private seedEchoed = false;
  private iteration = 0;
  /** The highest ledger inbox seq folded in so far (run-history item 40). */
  inboxConsumedSeq = 0;

  constructor(private readonly deps: MirrorDeps) {
    this.idx = deps.seedLength;
  }

  /** Whether a report is owed: the mirror is wired and something happened. */
  get wired(): boolean {
    return this.deps.onStep !== undefined;
  }

  async onMessage(message: Record<string, unknown>, turn: number): Promise<void> {
    if (!this.deps.onStep) return;
    const chat = chatMessageOf(message);
    if (!chat) return;
    if (chat.role === "user") {
      // pi echoes the prompt it was sent as its first user message: that is the seed, already on the ledger.
      if (!this.seedEchoed && !chat.content.some((p) => p.type === "tool_result")) {
        this.seedEchoed = true;
        return;
      }
      this.pendingUser.push(...chat.content);
      return;
    }
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
  }
}

/** A pi session file (docs/session-format.md, version 3) built from the
 *  runner's transcript — the thread's earlier turns a fresh run starts on, or
 *  the mirrored transcript a restarted pi continues from: the header, then one
 *  linear branch of entries — user turns, assistant turns with their tool
 *  calls, one toolResult per result part — each with an id and its parent's,
 *  so pi's `--session <path>` loads it as a session it wrote. The assistant
 *  entries carry the model the run resolved and no usage: the proxy is the
 *  meter. A document part is named in a text block: the session carries none. */
export function piSessionFile(
  messages: readonly ChatMessage[],
  opts: { cwd: string; model: { provider: string; id: string; api: string }; at: number },
): string {
  const lines: string[] = [];
  const stamp = new Date(opts.at).toISOString();
  lines.push(
    JSON.stringify({ type: "session", version: 3, id: sessionIdOf(opts.at), timestamp: stamp, cwd: opts.cwd }),
  );
  let parentId: string | null = null;
  let n = 0;
  const toolNames = new Map<string, string>();
  const push = (message: Record<string, unknown>) => {
    const id = (n++).toString(16).padStart(8, "0");
    lines.push(JSON.stringify({ type: "message", id, parentId, timestamp: stamp, message }));
    parentId = id;
  };
  for (const message of messages) {
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
      continue;
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
  }
  return lines.join("\n") + "\n";
}

/** A session id pi accepts: UUID-shaped, derived from the write-back's clock. */
function sessionIdOf(at: number): string {
  const hex = at.toString(16).padStart(12, "0").slice(-12);
  return `00000000-0000-4000-8000-${hex}`;
}
