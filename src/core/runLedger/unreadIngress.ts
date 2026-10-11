import {
  ingressRecordSchema,
  retainedIngress,
  unreadIngressProofSchema,
  type IngressRecord,
  type IngressResult,
  type UnreadIngressProof,
} from "./ingress.js";
import { messageFromInbox } from "./inboxMessage.js";
import { originalOrganizationDispatchOf } from "../dispatch/originalOrganizationInput.js";
import { unreadInbox } from "./decisions.js";
import type { InboxItem, StepRecord } from "./types.js";

/** The original receiver returns its exact unread item. Store implementations
 * also fence the receiver generation and reject any physical original run. */
export function holdUnreadIngress(
  prior: IngressRecord | null,
  proof: UnreadIngressProof,
  item: InboxItem | undefined,
  lastStep: StepRecord | null,
  now: number,
): IngressResult {
  if (!unreadIngressProofSchema.safeParse(proof).success) return { status: "invalid" };
  if (!prior) return { status: "not_found" };
  const record = retainedIngress(prior, now);
  if (record.status === "completed" || record.runId !== proof.ingressRunId || !record.request || record.refusalPending)
    return { status: "fenced" };
  if (record.unread)
    return proof.receiverRunId === record.unread.receiverRunId &&
      proof.receiverGen === record.unread.receiverGen &&
      proof.inboxSeq === record.unread.inboxSeq
      ? { status: "record", record }
      : { status: "fenced" };
  if (!item || item.seq !== proof.inboxSeq || !unreadInbox(lastStep)(item)) return { status: "fenced" };
  const restored = messageFromInbox(item.message, now, {
    runId: proof.receiverRunId,
    threadKey: record.threadKey,
    channelId: String(item.message.channelId),
    requester: record.requester,
  });
  const original = restored && originalOrganizationDispatchOf(restored.msg);
  if (
    !restored ||
    restored.from ||
    restored.control ||
    restored.custody?.producerGen !== proof.receiverGen ||
    restored.msg.userId !== record.requester ||
    restored.msg.threadKey !== record.threadKey ||
    original?.ingressRunId !== record.runId
  )
    return { status: "fenced" };
  const ref = record.origin?.sourceReference;
  if (
    ref &&
    (ref.messageId !== restored.msg.messageId ||
      ref.channelId !== restored.msg.channelId ||
      ref.userId !== restored.msg.userId ||
      ref.authenticatedAs !== restored.msg.authenticatedAs ||
      ref.postedBy !== restored.msg.postedBy)
  )
    return { status: "fenced" };
  return {
    status: "record",
    record: ingressRecordSchema.parse({
      ...record,
      status: "uncertain",
      outcome: "The original receiver returned this input unread; current source proof is required to continue.",
      unread: {
        receiverRunId: proof.receiverRunId,
        receiverGen: proof.receiverGen,
        inboxSeq: proof.inboxSeq,
        status: "pending",
        organizationSequence: original.organizationSequence,
        ...(original.organizationRepo ? { organizationRepo: original.organizationRepo } : {}),
      },
    }),
  };
}
