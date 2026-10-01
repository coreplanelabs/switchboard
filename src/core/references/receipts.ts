import type { ToolResultContent } from "../chatMessage.js";
import type { ConversationRef, ReferencedConversation } from "./types.js";

/** Trusted adapter facts. These never travel in model content or tool arguments. */
export interface SourceAddress {
  channelId: string;
  threadKey: string;
}
export interface SourceBinding {
  requester: string;
  origin: SourceAddress;
  destination: SourceAddress;
}
export interface SourceCoverage {
  /** Exactly these messages were consumed; this is not a claim to read the whole source. */
  kind: "complete" | "bounded";
  truncated: boolean;
}
export interface SlackSourceReceipt extends SourceBinding {
  kind: "slack-source";
  source: ConversationRef;
  visibility: "public" | "private" | "dm";
  readKind: "reference" | "thread" | "nearby" | "link" | "file";
  messages: readonly { id: string; hash: string }[];
  coverage: SourceCoverage;
  file?: { id: string; hash: string };
}
export type SlackSourceRead =
  { kind: "read"; content: ToolResultContent; receipt: SlackSourceReceipt } | { kind: "refused"; content: string };

/** Missing metadata means legacy/unknown, never a receipt inferred from prose. */
export type SessionSources =
  | { version: 1; status: "known"; binding: SourceBinding; receipts: readonly SlackSourceReceipt[] }
  | { version: 1; status: "unknown" | "revoked" };
/** Bound durable metadata and the work needed to check every retained dependency. */
export const SOURCE_RECEIPT_MAX = 8;
export const SOURCE_MESSAGE_MAX = 80;
export const SOURCE_READ_MESSAGE_MAX = 50;
export const SOURCE_METADATA_MAX_BYTES = 32 * 1024;
export const UNKNOWN_SOURCES: SessionSources = { version: 1, status: "unknown" };

export function sourceBinding(msg: { userId: string; channelId: string; threadKey: string }): SourceBinding {
  return {
    requester: msg.userId,
    origin: { channelId: msg.channelId, threadKey: msg.threadKey },
    destination: { channelId: msg.channelId, threadKey: msg.threadKey },
  };
}
export function sameSourceBinding(receipt: SourceBinding, binding: SourceBinding): boolean {
  return (
    receipt.requester === binding.requester &&
    receipt.origin.channelId === binding.origin.channelId &&
    receipt.origin.threadKey === binding.origin.threadKey &&
    receipt.destination.channelId === binding.destination.channelId &&
    receipt.destination.threadKey === binding.destination.threadKey
  );
}
export async function sourceHash(value: unknown): Promise<string> {
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  return Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)), (b) =>
    b.toString(16).padStart(2, "0"),
  ).join("");
}
export function referenceReceipt(
  conversation: ReferencedConversation,
  visibility: "public" | "private",
  binding: SourceBinding,
): SlackSourceReceipt | undefined {
  if (!conversation.coverage || conversation.messages.some((m) => !m.ts || !m.sourceHash)) return undefined;
  return {
    kind: "slack-source",
    ...binding,
    source: conversation.ref,
    visibility,
    readKind: "reference",
    messages: conversation.messages.map((m) => ({ id: m.ts!, hash: m.sourceHash! })),
    coverage: conversation.coverage,
  };
}
export function addSourceReceipt(state: SessionSources, receipt: SlackSourceReceipt): SessionSources {
  if (state.status !== "known") return state;
  if (state.receipts.some((r) => JSON.stringify(r) === JSON.stringify(receipt))) return state;
  const next = { ...state, receipts: [...state.receipts, receipt] };
  return isSessionSources(next) ? next : UNKNOWN_SOURCES;
}

/** Validate the storage boundary, not natural-language content. */
export function isSessionSources(value: unknown): value is SessionSources {
  if (!value || typeof value !== "object") return false;
  if (new TextEncoder().encode(JSON.stringify(value)).byteLength > SOURCE_METADATA_MAX_BYTES) return false;
  const s = value as SessionSources;
  if (s.version !== 1) return false;
  if (s.status === "unknown" || s.status === "revoked") return true;
  if (s.status !== "known" || !Array.isArray(s.receipts) || s.receipts.length > SOURCE_RECEIPT_MAX) return false;
  const address = (a: SourceAddress) =>
    a &&
    typeof a.channelId === "string" &&
    a.channelId.length <= 256 &&
    typeof a.threadKey === "string" &&
    a.threadKey.length <= 256;
  const hash = (h: unknown) => typeof h === "string" && /^[a-f0-9]{64}$/.test(h);
  if (
    !s.binding ||
    typeof s.binding.requester !== "string" ||
    s.binding.requester.length > 256 ||
    !address(s.binding.origin) ||
    !address(s.binding.destination)
  )
    return false;
  if (
    s.receipts.reduce((count, r) => count + (Array.isArray(r?.messages) ? r.messages.length : 0), 0) >
    SOURCE_MESSAGE_MAX
  )
    return false;
  return s.receipts.every(
    (r) =>
      r &&
      r.kind === "slack-source" &&
      typeof r.requester === "string" &&
      address(r.origin) &&
      address(r.destination) &&
      sameSourceBinding(r, s.binding) &&
      address(r.source) &&
      typeof r.source.url === "string" &&
      r.source.url.length <= 2048 &&
      ["public", "private", "dm"].includes(r.visibility) &&
      ["reference", "thread", "nearby", "link", "file"].includes(r.readKind) &&
      r.coverage &&
      ["complete", "bounded"].includes(r.coverage.kind) &&
      typeof r.coverage.truncated === "boolean" &&
      Array.isArray(r.messages) &&
      r.messages.length <= SOURCE_READ_MESSAGE_MAX &&
      r.messages.every(
        (m: { id: string; hash: string }) =>
          m && typeof m.id === "string" && m.id.length > 0 && m.id.length <= 64 && hash(m.hash),
      ) &&
      new Set(r.messages.map((m: { id: string }) => m.id)).size === r.messages.length &&
      (r.file === undefined
        ? r.readKind !== "file"
        : r.file !== null &&
          r.readKind === "file" &&
          typeof r.file.id === "string" &&
          r.file.id.length <= 256 &&
          hash(r.file.hash)),
  );
}

/** A later writer cannot remove dependencies, restore a revoked session, or relabel its audience. */
export function mergeSessionSources(
  previous: SessionSources | undefined,
  next: SessionSources,
  fresh: boolean,
): SessionSources {
  if (!previous) return fresh ? next : UNKNOWN_SOURCES;
  if (previous.status !== "known") return previous;
  if (next.status !== "known") return next;
  if (!sameSourceBinding(previous.binding, next.binding)) return UNKNOWN_SOURCES;
  return next.receipts.reduce(addSourceReceipt, previous);
}

export function sourcesBelongToSession(key: string, sources: SessionSources): boolean {
  return sources.status !== "known" || key.startsWith(`${sources.binding.origin.threadKey}:`);
}
