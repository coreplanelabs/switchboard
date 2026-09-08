// The transcript on the wire (features/run-history.md item 32). The runner's
// `messages` array is append-only, so the durable form is one row per content
// part: no row nears the Durable Object's 2 MB limit, a step writes only its
// new turns, and the read side assembles the exact array — thinking blocks and
// all — or names the gap. Base64 attachment data over a threshold is stored
// once and referenced, so a 20 MB PDF in the seed is one attachment row, not
// a 20 MB part row.

import type { ChatMessage, ContentPart } from "../../providers/types.js";
import { utf8ByteLength } from "../runRecord.js";
import { ATTACHMENT_REF_BYTES, TRANSCRIPT_PART_BYTES, type TranscriptAttachment, type TranscriptRow } from "./types.js";

// Every budget here is in UTF-8 BYTES, measured with `utf8ByteLength`, because
// the fences they must stay under are bytes: the Worker's Content-Length check
// and the Durable Object's row limit. `String.length` counts UTF-16 code units,
// and JSON.stringify leaves non-ASCII literal, so a 1.4M-character CJK part is
// ~4.2 MB on the wire.

/** The stored form of one part: the turn's role rides on every row so a turn
 *  is reconstructible from its rows alone. */
interface StoredPart {
  role: ChatMessage["role"];
  part: ContentPart | (ContentPart & { dataRef: string });
}

const attachmentRef = (idx: number, part: number) => `t${idx}p${part}`;

function hasData(part: ContentPart): part is ContentPart & { data: string; mediaType: string } {
  return (part.type === "image" || part.type === "document") && typeof (part as { data?: unknown }).data === "string";
}

/** One turn → its rows (and any externalized attachments). Refuses a part the
 *  row budget cannot hold: a transcript is never truncated. */
export function turnRows(
  idx: number,
  message: ChatMessage,
  opts: { partBytes?: number; attachmentRefBytes?: number } = {},
): { rows: TranscriptRow[]; attachments: TranscriptAttachment[] } {
  const partBytes = opts.partBytes ?? TRANSCRIPT_PART_BYTES;
  const refBytes = opts.attachmentRefBytes ?? ATTACHMENT_REF_BYTES;
  const rows: TranscriptRow[] = [];
  const attachments: TranscriptAttachment[] = [];
  message.content.forEach((part, i) => {
    let stored: StoredPart["part"] = part;
    if (hasData(part) && part.data.length > refBytes) {
      const ref = attachmentRef(idx, i);
      attachments.push({ ref, mediaType: part.mediaType, data: part.data });
      stored = { ...(part as ContentPart), data: "", dataRef: ref } as StoredPart["part"];
    }
    const json = JSON.stringify({ role: message.role, part: stored } satisfies StoredPart);
    const bytes = utf8ByteLength(json);
    if (bytes > partBytes) {
      throw new Error(`transcript: part ${i} of turn ${idx} is ${bytes} bytes, over the ${partBytes} row budget`);
    }
    rows.push({ idx, part: i, json });
  });
  return { rows, attachments };
}

/** Pack rows into requests whose JSON stays under `maxBytes`, in order. A
 *  single row larger than the fence travels alone (the row budget already
 *  bounds it below the fence in production). */
export function chunkRows(rows: readonly TranscriptRow[], maxBytes: number): TranscriptRow[][] {
  const chunks: TranscriptRow[][] = [];
  let current: TranscriptRow[] = [];
  let size = 2; // the array brackets
  for (const row of rows) {
    const rowSize = utf8ByteLength(JSON.stringify(row)) + 1;
    if (current.length > 0 && size + rowSize > maxBytes) {
      chunks.push(current);
      current = [];
      size = 2;
    }
    current.push(row);
    size += rowSize;
  }
  if (current.length > 0) chunks.push(current);
  return chunks;
}

export type AssembledTranscript =
  | { complete: true; turns: number; messages: ChatMessage[] }
  | { complete: false; turns: number; messages: ChatMessage[]; gap: string };

/** Rows (any order) → the turns, contiguous from 0. Stops at the first gap and
 *  says where it is; the turns before it are returned so an `interrupted`
 *  record can still carry what was stored. */
export function assembleTranscript(
  rows: readonly TranscriptRow[],
  attachments: readonly TranscriptAttachment[],
): AssembledTranscript {
  const byRef = new Map(attachments.map((a) => [a.ref, a]));
  const byTurn = new Map<number, Map<number, StoredPart>>();
  for (const row of rows) {
    let parts = byTurn.get(row.idx);
    if (!parts) byTurn.set(row.idx, (parts = new Map()));
    parts.set(row.part, JSON.parse(row.json) as StoredPart);
  }
  const messages: ChatMessage[] = [];
  const turnCount = byTurn.size === 0 ? 0 : Math.max(...byTurn.keys()) + 1;
  for (let idx = 0; idx < turnCount; idx++) {
    const parts = byTurn.get(idx);
    if (!parts) return { complete: false, turns: messages.length, messages, gap: `turn ${idx} is missing` };
    const content: ContentPart[] = [];
    let role: ChatMessage["role"] | undefined;
    const partCount = Math.max(...parts.keys()) + 1;
    for (let p = 0; p < partCount; p++) {
      const stored = parts.get(p);
      if (!stored)
        return { complete: false, turns: messages.length, messages, gap: `turn ${idx} is missing part ${p}` };
      role = stored.role;
      const part = stored.part as ContentPart & { dataRef?: string };
      if (part.dataRef !== undefined) {
        const att = byRef.get(part.dataRef);
        if (!att)
          return { complete: false, turns: messages.length, messages, gap: `attachment ${part.dataRef} is missing` };
        const { dataRef: _ref, ...rest } = part;
        content.push({ ...rest, data: att.data } as ContentPart);
      } else {
        content.push(part);
      }
    }
    messages.push({ role: role ?? "user", content });
  }
  return { complete: true, turns: messages.length, messages };
}
