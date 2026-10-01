import {
  audienceRefusalText,
  type AudienceCheck,
  type AudienceTrace,
  type AudienceRefusalCode,
} from "../audienceDecision.js";
import type { SlackContextBinding } from "./slackContextBinding.js";
import { SOURCE_REVALIDATE_MAX_MS } from "../budgets.js";
import type { ChannelIO, HistoryItem, IncomingMessage } from "../types.js";
import { directAudienceStampOf } from "../runLedger/inboxMessage.js";
import type { FollowUpInput } from "../threadAdmission.js";
import type { SessionSeed } from "./seed.js";
import type { SlackSourceReceipt } from "../references/receipts.js";

/** A live run's private-source revocation follows it through answer delivery. */
export interface PrivateAudienceLatch extends AudienceTrace {
  revoked: boolean;
  /** Recovery cannot reconstruct every consumed follow-up's source. */
  code?: AudienceRefusalCode;
  /** A saved Slack read must still match a fresh authorized source at publication. */
  revalidateSources?: () => Promise<AudienceCheck>;
}

/** A private capability may expose model data only in the verified requester's DM. */
export function privateAudienceRequired(msg: IncomingMessage): boolean {
  return msg.directAudience?.kind === "slack-unshared-im";
}

/** A recovered row cannot prove no indirect source was consumed before the crash. */
export function recoveredPrivateAudienceLatch(msg: IncomingMessage, recovered: boolean): PrivateAudienceLatch {
  return recovered && privateAudienceRequired(msg)
    ? { revoked: true, code: "recovered-provenance-unproved" }
    : { revoked: false };
}

/** A recovered source failure should not claim Slack's current DM proof failed. */
export function privateAudienceRefusal(latch: PrivateAudienceLatch | undefined): string {
  return audienceRefusalText(latch?.refusal?.code ?? latch?.code ?? "followup-unverified");
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
  return (await revalidateSavedSlackContextDecision(seed, revalidate)).ok;
}

export async function revalidateSavedSlackContextDecision(
  seed: SessionSeed | undefined,
  revalidate: (receipt: SlackSourceReceipt) => Promise<boolean>,
): Promise<AudienceCheck> {
  if (!seed?.sources || seed.sources.status !== "known") return { ok: false, code: "slack-source-unverified" };
  return revalidateSourcesDecision(seed.sources.receipts, revalidate);
}

/** A stalled API check refuses publication; it cannot begin another receipt after the deadline. */
export async function revalidateSourcesDecision(
  receipts: readonly SlackSourceReceipt[],
  revalidate: (receipt: SlackSourceReceipt) => Promise<boolean>,
): Promise<AudienceCheck> {
  let expired = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<AudienceCheck>((resolve) => {
    timer = setTimeout(() => {
      expired = true;
      resolve({ ok: false, code: "source-check-timeout" });
    }, SOURCE_REVALIDATE_MAX_MS);
  });
  const check = async () => {
    try {
      for (const receipt of receipts) {
        if (expired) return { ok: false, code: "source-check-timeout" } as const;
        const valid = await revalidate(receipt);
        if (expired) return { ok: false, code: "source-check-timeout" } as const;
        if (!valid) return { ok: false, code: "slack-source-unverified" } as const;
      }
      return { ok: true } as const;
    } catch {
      return { ok: false, code: "slack-source-unverified" } as const;
    }
  };
  try {
    return await Promise.race([check(), deadline]);
  } finally {
    clearTimeout(timer);
  }
}

export async function revalidateSourcesWithinBudget(
  receipts: readonly SlackSourceReceipt[],
  revalidate: (receipt: SlackSourceReceipt) => Promise<boolean>,
): Promise<boolean> {
  return (await revalidateSourcesDecision(receipts, revalidate)).ok;
}

/** A later source change seals both the event and the channel reply. */
export async function savedSlackSourcesStillValid(latch: PrivateAudienceLatch): Promise<boolean> {
  if (latch.revoked) return false;
  if (!latch.revalidateSources) return true;
  try {
    const checked = await latch.revalidateSources();
    if (checked.ok && !latch.revoked) return true;
    if (!checked.ok) latch.code ??= checked.code;
  } catch {
    // Failed source checks never restore an earlier result's authority.
  }
  latch.revoked = true;
  latch.code ??= "slack-source-unverified";
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
export async function privateAudienceDecision(msg: IncomingMessage, io: ChannelIO): Promise<AudienceCheck> {
  const audience = msg.directAudience;
  if (!audience || !io.verifyDirectAudience) return { ok: false, code: "direct-address-unproved" };
  try {
    const address = io.directAudience?.();
    if (!address) return { ok: false, code: "direct-address-unproved" };
    if (
      audience.kind !== "slack-unshared-im" ||
      audience.channelId !== msg.channelId ||
      audience.userId !== msg.userId ||
      audience.threadKey !== msg.threadKey ||
      address?.channelId !== audience.channelId ||
      address.userId !== audience.userId ||
      address.threadKey !== audience.threadKey
    )
      return { ok: false, code: "direct-address-mismatch" };
    return await io.verifyDirectAudience(audience);
  } catch {
    return { ok: false, code: "direct-audience-unavailable" };
  }
}

export async function privateAudienceStillValid(msg: IncomingMessage, io: ChannelIO): Promise<boolean> {
  return (await privateAudienceDecision(msg, io)).ok;
}

/** Both answer-event and channel delivery recheck through the same composition. */
export async function privateRunAudienceDecision(
  msg: IncomingMessage,
  io: ChannelIO,
  latch: PrivateAudienceLatch,
  slackContext?: SlackContextBinding,
): Promise<AudienceCheck> {
  const revoked = (): AudienceCheck => ({
    ok: false,
    code: latch.refusal?.code ?? latch.code ?? "followup-unverified",
  });
  if (latch.revoked) return revoked();
  if (privateAudienceRequired(msg)) {
    const result = await privateAudienceDecision(msg, io);
    if (latch.revoked) return revoked();
    if (!result.ok) return result;
  }
  if (slackContext && !(await slackContext.destinationStillPrivate()))
    return latch.revoked ? revoked() : { ok: false, code: "direct-audience-unavailable" };
  if (!(await savedSlackSourcesStillValid(latch))) return revoked();
  return latch.revoked ? revoked() : { ok: true };
}

export function privateFollowUpFailure(
  origin: IncomingMessage,
  input: Pick<FollowUpInput, "userId" | "directAudience" | "from"> & { msg: IncomingMessage },
): AudienceRefusalCode | undefined {
  if (samePrivateRequesterFollowUp(origin, input)) return undefined;
  if (input.from || input.msg.relayedBy || input.msg.postedBy || input.msg.authenticatedAs) return "followup-indirect";
  if (input.userId !== origin.userId) return "followup-requester-mismatch";
  if (!directAudienceStampOf(origin) || !directAudienceStampOf(input.msg) || !input.directAudience)
    return "followup-address-unproved";
  return "followup-address-mismatch";
}
