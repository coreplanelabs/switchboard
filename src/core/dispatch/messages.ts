// The conversation the provision stage hands the model, and the thread context
// the run record keeps (docs/decisions/0024-dispatcher-as-a-staged-pipeline.md):
// the history and the request as provider turns — attachments first, PDFs as
// document parts, text files inlined and fenced — merged into the alternation
// providers require; and the same turns as the text-only `context` events,
// newest first within a byte budget, attachments as metadata lines.
import type { ChatMessage, ContentPart } from "../chatMessage.js";
import { redactSecrets } from "../runEvents.js";
import { utf8ByteLength } from "../runRecord.js";
import type { DocumentAttachment, HistoryItem, ImageAttachment } from "../types.js";
import { humanizeMessageText } from "./reply.js";

/** Bounds on the thread context recorded into a run's stream as `context`
 *  events: the newest turns win, at most this many, within this
 *  many bytes of redacted text in total. */
const CONTEXT_MAX_ITEMS = 20;
const CONTEXT_MAX_BYTES = 256 * 1024;

export function buildMessages(
  history: HistoryItem[],
  currentText: string,
  currentImages?: ImageAttachment[],
  currentDocuments?: DocumentAttachment[],
  references?: readonly string[],
): ChatMessage[] {
  return buildConversation(history, currentText, currentImages, currentDocuments, references).messages;
}

/** The channel seed with its authors (docs/reference/specs/session-log.md
 *  item 12, record 0057): the provider turns exactly as `buildMessages` makes
 *  them, plus — when any turn has one — the author of each, by index. */
export interface BuiltConversation {
  messages: ChatMessage[];
  /** The platform-namespaced author id per message; a machine turn's entry is
   *  undefined, and so is a merged turn's when its authors differ. Absent when
   *  no turn has an author. */
  actors?: readonly (string | undefined)[];
}

/**
 * `buildMessages` plus the authors: each user turn of the history carries its
 * `HistoryItem.user`, the request turn the requester's id, and the actors ride
 * the same merges the messages do — a merged turn keeps its author only when
 * every merged turn is that one person's, since the stored row will carry all
 * of their words (session-log item 12).
 */
export function buildConversation(
  history: HistoryItem[],
  currentText: string,
  currentImages?: ImageAttachment[],
  currentDocuments?: DocumentAttachment[],
  references?: readonly string[],
  requestActor?: string,
): BuiltConversation {
  const authored: AuthoredMessage[] = history.map((h) => ({
    role: h.role,
    content: turnContent(h.text, h.images, h.documents),
    ...(h.role === "user" && h.user !== undefined ? { actor: h.user } : {}),
  }));
  authored.push({
    role: "user",
    content: requestContent(currentText, currentImages, currentDocuments, references),
    ...(requestActor !== undefined ? { actor: requestActor } : {}),
  });
  const merged = normalizeAlternation(authored);
  const actors = merged.some((m) => m.actor !== undefined) ? merged.map((m) => m.actor) : undefined;
  return {
    messages: merged.map(({ role, content }) => ({ role, content })),
    ...(actors !== undefined ? { actors } : {}),
  };
}

/** The request turn's parts: its attachments and text (`turnContent`), then
 *  one text part per referenced conversation's quoted block (record 0037) —
 *  on the request turn, after the request's own words, never a turn of its
 *  own, so pi's `promptOf` carries the blocks with the ask and no parser that
 *  reads history meets them. Exported for the seed. */
export function requestContent(
  text: string,
  images?: ImageAttachment[],
  documents?: DocumentAttachment[],
  references?: readonly string[],
): ContentPart[] {
  const parts = turnContent(text, images, documents);
  for (const block of references ?? []) parts.push({ type: "text", text: block });
  return parts;
}

// The seed's shape and its reduction live in ./textTurns.ts, a module with no
// imports of its own, so the spawn stage can reach them without pulling this
// module's dependencies into the dashboard's typecheck.
export { textTurnsOf, type TextTurn } from "./textTurns.js";

/**
 * Attachments first (images, then documents), then the user's text — a turn
 * always has at least one part. PDFs become a native `document` part; text/code
 * files are inlined as a fenced text part naming the file (provider-agnostic).
 * Exported for tests.
 */
export function turnContent(text: string, images?: ImageAttachment[], documents?: DocumentAttachment[]): ContentPart[] {
  const parts: ContentPart[] = (images ?? []).map((img) => ({
    type: "image" as const,
    mediaType: img.mediaType,
    data: img.data,
  }));
  for (const doc of documents ?? []) {
    if (doc.mediaType === "application/pdf") {
      parts.push({ type: "document", mediaType: doc.mediaType, data: doc.data, name: doc.name });
    } else {
      parts.push({ type: "text", text: fenceFile(doc.name, doc.data) });
    }
  }
  if (text) parts.push({ type: "text", text });
  if (parts.length === 0) parts.push({ type: "text", text: "(empty message)" });
  return parts;
}

/**
 * The text recorded for one turn in the run stream: the turn's text
 * plus one metadata line per attachment — name, media type, decoded size — and
 * NEVER the attachment itself (no base64, no file body). Images and PDFs carry
 * base64 (size = decoded bytes); text/code documents carry their decoded text.
 * The text is humanized (`humanizeMessageText`: Slack link/mention markup
 * unwrapped, entities unescaped) — every caller feeds channel-authored turns.
 * Redaction happens at publish, not here.
 */
function messageText(
  text: string,
  humanize: boolean,
  images?: ImageAttachment[],
  documents?: DocumentAttachment[],
): string {
  const lines = [(humanize ? humanizeMessageText(text) : text).trim()];
  for (const img of images ?? [])
    lines.push(attachmentLine(img.name, img.mediaType, Buffer.byteLength(img.data, "base64")));
  for (const doc of documents ?? []) {
    const bytes = Buffer.byteLength(doc.data, doc.mediaType === "application/pdf" ? "base64" : "utf8");
    lines.push(attachmentLine(doc.name, doc.mediaType, bytes));
  }
  return lines.filter((l) => l.length > 0).join("\n");
}

function attachmentLine(name: string | undefined, mime: string, bytes: number): string {
  return `[attachment: ${name ?? "attachment"} · ${mime} · ${bytes} bytes]`;
}

/**
 * The thread-context turns to record as `context` events: the
 * NEWEST turns first, at most `CONTEXT_MAX_ITEMS`, until the redacted texts
 * together exceed `CONTEXT_MAX_BYTES` — then returned in thread order. Each turn is prefixed with its role so a context row reads as
 * the conversation did; attachments are metadata lines (see `messageText`).
 */
export function contextMessageTexts(history: readonly HistoryItem[], humanize: boolean): string[] {
  const kept: string[] = [];
  let bytes = 0;
  for (let i = history.length - 1; i >= 0 && kept.length < CONTEXT_MAX_ITEMS; i--) {
    const h = history[i];
    const text = `${h.role}: ${messageText(h.text, humanize, h.images, h.documents)}`;
    // Budget what will actually be published (publishText redacts).
    const size = utf8ByteLength(redactSecrets(text));
    if (bytes + size > CONTEXT_MAX_BYTES) break;
    bytes += size;
    kept.push(text);
  }
  return kept.reverse();
}

/** Inline a text/code file's content, fenced and labeled with its name. */
function fenceFile(name: string | undefined, content: string): string {
  return `\n\n[file: ${name ?? "attachment"}]\n\`\`\`\n${content}\n\`\`\`\n`;
}

/** A provider turn still carrying its author, until `buildConversation`
 *  splits the two apart. */
type AuthoredMessage = ChatMessage & { actor?: string };

/** Providers require user-first and behave best with merged consecutive roles.
 *  A merge keeps the turn's author only when both sides agree — a row of mixed
 *  or partly unknown authorship stores none (session-log item 12). */
function normalizeAlternation(messages: AuthoredMessage[]): AuthoredMessage[] {
  const out: AuthoredMessage[] = [];
  for (const m of messages) {
    const last = out[out.length - 1];
    if (last && last.role === m.role) {
      last.content.push(...m.content);
      if (last.actor !== m.actor) delete last.actor;
    } else {
      out.push({ role: m.role, content: [...m.content], ...(m.actor !== undefined ? { actor: m.actor } : {}) });
    }
  }
  while (out.length > 0 && out[0].role !== "user") out.shift();
  return out;
}
