import { SOURCE_REVALIDATE_MAX_MS } from "../budgets.js";
import type { ChannelIO, HistoryItem, IncomingMessage } from "../types.js";
import { directAudienceStampOf } from "../runLedger/inboxMessage.js";
import type { FollowUpInput } from "../threadAdmission.js";
import type { SessionSeed } from "./seed.js";
import type { SlackSourceReceipt } from "../references/receipts.js";

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

/** Only trusted session metadata describes prior reads; prose never grants or revokes access. */
export function savedSlackContextNeedsRecheck(
  seed: SessionSeed | undefined,
  history: readonly HistoryItem[] = [],
): boolean {
  if (!seed) return history.some((item) => item.role === "assistant");
  return !seed.sources || seed.sources.status !== "known" || seed.sources.receipts.length > 0;
}

export async function revalidateSavedSlackContext(
  seed: SessionSeed | undefined,
  revalidate: (receipt: SlackSourceReceipt) => Promise<boolean>,
): Promise<boolean> {
  if (!seed?.sources || seed.sources.status !== "known") return false;
  return revalidateSourcesWithinBudget(seed.sources.receipts, revalidate);
}

/** A stalled API check refuses publication; it cannot begin another receipt after the deadline. */
export async function revalidateSourcesWithinBudget(
  receipts: readonly SlackSourceReceipt[],
  revalidate: (receipt: SlackSourceReceipt) => Promise<boolean>,
): Promise<boolean> {
  let expired = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<boolean>((resolve) => {
    timer = setTimeout(() => {
      expired = true;
      resolve(false);
    }, SOURCE_REVALIDATE_MAX_MS);
  });
  const check = async () => {
    try {
      for (const receipt of receipts) {
        if (expired || !(await revalidate(receipt)) || expired) return false;
      }
      return !expired;
    } catch {
      return false;
    }
  };
  try {
    return await Promise.race([check(), deadline]);
  } finally {
    clearTimeout(timer);
  }
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
