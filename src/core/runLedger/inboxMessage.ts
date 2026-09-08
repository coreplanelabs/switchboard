// The durable shape of a message on the run ledger (docs/reference/specs/run-history.md
// items 40 and 42): a steered follow-up in `run_inbox`, and the request a run
// was admitted for in its row's `meta.request`. One writer, one reader, so a
// row written by one generation is read the same way by the next.

import type { IncomingMessage } from "../types.js";

/** The most a durable inbox row may weigh, serialized: the state Worker caps
 *  `/runs/inbox` bodies at 512 KiB (`MAX_BODY_BYTES`), and the row travels
 *  inside a JSON envelope with the store key and run id. */
export const DURABLE_INBOX_MAX_BYTES = 400 * 1024;

type Attachment = { mediaType: string; data: string; name?: string };

/** The durable copy of a message: the text given (a follow-up's directive-free
 *  text; a request's text verbatim, directives included), sender, link, thread,
 *  arrival time — attachments included when the row stays under
 *  `DURABLE_INBOX_MAX_BYTES`, because a screenshot must survive a restart as
 *  much as its caption. Over the cap the bytes are left with the in-memory
 *  copy and the row says how many attachments it lost, so the message read
 *  back can say so too. */
export function durableInboxMessage(msg: IncomingMessage, text: string, at: number): Record<string, unknown> {
  const base: Record<string, unknown> = {
    channelId: msg.channelId,
    userId: msg.userId,
    threadKey: msg.threadKey,
    text,
    at,
    ...(msg.userName !== undefined ? { userName: msg.userName } : {}),
    ...(msg.sourceUrl !== undefined ? { sourceUrl: msg.sourceUrl } : {}),
    ...(msg.channelName !== undefined ? { channelName: msg.channelName } : {}),
  };
  const images = msg.images ?? [];
  const documents = msg.documents ?? [];
  if (images.length === 0 && documents.length === 0) return base;
  const withAttachments = {
    ...base,
    ...(images.length > 0 ? { images: images.map(attachmentRow) } : {}),
    ...(documents.length > 0 ? { documents: documents.map(attachmentRow) } : {}),
  };
  // Bytes as the Worker counts them (Content-Length), not UTF-16 code units.
  if (Buffer.byteLength(JSON.stringify(withAttachments), "utf8") <= DURABLE_INBOX_MAX_BYTES) return withAttachments;
  // All or nothing by design: a partial carry would hand the model some of the
  // sender's attachments as if they were all of them; the note names the count.
  return { ...base, attachmentsDropped: { images: images.length, documents: documents.length } };
}

const attachmentRow = (a: Attachment) => ({
  mediaType: a.mediaType,
  data: a.data,
  ...(a.name !== undefined ? { name: a.name } : {}),
});

/** A durable row back as the message it was: text (with the dropped-attachments
 *  note appended when the row says it lost some), sender, link, thread,
 *  attachments as typed parts, and the arrival time (`fallbackAt` when the row
 *  has none). Undefined when the stored shape is not one this build wrote —
 *  the caller skips it, never fatal. */
export function messageFromInbox(
  stored: Record<string, unknown>,
  fallbackAt: number,
): { msg: IncomingMessage; at: number } | undefined {
  const m = stored;
  const str = (k: string): string | undefined => (typeof m[k] === "string" ? (m[k] as string) : undefined);
  const text = str("text");
  const userId = str("userId");
  const threadKey = str("threadKey");
  const channelId = str("channelId");
  if (text === undefined || userId === undefined || threadKey === undefined || channelId === undefined)
    return undefined;
  const userName = str("userName");
  const sourceUrl = str("sourceUrl");
  const channelName = str("channelName");
  const at = typeof m.at === "number" && Number.isFinite(m.at) ? m.at : fallbackAt;
  const images = attachmentsFromInbox(m.images);
  const documents = attachmentsFromInbox(m.documents);
  const note = droppedNote(m.attachmentsDropped);
  const msg: IncomingMessage = {
    channelId,
    userId,
    threadKey,
    text: note ? `${text}\n\n${note}` : text,
    ...(userName !== undefined ? { userName } : {}),
    ...(sourceUrl !== undefined ? { sourceUrl } : {}),
    ...(channelName !== undefined ? { channelName } : {}),
    ...(images ? { images } : {}),
    ...(documents ? { documents } : {}),
  };
  return { msg, at };
}

/** A stored attachment list back as typed attachments; an entry that is not
 *  `{mediaType, data}` strings is dropped, never fatal. */
function attachmentsFromInbox(v: unknown): Attachment[] | undefined {
  if (!Array.isArray(v)) return undefined;
  const out = v.flatMap((e) => {
    if (typeof e !== "object" || e === null) return [];
    const r = e as Record<string, unknown>;
    if (typeof r.mediaType !== "string" || typeof r.data !== "string") return [];
    return [{ mediaType: r.mediaType, data: r.data, ...(typeof r.name === "string" ? { name: r.name } : {}) }];
  });
  return out.length > 0 ? out : undefined;
}

/** What a message read back says when its attachments did not fit the durable row. */
function droppedNote(dropped: unknown): string | undefined {
  if (typeof dropped !== "object" || dropped === null) return undefined;
  const d = dropped as Record<string, unknown>;
  const n = (typeof d.images === "number" ? d.images : 0) + (typeof d.documents === "number" ? d.documents : 0);
  if (n <= 0) return undefined;
  return `(${n} attachment${n === 1 ? "" : "s"} from this reply could not be carried across the bot's restart and ${n === 1 ? "is" : "are"} not attached.)`;
}
