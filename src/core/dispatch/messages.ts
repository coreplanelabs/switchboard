// The conversation the provision stage hands the model, and the thread context
// the run record keeps (docs/decisions/0024-dispatcher-as-a-staged-pipeline.md):
// the history and the request as provider turns — attachments first, PDFs as
// document parts, text files inlined and fenced — merged into the alternation
// providers require; and the same turns as the text-only `context` events,
// newest first within a byte budget, attachments as metadata lines.
import type { ChatMessage, ContentPart } from "../../providers/types.js";
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
): ChatMessage[] {
  const messages: ChatMessage[] = history.map((h) => ({
    role: h.role,
    content: turnContent(h.text, h.images, h.documents),
  }));
  messages.push({ role: "user", content: turnContent(currentText, currentImages, currentDocuments) });
  return normalizeAlternation(messages);
}

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

/** Providers require user-first and behave best with merged consecutive roles. */
function normalizeAlternation(messages: ChatMessage[]): ChatMessage[] {
  const out: ChatMessage[] = [];
  for (const m of messages) {
    const last = out[out.length - 1];
    if (last && last.role === m.role) {
      last.content.push(...m.content);
    } else {
      out.push({ role: m.role, content: [...m.content] });
    }
  }
  while (out.length > 0 && out[0].role !== "user") out.shift();
  return out;
}
