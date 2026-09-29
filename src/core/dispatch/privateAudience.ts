import type { ChannelIO, HistoryItem, IncomingMessage } from "../types.js";
import { directAudienceStampOf } from "../runLedger/inboxMessage.js";
import type { FollowUpInput } from "../threadAdmission.js";
import type { SessionSeed } from "./seed.js";
import type { SlackContextCapability, SlackContextRequest } from "../../tools/slackContext.js";
import { UNTRUSTED_CLOSE, UNTRUSTED_OPEN, UNTRUSTED_PREAMBLE, unwrapUntrusted } from "../untrusted.js";

/** A live run's private-source revocation follows it through answer delivery. */
export interface PrivateAudienceLatch {
  revoked: boolean;
  /** Recovery cannot reconstruct every consumed follow-up's source. */
  reason?: "recovered" | "source-unavailable";
  /** A saved Slack read must still match a fresh authorized source at publication. */
  revalidateSources?: () => Promise<boolean>;
}

/** A private capability may expose model data only in the verified requester's DM. */
export function privateAudienceRequired(msg: IncomingMessage): boolean {
  return msg.directAudience?.kind === "slack-unshared-im";
}

/** A recovered row cannot prove no indirect source was consumed before the crash. */
export function recoveredPrivateAudienceLatch(msg: IncomingMessage, recovered: boolean): PrivateAudienceLatch {
  return recovered && privateAudienceRequired(msg) ? { revoked: true, reason: "recovered" } : { revoked: false };
}

/** A recovered source failure should not claim Slack's current DM proof failed. */
export function privateAudienceRefusal(latch: PrivateAudienceLatch | undefined): string {
  if (latch?.reason === "recovered") return "This run restarted, so please ask again in a private DM.";
  if (latch?.reason === "source-unavailable")
    return "I need to check the Slack source again before using earlier details. Please start a new DM message with the source.";
  return "I can no longer verify this private conversation, so I can't share that answer here.";
}

/** Saved Slack reads have no durable source-membership proof for a later turn. */
export function savedSlackContextNeedsRecheck(
  seed: SessionSeed | undefined,
  history: readonly HistoryItem[] = [],
): boolean {
  // A failed log read leaves only channel history, whose bot answers have no
  // durable labels for the Slack sources they quoted.
  if (!seed) return history.some((item) => item.role === "assistant");
  // A cut or compaction can hide a former Slack read in its omitted rows.
  if (seed.log.from !== 0 || seed.summary !== undefined) return true;
  if (
    seed.messages
      .slice(0, seed.log.turns)
      .some((message) =>
        message.content.some((part) => part.type === "text" && part.text.includes(SAVED_REFERENCE_HEADER)),
      )
  )
    return true;
  const calls = new Set<string>();
  for (const message of seed.messages) {
    for (const part of message.content) {
      if (part.type === "tool_use") {
        if (part.name === "slack_context") return true;
        calls.add(part.id);
      }
      if (part.type === "tool_result" && !calls.has(part.toolUseId)) return true;
    }
  }
  return false;
}

const SAVED_SLACK_RECHECK_MAX = 4;
const SAVED_REFERENCE_HEADER = "Referenced thread · #";

/** A persisted prompt may have joined the request and quoted blocks into one text part. */
function savedReferences(seed: SessionSeed): Array<{ url: string; block: string }> | undefined {
  const references: Array<{ url: string; block: string }> = [];
  for (const message of seed.messages.slice(0, seed.log.turns)) {
    for (const part of message.content) {
      if (part.type !== "text") continue;
      let offset = 0;
      while (true) {
        const start = part.text.indexOf(SAVED_REFERENCE_HEADER, offset);
        if (start < 0) break;
        if (start > 0 && part.text[start - 1] !== "\n") return undefined;
        const lineEnd = part.text.indexOf("\n", start);
        if (lineEnd < 0) return undefined;
        const match = /^Referenced thread · #[^\n]+ · \d+ messages? · (https:\/\/\S+)$/.exec(
          part.text.slice(start, lineEnd),
        );
        const bodyStart = `${UNTRUSTED_PREAMBLE}\n${UNTRUSTED_OPEN}\n`;
        if (!match || !part.text.startsWith(bodyStart, lineEnd + 1)) return undefined;
        const close = part.text.indexOf(`\n${UNTRUSTED_CLOSE}`, lineEnd + 1 + bodyStart.length);
        if (close < 0) return undefined;
        const end = close + 1 + UNTRUSTED_CLOSE.length;
        references.push({ url: match[1], block: part.text.slice(start, end) });
        offset = end;
      }
    }
  }
  return references;
}

function savedRequest(input: unknown): SlackContextRequest | undefined {
  if (!input || typeof input !== "object") return undefined;
  const value = input as Record<string, unknown>;
  if (value.kind === "thread" || value.kind === "nearby") return { kind: value.kind };
  if (value.kind === "link" && typeof value.url === "string" && value.url.startsWith("https://"))
    return { kind: "link", url: value.url };
  if (value.kind !== "file" || typeof value.fileId !== "string" || !/^F[A-Z0-9]+$/.test(value.fileId)) return undefined;
  if (typeof value.url === "string" && value.url.startsWith("https://"))
    return { kind: "file", fileId: value.fileId, url: value.url };
  if (typeof value.messageTs === "string" && /^\d+\.\d+$/.test(value.messageTs))
    return { kind: "file", fileId: value.fileId, messageTs: value.messageTs };
  return undefined;
}

/** An origin read may gain later messages; every earlier byte must remain. */
function sameOrAppendedOriginRead(saved: unknown, fresh: unknown): boolean {
  if (typeof saved !== "string" || typeof fresh !== "string") return false;
  const parse = (text: string): { source: string; body: string } | undefined => {
    const split = text.indexOf("\n");
    if (split < 0) return undefined;
    const header = text.slice(0, split);
    const match = /^(Current Slack thread|Nearby Slack channel) · (.+) · \d+ messages?$/.exec(header);
    const fenced = text.slice(split + 1);
    if (
      !match ||
      !fenced.startsWith(`${UNTRUSTED_PREAMBLE}\n${UNTRUSTED_OPEN}\n`) ||
      !fenced.endsWith(`\n${UNTRUSTED_CLOSE}`)
    )
      return undefined;
    return { source: `${match[1]} · ${match[2]}`, body: unwrapUntrusted(fenced) };
  };
  const before = parse(saved);
  const after = parse(fresh);
  return (
    before !== undefined &&
    after !== undefined &&
    before.source === after.source &&
    (after.body === before.body || after.body.startsWith(`${before.body}\n`))
  );
}

/** Re-read a bounded saved source set; unchanged text alone is not authority. */
export async function revalidateSavedSlackContext(
  seed: SessionSeed | undefined,
  capability: SlackContextCapability,
  revalidateReference?: (url: string) => Promise<string | undefined>,
): Promise<boolean> {
  if (!seed || seed.log.from !== 0 || seed.summary !== undefined) return false;
  const references = savedReferences(seed);
  if (!references || references.length > SAVED_SLACK_RECHECK_MAX) return false;
  const calls = new Map<string, { name: string; input: unknown }>();
  const results: Array<{ input: unknown; content: unknown; isError?: boolean }> = [];
  const pendingSlackCalls = new Set<string>();
  for (const message of seed.messages) {
    for (const part of message.content) {
      if (part.type === "tool_use") {
        calls.set(part.id, { name: part.name, input: part.input });
        if (part.name === "slack_context") pendingSlackCalls.add(part.id);
      }
      if (part.type === "tool_result") {
        const call = calls.get(part.toolUseId);
        if (!call) return false;
        if (call.name === "slack_context") {
          pendingSlackCalls.delete(part.toolUseId);
          results.push({ input: call.input, content: part.content, isError: part.isError });
        }
      }
    }
  }
  if (
    pendingSlackCalls.size > 0 ||
    results.length + references.length === 0 ||
    results.length + references.length > SAVED_SLACK_RECHECK_MAX
  )
    return false;
  for (const result of results) {
    const request = savedRequest(result.input);
    if (!request || result.isError) return false;
    try {
      const fresh = await capability.read(request, "revalidate");
      if (typeof fresh === "string" && fresh.startsWith("slack_context:")) return false;
      if (request.kind === "thread" || request.kind === "nearby") {
        if (!sameOrAppendedOriginRead(result.content, fresh)) return false;
      } else if (JSON.stringify(fresh) !== JSON.stringify(result.content)) return false;
    } catch {
      return false;
    }
  }
  for (const reference of references) {
    if (!revalidateReference) return false;
    try {
      if ((await revalidateReference(reference.url)) !== reference.block) return false;
    } catch {
      return false;
    }
  }
  return true;
}

/** A later source change seals both the event and the channel reply. */
export async function savedSlackSourcesStillValid(latch: PrivateAudienceLatch): Promise<boolean> {
  if (latch.revoked) return false;
  if (!latch.revalidateSources) return true;
  try {
    if ((await latch.revalidateSources()) && !latch.revoked) return true;
  } catch {
    // Failed source checks never restore an earlier result's authority.
  }
  latch.revoked = true;
  latch.reason = "source-unavailable";
  return false;
}

/** A source change permanently ends this run's right to private Slack reads. */
export function samePrivateRequesterFollowUp(
  origin: IncomingMessage,
  input: Pick<FollowUpInput, "userId" | "directAudience" | "from"> & { msg: IncomingMessage },
): boolean {
  const expected = directAudienceStampOf(origin);
  const received = directAudienceStampOf(input.msg);
  const admitted = input.directAudience;
  return (
    input.from === undefined &&
    expected !== undefined &&
    received !== undefined &&
    admitted?.kind === "slack-unshared-im" &&
    input.userId === expected.userId &&
    admitted.channelId === expected.channelId &&
    admitted.userId === expected.userId &&
    admitted.threadKey === expected.threadKey &&
    received.channelId === expected.channelId &&
    received.userId === expected.userId &&
    received.threadKey === expected.threadKey
  );
}

/** Recheck the adapter's current address and Slack's current DM membership. */
export async function privateAudienceStillValid(msg: IncomingMessage, io: ChannelIO): Promise<boolean> {
  const audience = msg.directAudience;
  if (!audience || !io.verifyDirectAudience) return false;
  try {
    const address = io.directAudience?.();
    if (
      audience.kind !== "slack-unshared-im" ||
      audience.channelId !== msg.channelId ||
      audience.userId !== msg.userId ||
      audience.threadKey !== msg.threadKey ||
      address?.channelId !== audience.channelId ||
      address.userId !== audience.userId ||
      address.threadKey !== audience.threadKey
    )
      return false;
    return (await io.verifyDirectAudience(audience)) === true;
  } catch {
    return false;
  }
}
