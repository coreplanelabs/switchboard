import type { ConversationRef } from "./types.js";

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
  /** Sharing is an audience fact, independent of native public/private visibility. */
  shared?: boolean;
  readKind: "reference" | "thread" | "nearby" | "link" | "file";
  messages: readonly { id: string; hash: string }[];
  coverage: SourceCoverage;
  file?: { id: string; hash: string };
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

export const SOURCE_READ_MESSAGE_MAX = 50;

/** Structural evidence validation independent of a current session owner. */
export function isSlackSourceReceipt(value: unknown): value is SlackSourceReceipt {
  if (!value || typeof value !== "object") return false;
  const r = value as SlackSourceReceipt;
  const address = (a: SourceAddress) =>
    a &&
    typeof a.channelId === "string" &&
    a.channelId.length <= 256 &&
    typeof a.threadKey === "string" &&
    a.threadKey.length <= 256;
  const hash = (h: unknown) => typeof h === "string" && /^[a-f0-9]{64}$/.test(h);
  return (
    r.kind === "slack-source" &&
    typeof r.requester === "string" &&
    r.requester.length <= 256 &&
    !!address(r.origin) &&
    !!address(r.destination) &&
    !!address(r.source) &&
    typeof r.source.url === "string" &&
    r.source.url.length <= 2048 &&
    ["public", "private", "dm"].includes(r.visibility) &&
    (r.shared === undefined || typeof r.shared === "boolean") &&
    ["reference", "thread", "nearby", "link", "file"].includes(r.readKind) &&
    !!r.coverage &&
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
        hash(r.file.hash))
  );
}
