import {
  contextDependenciesOf,
  isContextDependencies,
  mergeContextDependencies,
  type ContextDependencies,
} from "./contextDependencies.js";
import {
  isSlackSourceReceipt,
  sameSourceBinding,
  type SourceAddress,
  type SourceBinding,
  type SlackSourceReceipt,
} from "./sourceReceipt.js";
export {
  sameSourceBinding,
  SOURCE_READ_MESSAGE_MAX,
  type SourceAddress,
  type SourceBinding,
  type SourceCoverage,
  type SlackSourceReceipt,
} from "./sourceReceipt.js";
import type { SlackSourceDenial } from "./denial.js";
import type { ToolResultContent } from "../chatMessage.js";
import type { ReferencedConversation } from "./types.js";

export type SlackSourceRead =
  { kind: "read"; content: ToolResultContent; receipt: SlackSourceReceipt } | SlackSourceDenial;

/** Missing metadata means legacy/unknown, never a receipt inferred from prose. */
export type SessionSources = (
  | { version: 1; status: "known"; binding: SourceBinding; receipts: readonly SlackSourceReceipt[] }
  | { version: 1; status: "unknown" | "revoked" }
) & { context?: ContextDependencies };
/** Bound durable metadata and the work needed to check every retained dependency. */
export const SOURCE_RECEIPT_MAX = 8;
export const SOURCE_MESSAGE_MAX = 80;
export const SOURCE_METADATA_MAX_BYTES = 32 * 1024;
export const UNKNOWN_SOURCES: SessionSources = { version: 1, status: "unknown" };

export function sourceBinding(msg: { userId: string; channelId: string; threadKey: string }): SourceBinding {
  return {
    requester: msg.userId,
    origin: { channelId: msg.channelId, threadKey: msg.threadKey },
    destination: { channelId: msg.channelId, threadKey: msg.threadKey },
  };
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
    ...(conversation.shared ? { shared: true } : {}),
    readKind: "reference",
    messages: conversation.messages.map((m) => ({ id: m.ts!, hash: m.sourceHash! })),
    coverage: conversation.coverage,
  };
}
export function addSourceReceipt(state: SessionSources, receipt: SlackSourceReceipt): SessionSources {
  if (state.status !== "known") return state;
  if (state.receipts.some((r) => JSON.stringify(r) === JSON.stringify(receipt))) return state;
  const context =
    state.context === undefined
      ? undefined
      : mergeContextDependencies(state.context, {
          version: 1,
          status: "known",
          revision: 0,
          origins: [],
          slack: [receipt],
          mcp: [],
        });
  const next = { ...state, receipts: [...state.receipts, receipt], ...(context ? { context } : {}) };
  return isSessionSources(next) ? next : taintSessionSources(next);
}

/** Validate the storage boundary, not natural-language content. */
export function isSessionSources(value: unknown): value is SessionSources {
  if (!value || typeof value !== "object") return false;
  if (new TextEncoder().encode(JSON.stringify(value)).byteLength > SOURCE_METADATA_MAX_BYTES) return false;
  const s = value as SessionSources;
  if (s.context !== undefined && !isContextDependencies(s.context)) return false;
  if (s.version !== 1) return false;
  if (s.status === "unknown" || s.status === "revoked") return true;
  if (s.status !== "known" || !Array.isArray(s.receipts) || s.receipts.length > SOURCE_RECEIPT_MAX) return false;
  const address = (a: SourceAddress) =>
    a &&
    typeof a.channelId === "string" &&
    a.channelId.length <= 256 &&
    typeof a.threadKey === "string" &&
    a.threadKey.length <= 256;
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
  return s.receipts.every((r) => isSlackSourceReceipt(r) && sameSourceBinding(r, s.binding));
}

/** A later writer cannot remove dependencies, restore a revoked session, or relabel its audience. */
export function mergeSessionSources(
  previous: SessionSources | undefined,
  next: SessionSources,
  fresh: boolean,
): SessionSources {
  let merged: SessionSources;
  if (!previous) merged = fresh ? next : UNKNOWN_SOURCES;
  else if (previous.status !== "known")
    merged = previous.status === "revoked" || next.status !== "revoked" ? previous : next;
  else if (next.status !== "known") merged = next;
  else if (!sameSourceBinding(previous.binding, next.binding)) merged = UNKNOWN_SOURCES;
  else {
    const { context: _context, ...base } = previous;
    merged = next.receipts.reduce(addSourceReceipt, base as SessionSources);
  }
  if (previous?.context === undefined && next.context === undefined) return merged;
  let context =
    previous === undefined && fresh
      ? contextDependenciesOf(next)
      : mergeContextDependencies(contextDependenciesOf(previous), contextDependenciesOf(next));
  if (merged.status === "revoked") context = mergeContextDependencies(context, { ...context, status: "revoked" });
  const result = { ...merged, context };
  return isSessionSources(result)
    ? result
    : {
        ...UNKNOWN_SOURCES,
        context: { ...context, status: context.status === "revoked" ? "revoked" : "unknown", reason: "overflow" },
      };
}

/** Association read from the durable owner row, never supplied by model content. */
export interface SessionSourceOwner {
  key: string;
  threadKey: string;
  channelId: string;
  requester: string;
}

/** `null` means an owner check failed; only an absent legacy association may
 * use the old thread-key spelling. A canonical unit lane proves its origin
 * through the claimed run rather than through its session key's syntax. */
export function sourcesBelongToSession(
  key: string,
  sources: SessionSources,
  owner?: SessionSourceOwner | null,
): boolean {
  if (owner === null || (owner !== undefined && owner.key !== key)) return false;
  if (sources.status !== "known") return true;
  if (owner === undefined) return key.startsWith(`${sources.binding.origin.threadKey}:`);
  return sameSourceBinding(sources.binding, {
    requester: owner.requester,
    origin: { threadKey: owner.threadKey, channelId: owner.channelId },
    destination: { threadKey: owner.threadKey, channelId: owner.channelId },
  });
}

/** Preserve retained leaves when a storage fence discovers a provenance gap. */
export function taintSessionSources(
  previous: SessionSources | undefined,
  status: "unknown" | "revoked" = "unknown",
): SessionSources {
  const taint = { ...UNKNOWN_SOURCES, status };
  return previous?.context === undefined
    ? taint
    : {
        ...taint,
        context: mergeContextDependencies(previous.context, {
          ...previous.context,
          status: previous.context.status === "revoked" ? "revoked" : status,
        }),
      };
}

/** Thread appends have many actors. Their whole-context envelope preserves
 * original audiences independently of the single-owner Slack tracker. */
export function appendSessionContext(
  previous: SessionSources | undefined,
  context: ContextDependencies | undefined,
  fresh: boolean,
): SessionSources {
  const merged =
    fresh && previous === undefined
      ? mergeContextDependencies(context)
      : mergeContextDependencies(contextDependenciesOf(previous), context);
  return { version: 1, status: "unknown", context: merged };
}
