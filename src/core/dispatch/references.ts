import { SOURCE_READ_MESSAGE_MAX } from "../references/receipts.js";
import type { RefusalCode } from "../refusal.js";
import { authorize } from "../authz/authorize.js";
import type { Actor, ChannelDirectory } from "../authz/types.js";
import { wrapUntrusted } from "../commandRegistry.js";
import type {
  ConversationClassification,
  ConversationReader,
  ConversationRef,
  ReferencedConversation,
} from "../references/types.js";
import type { IncomingMessage } from "../types.js";

// The references step (record 0037): a URL in the request that a channel
// adapter recognises as one of its conversations becomes ONE quoted block on
// the request turn — after both fast paths, so a request they answer costs no
// call here; before the model, so nothing the model does can widen what was
// read. The step owns the decision and the caps; the adapter owns the URL
// grammar, the closed classifier and the fetch (ConversationReader). What
// comes back is never a HistoryItem: the parsers that read `history` and
// `msg.text` never see a block, and the test beside this file pins it.

/** Bounds, sized to keep a worst-case request under 96 KB and one requester under a fifth of Slack's tier-3 bucket. */
export const REFERENCE_MAX_PER_REQUEST = 3;
export const REFERENCE_MAX_MESSAGES = SOURCE_READ_MESSAGE_MAX;
export const REFERENCE_MAX_BYTES = 32 * 1024;
export const REFERENCE_PER_USER_PER_MINUTE = 10;
/** The longest one adapter call may take; the directory's own bound (record.ts). Past it the answer is a refusal, never a guess. */
export const REFERENCE_TIMEOUT_MS = 1500;
/** The one refusal line. Byte-identical for every refused case so the reply reveals nothing about the channel. */
export const REFERENCE_REFUSAL = "I can't read that thread.";

/** What the dispatcher's dependencies carry for this step; `CoreDeps` extends it. */
export interface ReferenceDeps {
  /** The conversation readers the adapters registered; whichever recognises a URL owns it. Absent → the step is inert. */
  conversationReaders?: readonly ConversationReader[];
  /** Bound on one adapter call (default `REFERENCE_TIMEOUT_MS`). Tests set it low. */
  referenceTimeoutMs?: number;
}

/** Why a reference was refused — the log line's token, never the reply's. */
export type ReferenceRefusal =
  "over-cap" | "rate-limited" | "guest" | "timed-out" | "never" | "not-a-member" | "denied" | "fetch-failed";

/** The token's refusal code (record 0054): the one sentence stays one line
 *  (record 0037 — it reveals nothing about the channel); only the code splits,
 *  so the span carries the cause while the reply does not. */
export function referenceRefusalCode(token: ReferenceRefusal): RefusalCode {
  const codes = {
    "over-cap": "reference_over_cap",
    "rate-limited": "reference_rate_limited",
    guest: "reference_guest",
    "timed-out": "reference_timed_out",
    never: "reference_never",
    "not-a-member": "reference_not_a_member",
    denied: "reference_denied",
    "fetch-failed": "reference_fetch_failed",
  } as const satisfies Record<ReferenceRefusal, RefusalCode>;
  return codes[token];
}

export interface ReferencesResult {
  /** The conversations read, in request order, capped. */
  readonly conversations: readonly ReferencedConversation[];
  /** One rendered block per conversation, the same order. */
  readonly blocks: readonly string[];
  /** Each quoted conversation's channel visibility, the same order as `conversations`
   *  — the memory gate narrows the run's origin to the narrowest of these. */
  readonly visibilities: readonly ("public" | "private")[];
  /** One token per refused reference, in request order. */
  readonly refused: readonly ReferenceRefusal[];
}

export const NO_REFERENCES: ReferencesResult = Object.freeze({
  conversations: [],
  blocks: [],
  visibilities: [],
  refused: [],
});

// ---- URL extraction ---------------------------------------------------------

/** Every http(s) URL in a channel-authored text, in order, deduplicated: Slack's
 *  `<url|label>` and `<url>` forms unwrapped, a bare URL's trailing punctuation
 *  dropped. A label is never a URL — a label can say one channel while the URL
 *  says another, which is why the block's header comes from the classifier. */
export function extractUrls(text: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const push = (raw: string) => {
    const url = raw.replace(/[>),.;:!?'"]+$/, "");
    if (url && !seen.has(url)) {
      seen.add(url);
      out.push(url);
    }
  };
  const re = /<(https?:\/\/[^|>\s]+)(?:\|[^>]*)?>|(https?:\/\/[^\s<>]+)/g;
  for (const m of text.matchAll(re)) push(m[1] ?? m[2] ?? "");
  return out;
}

/** One reference as parsed: the reader whose grammar owns the URL and the
 *  conversation it names. */
export interface ParsedReference {
  reader: ConversationReader;
  ref: ConversationRef;
}

/** Every reference in `text`, in order, the same conversation once: each URL
 *  offered to the readers, the first whose `parseConversationUrl` answers owns
 *  it, and a URL no reader parses is plain text. The URL grammar alone — no
 *  reader is asked anything else, so this is what the request's own text
 *  settles before any adapter call, the half of the step deterministic code may
 *  read (record 0037 keeps the quote itself after admission). */
export function parseReferences(text: string, readers: readonly ConversationReader[]): ParsedReference[] {
  const refs: ParsedReference[] = [];
  const seen = new Set<string>();
  if (readers.length === 0) return refs;
  for (const url of extractUrls(text)) {
    for (const reader of readers) {
      const ref = reader.parseConversationUrl(url);
      if (!ref) continue;
      const key = `${ref.threadKey}#${ref.messageId ?? ""}`;
      if (!seen.has(key)) {
        seen.add(key);
        refs.push({ reader, ref });
      }
      break;
    }
  }
  return refs;
}

/** How many conversations the step would quote for `text`: the parsed
 *  references under the per-request cap (a fourth is refused, never quoted).
 *  A fact callers may include in their own grounded input. */
export function quotableReferences(text: string, readers: readonly ConversationReader[]): number {
  return Math.min(parseReferences(text, readers).length, REFERENCE_MAX_PER_REQUEST);
}

// ---- the per-user window ----------------------------------------------------

const perUser = new Map<string, number[]>();

/** Tests only: forget every requester's window. */
export function resetReferenceRate(): void {
  perUser.clear();
}

/** Admit one more reference for `userId` at `now`, or refuse: at most
 *  `REFERENCE_PER_USER_PER_MINUTE` in any rolling minute. */
function admitOne(userId: string, now: number): boolean {
  const cutoff = now - 60_000;
  const recent = (perUser.get(userId) ?? []).filter((t) => t > cutoff);
  if (recent.length >= REFERENCE_PER_USER_PER_MINUTE) {
    perUser.set(userId, recent);
    return false;
  }
  recent.push(now);
  perUser.set(userId, recent);
  return true;
}

// ---- bounded adapter calls --------------------------------------------------

const TIMED_OUT = Symbol("reference call timed out");

/** `fn()` raced against the bound; a rejection is `undefined`, a late answer is
 *  dropped. The same shape as `channelVisibilityOf` (record.ts): the timer is
 *  always cleared, and a rejection after the deadline is never left unhandled. */
async function bounded<T>(fn: () => Promise<T>, timeoutMs: number): Promise<T | undefined | typeof TIMED_OUT> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const call = Promise.resolve()
      .then(fn)
      .then(
        (v) => v,
        () => undefined,
      );
    return await Promise.race([
      call,
      new Promise<typeof TIMED_OUT>((resolve) => {
        timer = setTimeout(() => resolve(TIMED_OUT), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

// ---- the step ---------------------------------------------------------------

export interface ReadReferencesInput {
  msg: IncomingMessage;
  /** The request's principal (the chat actor); the step builds the pointing actor from it. */
  actor: Actor;
  /** A saved-source recheck repeats the full authority and fetch path without charging a new user read. */
  purpose?: "revalidate";
  /** Clock, for the per-user window; tests set it. Default `Date.now`. */
  now?: () => number;
}

type ReferenceAccessDeps = ReferenceDeps & { channelDirectory?: Pick<ChannelDirectory, "isMember"> };

export type ReferenceAccess =
  | { classification: ConversationClassification & { visibility: "public" | "private" }; reader: ConversationReader }
  | { refused: ReferenceRefusal };

/** One source policy for automatic references, explicit reads and saved-source checks.
 * The platform reports facts; the policy table decides for the resolved requester. */
export async function referenceAccess(
  deps: ReferenceAccessDeps,
  input: ReadReferencesInput,
  { reader, ref }: ParsedReference,
  fresh = false,
): Promise<ReferenceAccess> {
  const { msg, actor } = input;
  const sourceReader = reader.forReference?.(msg.channelId, ref) ?? reader;
  const timeoutMs = deps.referenceTimeoutMs ?? REFERENCE_TIMEOUT_MS;
  const membership = (channelId: string, directory = sourceReader.directory ?? deps.channelDirectory) =>
    actor.kind !== "user" || actor.id !== msg.userId || actor.onBehalfOf
      ? Promise.resolve(false)
      : bounded(
          async () => (await directory?.isMember(msg.userId, channelId, { fresh: true })) ?? "unknown",
          timeoutMs,
        );
  if (input.purpose !== "revalidate" && !admitOne(msg.userId, (input.now ?? Date.now)()))
    return { refused: "rate-limited" };
  const lookup = (target: ConversationRef) =>
    bounded(
      () =>
        fresh && sourceReader.classifyConversationFresh
          ? sourceReader.classifyConversationFresh(target)
          : sourceReader.classifyConversation(target),
      timeoutMs,
    );
  const platform = msg.channelId.slice(0, msg.channelId.indexOf(":"));
  const originReader = deps.conversationReaders?.find((r) => r.platform === platform) ?? reader;
  if (ref.channelId !== msg.channelId) {
    const full = await bounded(
      () => (sourceReader.platform === platform ? sourceReader : originReader).requesterIsFullMember(msg.userId),
      timeoutMs,
    );
    if (full !== true) return { refused: full === TIMED_OUT ? "timed-out" : "guest" };
  }
  const classification = await lookup(ref);
  if (classification === TIMED_OUT) return { refused: "timed-out" };
  if (!classification || classification.visibility === "never") return { refused: "never" };
  if (!classification.readerHasAccess) return { refused: "not-a-member" };
  if (ref.channelId !== msg.channelId) {
    const originRef = { channelId: msg.channelId, threadKey: msg.threadKey, url: msg.sourceUrl ?? "" };
    const origin = await bounded(
      () =>
        originReader.classifyConversationFresh
          ? originReader.classifyConversationFresh(originRef)
          : originReader.classifyConversation(originRef),
      timeoutMs,
    );
    if (origin === TIMED_OUT) return { refused: "timed-out" };
    const direct = msg.directAudience;
    const verifiedDirect =
      origin?.direct &&
      direct?.channelId === msg.channelId &&
      direct.userId === msg.userId &&
      direct.threadKey === msg.threadKey;
    if (
      !origin ||
      origin.shared ||
      (!origin.readerHasAccess && !verifiedDirect) ||
      (origin.visibility === "never" && !verifiedDirect)
    )
      return { refused: "denied" };
    if (classification.visibility === "private" && !verifiedDirect) return { refused: "denied" };
    if (origin.visibility === "private") {
      const member = await membership(msg.channelId, originReader.directory ?? deps.channelDirectory);
      if (member !== true) return { refused: member === TIMED_OUT ? "timed-out" : "denied" };
    }
  }
  let principal = actor;
  if ((classification.shared && !sourceReader.workspacePublicRead) || classification.visibility === "private") {
    const member = await membership(ref.channelId);
    if (member !== true) return { refused: member === TIMED_OUT ? "timed-out" : "denied" };
    principal = { ...principal, memberOf: new Set([ref.channelId]) };
  }
  const decision = authorize(principal, "conversation:read", {
    type: "channel",
    id: ref.channelId,
    visibility: classification.shared && !sourceReader.workspacePublicRead ? "private" : classification.visibility,
  });
  return decision.allow
    ? { classification: { ...classification, visibility: classification.visibility }, reader: sourceReader }
    : { refused: "denied" };
}

export function sameReferenceAudience(
  a: { visibility: string; shared?: boolean },
  b: { visibility: string; shared?: boolean },
): boolean {
  return a.visibility === b.visibility && !!a.shared === !!b.shared;
}

/**
 * Resolve every reference in `msg.text`. Per reference, in order: the
 * per-request cap and the per-user window (no adapter call), the requester's
 * standing on their own platform when the channel is not the origin, the
 * closed classifier and destination checks (bounded), the `conversation:read` row for the resolved
 * requester, the bounded fetch, the caps. A URL no reader parses is plain text.
 * Every decision is one `[references]` log line with its reason; the reply
 * carries only `REFERENCE_REFUSAL`, once, when anything was refused.
 */
export async function readReferences(deps: ReferenceAccessDeps, input: ReadReferencesInput): Promise<ReferencesResult> {
  const readers = deps.conversationReaders ?? [];
  if (readers.length === 0) return NO_REFERENCES;
  const { msg } = input;
  const timeoutMs = deps.referenceTimeoutMs ?? REFERENCE_TIMEOUT_MS;

  // Parse first: a URL no reader owns is not a reference and costs nothing.
  const refs = parseReferences(msg.text, readers);
  if (refs.length === 0) return NO_REFERENCES;

  const conversations: ReferencedConversation[] = [];
  const blocks: string[] = [];
  const visibilities: ("public" | "private")[] = [];
  const refused: ReferenceRefusal[] = [];
  const log = (ref: ConversationRef, outcome: string) =>
    console.log(`[references] ${msg.threadKey} ${ref.channelId} ${outcome}`);
  const refuse = (ref: ConversationRef, why: ReferenceRefusal) => {
    refused.push(why);
    log(ref, `refused reason=${why}`);
  };
  for (const [i, { reader, ref }] of refs.entries()) {
    if (i >= REFERENCE_MAX_PER_REQUEST) {
      refuse(ref, "over-cap");
      continue;
    }
    const access = await referenceAccess(deps, input, { reader, ref });
    if ("refused" in access) {
      refuse(ref, access.refused);
      continue;
    }
    const { classification } = access;
    const read = await bounded(
      () => access.reader.readConversation(ref, { maxMessages: REFERENCE_MAX_MESSAGES, maxBytes: REFERENCE_MAX_BYTES }),
      timeoutMs,
    );
    if (read === TIMED_OUT || read === undefined || read.messages.length === 0) {
      // Nothing to quote — a fetch that failed, or a permalink to a message the
      // reader dropped (a status card) — is a refusal, never an empty block.
      refuse(ref, read === TIMED_OUT ? "timed-out" : "fetch-failed");
      continue;
    }
    const fresh = await referenceAccess(deps, { ...input, purpose: "revalidate" }, { reader, ref }, true);
    if ("refused" in fresh || !sameReferenceAudience(classification, fresh.classification)) {
      refuse(ref, "denied");
      continue;
    }
    const conversation = capped({
      ...read,
      channelName: classification.channelName ?? read.channelName,
      ...(classification.shared ? { shared: true } : {}),
    });
    conversations.push(conversation);
    blocks.push(quotedBlock(conversation));
    visibilities.push(classification.visibility);
    log(ref, `allowed visibility=${classification.visibility} messages=${conversation.messages.length}`);
  }
  return { conversations, blocks, visibilities, refused };
}

// ---- caps and rendering -----------------------------------------------------

/** The newest `REFERENCE_MAX_MESSAGES` messages, then the newest that fit `REFERENCE_MAX_BYTES` once rendered. */
function capped(rc: ReferencedConversation): ReferencedConversation {
  let messages = rc.messages.slice(-REFERENCE_MAX_MESSAGES);
  while (messages.length > 1 && utf8Bytes(renderBody(messages)) > REFERENCE_MAX_BYTES) messages = messages.slice(1);
  return {
    ...rc,
    messages,
    ...(rc.coverage
      ? {
          coverage: {
            kind: messages.length < rc.messages.length ? ("bounded" as const) : rc.coverage.kind,
            truncated:
              rc.coverage.truncated ||
              messages.length < rc.messages.length ||
              utf8Bytes(renderBody(messages)) > REFERENCE_MAX_BYTES,
          },
        }
      : {}),
  };
}

function utf8Bytes(s: string): number {
  return new TextEncoder().encode(s).length;
}

function clock(at: number | undefined): string {
  if (at === undefined) return "";
  const d = new Date(at);
  const hh = String(d.getUTCHours()).padStart(2, "0");
  const mm = String(d.getUTCMinutes()).padStart(2, "0");
  return `${hh}:${mm} · `;
}

function renderBody(messages: ReferencedConversation["messages"]): string {
  return messages.map((m) => `${clock(m.at)}${m.author}: ${m.text}`).join("\n");
}

/**
 * One quoted block: a header naming the resolved channel, the count and the
 * permalink, then the untrusted fence around one `HH:MM · author: text` line
 * per message, roles flattened. `wrapUntrusted` breaks any fence marker a
 * message carries, so the body cannot close the fence.
 */
export function quotedBlock(rc: ReferencedConversation): string {
  const n = rc.messages.length;
  const header = `Referenced thread · #${rc.channelName} · ${n} message${n === 1 ? "" : "s"} · ${rc.permalink}`;
  return `${header}\n${wrapUntrusted(renderBody(rc.messages))}`;
}
