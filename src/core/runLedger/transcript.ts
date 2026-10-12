import { parseStoredJson } from "../storedJson.js";
// The transcript on the wire (docs/reference/specs/run-history.md item 32). The runner's
// `messages` array is append-only, so the durable form is one row per content
// part: no row nears the Durable Object's 2 MB limit, a step writes only its
// new turns, and the read side assembles the exact array — thinking blocks and
// all — or names the gap. Base64 attachment data over a threshold is stored
// by bounded Memory transport chunks. Successful reads reconstruct ordinary
// parts; the physical codec never becomes a provider content type.

import { sha256Hex } from "../ship/coordinator.js";
import type { ChatMessage, ContentPart } from "../chatMessage.js";
import { isSourceResultReceipt, type SourceResultReceipt } from "../references/sourceResultContext.js";
import { isContextDependencies, type ContextDependencies } from "../references/contextDependencies.js";
import { utf8ByteLength } from "../runRecord.js";
import {
  ATTACHMENT_REF_BYTES,
  TRANSCRIPT_PART_BYTES,
  TRANSCRIPT_READ_BYTES,
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
 *  is reconstructible from its rows alone. The actor is the platform-namespaced
 *  id of the person who authored the turn (e.g. `slack:U…`); absent for
 *  machine turns and rows written before record 0057. */
export interface StoredPart {
  role: ChatMessage["role"];
  part: ContentPart | (ContentPart & { dataRef: string });
  actor?: string;
  silent?: true;
  folded?: true;
  /** Explicit append-producer metadata; never inferred from message content. */
  context?: ContextDependencies;
  sourceResult?: SourceResultReceipt;
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
 *  is one row at its index, part 0. The optional `actor` is the
 *  platform-namespaced id of the person who authored the turn (absent for
 *  machine turns, compaction rows and rows written before record 0057). */
export function turnRows(
  idx: number,
  message: ChatMessage | StoredCompaction,
  opts: { partBytes?: number; attachmentRefBytes?: number; canonical?: boolean } = {},
  actor?: string,
): { rows: TranscriptRow[]; attachments: TranscriptAttachment[] } {
  const partBytes = opts.canonical ? Infinity : (opts.partBytes ?? TRANSCRIPT_PART_BYTES);
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
    const json = JSON.stringify({
      role: message.role,
      part: stored,
      ...(actor !== undefined ? { actor } : {}),
      ...(part.type === "tool_result" &&
      message.sourceResults?.find((r) => isSourceResultReceipt(r) && r.callId === part.toolUseId)
        ? { sourceResult: message.sourceResults.find((r) => isSourceResultReceipt(r) && r.callId === part.toolUseId) }
        : {}),
    } satisfies StoredPart);
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
  | {
      complete: true;
      turns: number;
      messages: ChatMessage[];
      compactions: AssembledCompaction[];
      /** Each message's author (`StoredPart.actor`), aligned with `messages`;
       *  present only when at least one row carries one — the verifier selects
       *  the author's own turns by it (record 0057). */
      actors?: (string | undefined)[];
      marks?: Array<{ silent?: true; folded?: true }>;
      contexts?: (ContextDependencies | undefined)[];
    }
  | {
      complete: false;
      turns: number;
      messages: ChatMessage[];
      compactions: AssembledCompaction[];
      actors?: (string | undefined)[];
      marks?: Array<{ silent?: true; folded?: true }>;
      contexts?: (ContextDependencies | undefined)[];
      gap: string;
    };

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
    parts.set(row.part, parseStoredJson(row.json) as StoredRow);
  }
  const messages: ChatMessage[] = [];
  const compactions: AssembledCompaction[] = [];
  const actorList: (string | undefined)[] = [];
  const marks: Array<{ silent?: true; folded?: true }> = [];
  const contexts: (ContextDependencies | undefined)[] = [];
  const actorsOrNone = () => ({
    ...(actorList.some((a) => a !== undefined) ? { actors: actorList } : {}),
    ...(marks.some((mark) => mark.silent || mark.folded) ? { marks } : {}),
    ...(contexts.some((context) => context !== undefined) ? { contexts } : {}),
  });
  /** The `messages` index each turn index landed at (a compaction row lands nowhere). */
  const messageIndexOf = new Map<number, number>();
  const gap = (why: string): AssembledTranscript => ({
    complete: false,
    turns: messages.length + compactions.length,
    messages,
    compactions,
    ...actorsOrNone(),
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
    const sourceResults: SourceResultReceipt[] = [];
    let role: ChatMessage["role"] | undefined;
    const partCount = Math.max(...parts.keys()) + 1;
    for (let p = 0; p < partCount; p++) {
      const stored = parts.get(p);
      if (!stored || "compaction" in stored) return gap(`turn ${idx} is missing part ${p}`);
      role = stored.role;
      if (isSourceResultReceipt(stored.sourceResult)) sourceResults.push(stored.sourceResult);
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
    messages.push({ role: role ?? "user", content, ...(sourceResults.length ? { sourceResults } : {}) });
    actorList.push(first && !("compaction" in first) ? first.actor : undefined);
    const context = first && !("compaction" in first) ? first.context : undefined;
    contexts.push(
      isContextDependencies(context) &&
        [...parts.values()].every(
          (part) => !("compaction" in part) && JSON.stringify(part.context) === JSON.stringify(context),
        )
        ? context
        : undefined,
    );
    marks.push(
      first && !("compaction" in first)
        ? {
            ...(first.silent === true ? { silent: true as const } : {}),
            ...(first.folded === true ? { folded: true as const } : {}),
          }
        : {},
    );
  }
  for (const c of compactions) {
    if (c.entry.keptFrom === undefined) continue;
    const kept = messageIndexOf.get(c.entry.keptFrom - base);
    if (kept !== undefined) c.keptBefore = kept;
  }
  return { complete: true, turns: messages.length + compactions.length, messages, compactions, ...actorsOrNone() };
}

/** Physical Memory encoding only. Successful reads always project StoredRow. */
interface InternalRow {
  role: ChatMessage["role"];
  part: null;
  actor?: string;
  internalTranscript: {
    version: 1;
    utf8Bytes: number;
    sha256: string;
    refs: Array<{ ref: string; utf8Bytes: number; sha256: string }>;
  };
}
export class RequiredTranscriptError extends Error {
  constructor(message = "content unavailable") {
    super(`required transcript: ${message}`);
    this.name = "RequiredTranscriptError";
  }
}
const CHUNK_MEDIA = "application/x-switchboard-transcript-v1";
export function isInternalTranscript(json: string): boolean {
  return JSON.parse(json)?.internalTranscript !== undefined;
}
function internalDescriptor(stored: unknown): InternalRow["internalTranscript"] {
  const row = stored as InternalRow;
  const d = row?.internalTranscript;
  if (
    !d ||
    typeof d !== "object" ||
    d.version !== 1 ||
    !Array.isArray(d.refs) ||
    !d.refs.length ||
    !Number.isSafeInteger(d.utf8Bytes) ||
    d.utf8Bytes < 1 ||
    typeof d.sha256 !== "string" ||
    !/^[0-9a-f]{64}$/.test(d.sha256)
  )
    throw new RequiredTranscriptError("unknown codec");
  const seen = new Set<string>();
  for (const r of d.refs) {
    if (
      !r ||
      typeof r !== "object" ||
      typeof r.ref !== "string" ||
      !r.ref ||
      typeof r.sha256 !== "string" ||
      !/^[0-9a-f]{64}$/.test(r.sha256) ||
      !Number.isSafeInteger(r.utf8Bytes) ||
      r.utf8Bytes < 1 ||
      seen.has(r.ref)
    )
      throw new RequiredTranscriptError("invalid chunk descriptor");
    seen.add(r.ref);
  }
  return d;
}
export function storedAttachmentRefs(json: string): string[] {
  let stored;
  try {
    stored = JSON.parse(json);
  } catch {
    throw new RequiredTranscriptError("invalid stored row");
  }
  if (stored?.internalTranscript !== undefined) return internalDescriptor(stored).refs.map((r) => r.ref);
  const refs: string[] = [];
  if (typeof stored?.part?.dataRef === "string") refs.push(stored.part.dataRef);
  if (stored?.part?.type === "tool_result" && Array.isArray(stored.part.content))
    for (const c of stored.part.content) if (typeof c?.dataRef === "string") refs.push(c.dataRef);
  return refs;
}
export function assertTranscriptReadBudget<T>(value: T): T {
  if (utf8ByteLength(JSON.stringify(value)) > TRANSCRIPT_READ_BYTES)
    throw new RequiredTranscriptError("read exceeds existing RPC budget");
  return value;
}
export function validTranscriptChunk(attachment: TranscriptAttachment): boolean {
  if (!attachment.ref.includes(":v1:")) return true;
  const hash = attachment.ref.split(":").at(-1);
  return (
    attachment.mediaType === CHUNK_MEDIA &&
    hash === sha256Hex(attachment.data) &&
    utf8ByteLength(JSON.stringify(attachment)) <= TRANSCRIPT_PART_BYTES
  );
}
export function boundedTranscript(
  rows: readonly TranscriptRow[],
  attachments: readonly TranscriptAttachment[],
): { rows: TranscriptRow[]; attachments: TranscriptAttachment[] } {
  const out: TranscriptRow[] = [],
    blobs: TranscriptAttachment[] = [];
  for (const row of rows) {
    const refs = storedAttachmentRefs(row.json),
      associated = attachments.filter((a) => refs.includes(a.ref));
    const body = JSON.parse(row.json);
    const indexedText =
      body.part?.type === "text"
        ? body.part.text
        : body.part?.type === "tool_result" && typeof body.part.content === "string"
          ? body.part.content
          : (body.compaction?.summary ?? "");
    const large =
      utf8ByteLength(row.json) + utf8ByteLength(indexedText) + 512 > TRANSCRIPT_PART_BYTES ||
      utf8ByteLength(JSON.stringify(row)) > TRANSCRIPT_PART_BYTES ||
      associated.some((a) => utf8ByteLength(JSON.stringify(a)) > TRANSCRIPT_PART_BYTES);
    if (!large) {
      out.push(row);
      for (const a of associated) if (!blobs.some((b) => b.ref === a.ref)) blobs.push(a);
      continue;
    }
    if ("compaction" in body) throw new RequiredTranscriptError("compaction exceeds existing row budget");
    const data = JSON.stringify({ row: JSON.parse(row.json), attachments: associated });
    if (new TextDecoder().decode(new TextEncoder().encode(data)) !== data)
      throw new RequiredTranscriptError("nonlossless UTF8");
    const whole = sha256Hex(data),
      parts: InternalRow["internalTranscript"]["refs"] = [];
    let offset = 0;
    while (offset < data.length) {
      let lo = offset + 1,
        hi = data.length,
        end = offset;
      const prefix = `t${row.idx}p${row.part}:v1:${whole}:${parts.length}:`;
      while (lo <= hi) {
        const mid = Math.floor((lo + hi) / 2);
        const value = data.slice(offset, mid);
        if (
          utf8ByteLength(JSON.stringify({ ref: prefix + "0".repeat(64), mediaType: CHUNK_MEDIA, data: value })) <=
          TRANSCRIPT_PART_BYTES - 4096
        ) {
          end = mid;
          lo = mid + 1;
        } else hi = mid - 1;
      }
      if (end < data.length && data.charCodeAt(end - 1) >= 0xd800 && data.charCodeAt(end - 1) <= 0xdbff) end--;
      if (end <= offset) throw new RequiredTranscriptError("chunk budget");
      const value = data.slice(offset, end),
        hash = sha256Hex(value),
        ref = prefix + hash;
      parts.push({ ref, sha256: hash, utf8Bytes: utf8ByteLength(value) });
      blobs.push({ ref, mediaType: CHUNK_MEDIA, data: value });
      offset = end;
    }
    const original = JSON.parse(row.json);
    out.push({
      ...row,
      json: JSON.stringify({
        ...original,
        part: null,
        internalTranscript: { version: 1, sha256: whole, utf8Bytes: utf8ByteLength(data), refs: parts },
      }),
    });
  }
  return { rows: out, attachments: blobs };
}
export function projectTranscriptRows<T extends TranscriptRow>(
  rows: readonly T[],
  attachments: readonly TranscriptAttachment[],
): { rows: T[]; attachments: TranscriptAttachment[] } {
  const ordinary: T[] = [],
    blobs = attachments.filter((a) => !a.ref.includes(":v1:"));
  for (const row of rows) {
    let stored: InternalRow;
    try {
      stored = JSON.parse(row.json);
    } catch (error) {
      if (row.json.includes('"internalTranscript"')) throw new RequiredTranscriptError("invalid stored row");
      throw error;
    }
    if (stored?.internalTranscript === undefined) {
      ordinary.push(row);
      continue;
    }
    const descriptor = internalDescriptor(stored);
    if (
      stored.part !== null ||
      descriptor.version !== 1 ||
      !Array.isArray(descriptor.refs) ||
      !descriptor.refs.length ||
      !/^[0-9a-f]{64}$/.test(descriptor.sha256) ||
      !Number.isSafeInteger(descriptor.utf8Bytes)
    )
      throw new RequiredTranscriptError("unknown codec");
    const seen = new Set<string>();
    const pieces: string[] = [];
    for (const [index, ref] of descriptor.refs.entries()) {
      if (!ref.ref.startsWith(`t${row.idx}p${row.part}:v1:${descriptor.sha256}:${index}:`))
        throw new RequiredTranscriptError("reordered chunk");
      const matches = attachments.filter((a) => a.ref === ref.ref);
      if (seen.has(ref.ref) || matches.length !== 1) throw new RequiredTranscriptError("missing or duplicate chunk");
      seen.add(ref.ref);
      const part = matches[0]!;
      if (
        !validTranscriptChunk(part) ||
        sha256Hex(part.data) !== ref.sha256 ||
        utf8ByteLength(part.data) !== ref.utf8Bytes
      )
        throw new RequiredTranscriptError("corrupt chunk");
      pieces.push(part.data);
    }
    const value = pieces.join("");
    if (sha256Hex(value) !== descriptor.sha256 || utf8ByteLength(value) !== descriptor.utf8Bytes)
      throw new RequiredTranscriptError("corrupt part");
    let decoded: { row: StoredPart; attachments: TranscriptAttachment[] };
    try {
      decoded = JSON.parse(value);
    } catch {
      throw new RequiredTranscriptError("invalid part");
    }
    const outer = { ...stored } as unknown as Record<string, unknown>;
    delete outer.internalTranscript;
    outer.part = decoded.row?.part;
    if (JSON.stringify(outer) !== JSON.stringify(decoded.row))
      throw new RequiredTranscriptError("changed row metadata");
    if (!decoded.row?.part || !["user", "assistant"].includes(decoded.row.role) || !Array.isArray(decoded.attachments))
      throw new RequiredTranscriptError("invalid part");
    ordinary.push({ ...row, json: JSON.stringify(decoded.row) });
    for (const part of decoded.attachments) {
      if (
        !part ||
        typeof part !== "object" ||
        typeof part.ref !== "string" ||
        typeof part.mediaType !== "string" ||
        typeof part.data !== "string"
      )
        throw new RequiredTranscriptError("invalid decoded attachment");
      const previous = blobs.find((b) => b.ref === part.ref);
      if (previous && JSON.stringify(previous) !== JSON.stringify(part))
        throw new RequiredTranscriptError("conflicting reference");
      if (!previous) blobs.push(part);
    }
  }
  const projected = { rows: ordinary, attachments: blobs };
  return assertTranscriptReadBudget(projected);
}
export function logicalTranscriptBytes(row: TranscriptRow, attachments: readonly TranscriptAttachment[]): number {
  const projected = projectTranscriptRows([row], attachments);
  return (
    utf8ByteLength(projected.rows[0]!.json) +
    projected.attachments
      .filter((a) => storedAttachmentRefs(projected.rows[0]!.json).includes(a.ref))
      .reduce((n, a) => n + utf8ByteLength(a.data), 0)
  );
}
