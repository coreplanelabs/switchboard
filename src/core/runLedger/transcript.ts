// The transcript on the wire (docs/reference/specs/run-history.md item 32). The runner's
// `messages` array is append-only, so the durable form is one row per content
// part: no row nears the Durable Object's 2 MB limit, a step writes only its
// new turns, and the read side assembles the exact array — thinking blocks and
// all — or names the gap. Base64 attachment data over a threshold is stored
// once and referenced, so a 20 MB PDF in the seed is one attachment row, not
// a 20 MB part row.

import type { ChatMessage, ContentPart } from "../chatMessage.js";
import { utf8ByteLength } from "../runRecord.js";
import {
  ATTACHMENT_REF_BYTES,
  TRANSCRIPT_PART_BYTES,
  type CompactionEntry,
  type TranscriptAttachment,
  type TranscriptRow,
} from "./types.js";

// Every budget here is in UTF-8 BYTES, measured with `utf8ByteLength`, because
// the fences they must stay under are bytes: the Worker's Content-Length check
// and the Durable Object's row limit. `String.length` counts UTF-16 code units,
// and JSON.stringify leaves non-ASCII literal, so a 1.4M-character CJK part is
// ~4.2 MB on the wire.

/** The stored form of one part: the turn's role rides on every row so a turn
 *  is reconstructible from its rows alone. */
export interface StoredPart {
  role: ChatMessage["role"];
  part: ContentPart | (ContentPart & { dataRef: string });
}

/** The stored form of a compaction row: no role, no part — the entry alone. */
export interface StoredCompaction {
  compaction: CompactionEntry;
}

export type StoredRow = StoredPart | StoredCompaction;

const attachmentRef = (idx: number, part: number) => `t${idx}p${part}`;

function hasData(part: ContentPart): part is ContentPart & { data: string; mediaType: string } {
  return (part.type === "image" || part.type === "document") && typeof (part as { data?: unknown }).data === "string";
}

const isCompaction = (v: ChatMessage | StoredCompaction): v is StoredCompaction => "compaction" in v;

/** One turn → its rows (and any externalized attachments). Refuses a part the
 *  row budget cannot hold: a transcript is never truncated. A compaction entry
 *  is one row at its index, part 0. */
export function turnRows(
  idx: number,
  message: ChatMessage | StoredCompaction,
  opts: { partBytes?: number; attachmentRefBytes?: number } = {},
): { rows: TranscriptRow[]; attachments: TranscriptAttachment[] } {
  const partBytes = opts.partBytes ?? TRANSCRIPT_PART_BYTES;
  const refBytes = opts.attachmentRefBytes ?? ATTACHMENT_REF_BYTES;
  const rows: TranscriptRow[] = [];
  const attachments: TranscriptAttachment[] = [];
  if (isCompaction(message)) {
    const json = JSON.stringify({ compaction: message.compaction } satisfies StoredCompaction);
    const bytes = utf8ByteLength(json);
    if (bytes > partBytes) {
      throw new Error(
        `transcript: the compaction row at turn ${idx} is ${bytes} bytes, over the ${partBytes} row budget`,
      );
    }
    return { rows: [{ idx, part: 0, json }], attachments };
  }
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

/** A compaction row as the assembled transcript reports it: the entry, the
 *  index in `messages` of the first message after it (`before`), and — when
 *  the entry names `keptFrom` and that row is in the assembled span — the
 *  index in `messages` of the message pi kept first. */
export interface AssembledCompaction {
  before: number;
  entry: CompactionEntry;
  keptBefore?: number;
}

export type AssembledTranscript =
  | { complete: true; turns: number; messages: ChatMessage[]; compactions: AssembledCompaction[] }
  | { complete: false; turns: number; messages: ChatMessage[]; compactions: AssembledCompaction[]; gap: string };

/** Rows (any order) → the turns, contiguous from `base` (a log index; 0 for a
 *  run's own object), as a conversation counted from 0. `turns` counts every
 *  row index — a compaction row included, since the step records count it —
 *  while `messages` carries the conversation alone and `compactions` says
 *  where each entry sits in it. Stops at the first gap and says where it is;
 *  the turns before it are returned so an `interrupted` record can still carry
 *  what was stored. */
export function assembleTranscript(
  rows: readonly TranscriptRow[],
  attachments: readonly TranscriptAttachment[],
  base = 0,
): AssembledTranscript {
  const byRef = new Map(attachments.map((a) => [a.ref, a]));
  const byTurn = new Map<number, Map<number, StoredRow>>();
  for (const row of rows) {
    const idx = row.idx - base;
    let parts = byTurn.get(idx);
    if (!parts) byTurn.set(idx, (parts = new Map()));
    parts.set(row.part, JSON.parse(row.json) as StoredRow);
  }
  const messages: ChatMessage[] = [];
  const compactions: AssembledCompaction[] = [];
  /** The `messages` index each turn index landed at (a compaction row lands nowhere). */
  const messageIndexOf = new Map<number, number>();
  const gap = (why: string): AssembledTranscript => ({
    complete: false,
    turns: messages.length + compactions.length,
    messages,
    compactions,
    gap: why,
  });
  const turnCount = byTurn.size === 0 ? 0 : Math.max(...byTurn.keys()) + 1;
  for (let idx = 0; idx < turnCount; idx++) {
    const parts = byTurn.get(idx);
    if (!parts) return gap(`turn ${idx} is missing`);
    const first = parts.get(0);
    if (first && "compaction" in first) {
      compactions.push({ before: messages.length, entry: first.compaction });
      continue;
    }
    const content: ContentPart[] = [];
    let role: ChatMessage["role"] | undefined;
    const partCount = Math.max(...parts.keys()) + 1;
    for (let p = 0; p < partCount; p++) {
      const stored = parts.get(p);
      if (!stored || "compaction" in stored) return gap(`turn ${idx} is missing part ${p}`);
      role = stored.role;
      const part = stored.part as ContentPart & { dataRef?: string };
      if (part.dataRef !== undefined) {
        const att = byRef.get(part.dataRef);
        if (!att) return gap(`attachment ${part.dataRef} is missing`);
        const { dataRef: _ref, ...rest } = part;
        content.push({ ...rest, data: att.data } as ContentPart);
      } else {
        content.push(part);
      }
    }
    messageIndexOf.set(idx, messages.length);
    messages.push({ role: role ?? "user", content });
  }
  for (const c of compactions) {
    if (c.entry.keptFrom === undefined) continue;
    const kept = messageIndexOf.get(c.entry.keptFrom - base);
    if (kept !== undefined) c.keptBefore = kept;
  }
  return { complete: true, turns: messages.length + compactions.length, messages, compactions };
}
