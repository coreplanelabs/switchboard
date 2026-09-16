// Seed and rebuild are an import (docs/reference/specs/harness.md item 5; the
// survival word for OpenCode is `authored-session`). A run's conversation
// is handed to OpenCode by writing it as a session OpenCode accepts as its own
// — `POST /api/session/import { info, messages }` into a fresh store — and then
// prompting the request. This module builds that body from the runner's
// vocabulary (`ChatMessage[]` plus the ledger's compaction entries and the
// settlements of calls in flight at a death):
//
//   • the thread's earlier turns (a fresh run's seed) become one `user` or
//     `assistant` store message each, so the mirror — which skips `seedLength`
//     leading store messages — skips exactly the seed;
//   • an assistant turn's tool calls become the message's `tool` contents, each
//     in `state: "completed"` carrying the result the following user turn held,
//     or, for a call in flight when the bot died, the settlement note;
//   • each compaction becomes a `compaction` message with the stored summary;
//   • every assistant message carries `time.completed` (import keeps only
//     settled messages, `packages/core/src/session/transfer.ts:166`).
//
// Verified against `@opencode/cli@2.0.3`: an import of a scripted ledger with
// assistant turns that carry no `providerState` is accepted, `GET …/message`
// lists exactly one store message per seed message, and the next `prompt`
// continues from it (the spike closed this against the pinned binary). Pure:
// strings and records, no I/O.

import type { ChatMessage, ContentPart } from "../../chatMessage.js";
import type { Settlement } from "../../runLedger/resume.js";
import type { CompactionEntry } from "../../runLedger/types.js";

/** The note a call in flight when the container was replaced is settled with:
 *  the tool ran in the container and its result died with the old container's
 *  disk, so it is never re-run — the rebuilt session reads the note in its
 *  place. Said of the tool by name, as pi's `replacedCallNote` is. */
export function openCodeReplacedCallNote(tool: string): string {
  return `The container running OpenCode was replaced while this ${tool} call was in flight; its result was lost — re-check its effects before re-running it.`;
}

/** The note a call in flight at a death is rebuilt with — the same words pi's
 *  `settlementText` writes, said of the container: the tool ran in the
 *  container and its result died with the bot's view of it, so it is never
 *  re-run; the rebuilt session reads the note in its place. A synthetic
 *  settlement carries its own words. */
export function openCodeSettlementNote(s: Settlement): string {
  return s.action === "synthetic" ? s.text : openCodeReplacedCallNote(s.toolUse.name);
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null;

/** The session id OpenCode holds the run under: the `ses_` prefix its schema
 *  requires (`packages/schema/src/session-id.ts`), then the run's id with every
 *  character its id allows but the session id does not folded to `-`, so two
 *  runs never share a session and the id carries no secret. */
export function openCodeSessionId(runId: string): string {
  return `ses_${runId.replace(/[^A-Za-z0-9]/g, "-")}`;
}

/** A clock that answers `at`, then a millisecond later on every call: the stamps of one import body, in order. */
function tickingClock(at: number): () => number {
  let n = 0;
  return () => at + n++;
}

/** The text of a turn's text parts, joined — the only content an OpenCode `user` message carries. */
function textOf(content: readonly ContentPart[]): string {
  return content
    .filter((p): p is Extract<ContentPart, { type: "text" }> => p.type === "text")
    .map((p) => p.text)
    .join("\n\n");
}

/** One OpenCode tool content for a call the record holds a result for
 *  (`Session.Message.ToolState`): a real result in `state: completed`, a
 *  settlement note for a call in flight at a death in `state: error` (the call
 *  was interrupted, its result lost — a failed tool the record and the rebuilt
 *  transcript both read as `isError`, so the next model call sees a result for
 *  every call). The content is a non-empty text array, as the schema requires. */
export function openCodeToolContent(
  toolUse: Extract<ContentPart, { type: "tool_use" }>,
  resultText: string,
  at: number,
  isError = false,
): Record<string, unknown> {
  const input = isRecord(toolUse.input) ? toolUse.input : {};
  const content = [{ type: "text", text: resultText || "(no output)" }];
  return {
    type: "tool",
    id: toolUse.id,
    name: toolUse.name,
    state: isError
      ? { status: "error", input, error: { message: resultText || "the call was interrupted" }, content }
      : { status: "completed", input, content },
    time: { created: at, completed: at },
  };
}

/** One OpenCode `compaction` message carrying the stored summary (session-log
 *  item 6): a completed compaction, so import keeps it, whose `summary` is the
 *  ledger's, standing in for the turns it replaced. */
export function openCodeCompactionMessage(id: string, entry: CompactionEntry, at: number): Record<string, unknown> {
  return {
    id,
    type: "compaction",
    status: "completed",
    reason: "auto",
    summary: entry.summary,
    recent: "",
    time: { created: at },
  };
}

/** What the import body's `info` and messages need of the run. */
export interface OpenCodeImportOptions {
  sessionID: string;
  /** The run's directory OpenCode resolves the project from; the import ignores
   *  the body's `projectID` and resolves the project from here. */
  location: { directory: string };
  /** The resolved model on the session's ref, so a variant (the effort tier) rides it. */
  model?: { providerID: string; id: string; variant?: string };
  /** The custom agent every turn speaks as. */
  agent?: string;
  /** The clock the messages are stamped from; each message a millisecond later, so their order is stable. */
  at: number;
}

/** A settlement the rebuild carries for a call in flight at the death, by the
 *  call's tool-use id: the note OpenCode's store holds in the tool content's
 *  place, never a re-run. */
export type OpenCodeSettlements = ReadonlyMap<string, string>;

/** The transcript as OpenCode store messages, one per non-tool-result turn:
 *  a user turn of text is a `user` message; an assistant turn is an `assistant`
 *  message whose `content` is its text and its tool calls (each a completed
 *  tool content carrying the following user turn's result, or the settlement
 *  note for a call still in flight); a user turn that is only tool results is
 *  folded into the assistant turn before it and writes no message of its own.
 *  A fresh run's seed is text-only turns, so the mapping is one store message
 *  per seed `ChatMessage` — what the mirror's `seedLength` skip relies on. */
export function openCodeStoreMessages(
  messages: readonly ChatMessage[],
  opts: OpenCodeImportOptions & {
    compactions?: readonly CompactionEntry[];
    settlements?: OpenCodeSettlements;
    /** The ticking clock the import body shares across its messages, tool contents and compactions, so every stamp is later than the last; absent, one of this call's own. */
    clock?: () => number;
  },
): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  const model = opts.model ?? { providerID: "switchboard", id: "model" };
  const agent = opts.agent ?? "switchboard";
  const at = opts.clock ?? tickingClock(opts.at);

  // The result each in-flight call is settled with (by tool-use id): the
  // following user turn's tool_result (an error only when it was one), else the
  // settlement note for a call in flight at the death, which is always an error
  // — the call was interrupted and its result lost.
  const resultOf = (toolUseId: string, from: number): { text: string; isError: boolean } => {
    for (let i = from; i < messages.length; i++) {
      const turn = messages[i];
      if (turn.role !== "user") break;
      for (const part of turn.content) {
        if (part.type === "tool_result" && part.toolUseId === toolUseId) {
          const text =
            typeof part.content === "string"
              ? part.content
              : part.content.map((c) => (c.type === "text" ? c.text : `[${c.type}]`)).join("\n");
          return { text, isError: part.isError === true };
        }
      }
    }
    return { text: opts.settlements?.get(toolUseId) ?? "", isError: true };
  };

  messages.forEach((message, i) => {
    if (message.role === "user") {
      // A user turn that is only tool results is the previous assistant's
      // results, already folded in; a user turn with text is a store message.
      const text = textOf(message.content);
      const onlyResults = message.content.length > 0 && message.content.every((p) => p.type === "tool_result");
      if (onlyResults) return;
      out.push({ id: `msg_${opts.sessionID}_u${i}`, type: "user", text, time: { created: at() } });
      return;
    }
    const content: Record<string, unknown>[] = [];
    for (const part of message.content) {
      if (part.type === "text") content.push({ type: "text", text: part.text });
      else if (part.type === "tool_use") {
        const result = resultOf(part.id, i + 1);
        content.push(openCodeToolContent(part, result.text, at(), result.isError));
      }
    }
    if (content.length === 0) return;
    const now = at();
    out.push({
      id: `msg_${opts.sessionID}_a${i}`,
      type: "assistant",
      agent,
      model,
      content,
      time: { created: now, completed: now },
    });
  });
  return out;
}

/** The import body OpenCode accepts (`SessionTransfer.Data`): the session info
 *  and the store messages. `projectID` is a placeholder — the import resolves
 *  the project from `location.directory` and ignores it — and every count is
 *  zero, the proxy being the meter. The compaction entries, when the rebuild
 *  carries them, are appended as compaction messages in order (a fresh seed
 *  carries none). */
export function openCodeImportBody(
  messages: readonly ChatMessage[],
  opts: OpenCodeImportOptions & { compactions?: readonly CompactionEntry[]; settlements?: OpenCodeSettlements },
): { info: Record<string, unknown>; messages: Record<string, unknown>[]; location: { directory: string } } {
  // One clock for the whole body: every message, tool content and compaction
  // is stamped a millisecond later than the last, so the order is stable and
  // no compaction collides with a tool content stamped earlier.
  const clock = tickingClock(opts.at);
  const storeMessages = openCodeStoreMessages(messages, { ...opts, clock });
  (opts.compactions ?? []).forEach((entry, i) =>
    storeMessages.push(openCodeCompactionMessage(`msg_${opts.sessionID}_c${i}`, entry, clock())),
  );
  const info: Record<string, unknown> = {
    id: opts.sessionID,
    projectID: "global",
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    time: { created: opts.at, updated: opts.at },
    location: opts.location,
    ...(opts.agent ? { agent: opts.agent } : {}),
    ...(opts.model ? { model: opts.model } : {}),
  };
  return { info, messages: storeMessages, location: opts.location };
}

/** The prompt text a fresh run is driven with: the seed's last user turn (the
 *  request), which the import leaves out so `POST …/prompt` adds it once. Split
 *  as pi's `splitSeed` does — the turns before the last user turn are the
 *  seed, the last user turn is the request. */
export function openCodeSeedAndRequest(messages: readonly ChatMessage[]): {
  seed: ChatMessage[];
  request: string;
} {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === "user") {
      return { seed: messages.slice(0, i), request: textOf(messages[i].content) };
    }
  }
  return { seed: messages.slice(), request: "" };
}
