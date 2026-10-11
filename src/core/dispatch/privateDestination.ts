import type { AudienceCheck } from "../audienceDecision.js";
import type { ChannelIO, IncomingMessage, SlackDirectAudience } from "../types.js";
import { directAudienceStampOf } from "../runLedger/inboxMessage.js";
import { isOrganizationId } from "../authz/resource.js";

/** A channel-owned address. Current proof is required at every private use. */
export interface OrganizationPrivateAudience {
  kind: "organization-private";
  organization: string;
  stream: string;
  actorId: string;
  userId: string;
  channelId: string;
  threadKey: string;
}
export type PrivateDestination = SlackDirectAudience | OrganizationPrivateAudience;
const organizationAudience = Symbol("organization-private-audience");
const sourceSequence = Symbol("organization-source-sequence");
export {
  withOriginalOrganizationDispatch,
  originalOrganizationDispatchOf,
  type OriginalOrganizationDispatch,
} from "./originalOrganizationInput.js";
import { withoutOriginalOrganizationDispatch } from "./originalOrganizationInput.js";
export function withoutOrganizationPrivateAudience<T extends object>(message: T): T {
  const copy = withoutOriginalOrganizationDispatch(message) as T & {
    [organizationAudience]?: OrganizationPrivateAudience;
    [sourceSequence]?: number;
  };
  delete copy[organizationAudience];
  delete copy[sourceSequence];
  return copy;
}

export function isOrganizationPrivateAudience(value: unknown): value is OrganizationPrivateAudience {
  if (!value || typeof value !== "object") return false;
  const row = value as Record<string, unknown>;
  return (
    row.kind === "organization-private" &&
    typeof row.organization === "string" &&
    isOrganizationId(row.organization) &&
    typeof row.stream === "string" &&
    row.stream.length > 0 &&
    row.stream.length <= 2048 &&
    [row.actorId, row.userId, row.channelId, row.threadKey].every(
      (field) => typeof field === "string" && field.length > 0 && field.length <= 2048 && field.includes(":"),
    )
  );
}
/** Only the host can supply this symbol. JSON bodies and durable actor snapshots cannot. */
export function withOrganizationPrivateAudience<T extends object>(
  message: T,
  audience: OrganizationPrivateAudience,
  sequence?: number,
): T {
  if (!isOrganizationPrivateAudience(audience)) throw new Error("Invalid private destination");
  if (sequence !== undefined && (!Number.isSafeInteger(sequence) || sequence < 1))
    throw new Error("Invalid source order");
  return {
    ...message,
    [organizationAudience]: { ...audience },
    ...(sequence !== undefined ? { [sourceSequence]: sequence } : {}),
  };
}
/** Ordered durable requester token; the original platform message id is never rewritten. */
export function requesterMessageId(message: Pick<IncomingMessage, "messageId">): string | undefined {
  if (!organizationPrivateAudienceOf(message)) return message.messageId;
  const sequence = organizationSourceSequenceOf(message);
  return sequence !== undefined && message.messageId
    ? `browser:${sequence}:${encodeURIComponent(message.messageId)}`
    : undefined;
}
export function organizationSourceSequenceOf(message: object): number | undefined {
  const sequence = (message as { [sourceSequence]?: number })[sourceSequence];
  return typeof sequence === "number" && Number.isSafeInteger(sequence) && sequence > 0 ? sequence : undefined;
}
export function organizationPrivateAudienceOf(message: object): OrganizationPrivateAudience | undefined {
  const value = (message as { [organizationAudience]?: OrganizationPrivateAudience })[organizationAudience];
  return isOrganizationPrivateAudience(value) ? value : undefined;
}
export function privateDestinationOf(message: IncomingMessage): PrivateDestination | undefined {
  return organizationPrivateAudienceOf(message) ?? directAudienceStampOf(message);
}
export function samePrivateDestination(a: PrivateDestination, b: PrivateDestination): boolean {
  if (a.kind !== b.kind || a.channelId !== b.channelId || a.userId !== b.userId || a.threadKey !== b.threadKey)
    return false;
  return (
    a.kind === "slack-unshared-im" ||
    (b.kind === "organization-private" &&
      a.organization === b.organization &&
      a.stream === b.stream &&
      a.actorId === b.actorId)
  );
}
export async function verifyPrivateDestination(
  io:
    | Pick<
        ChannelIO,
        "directAudience" | "verifyDirectAudience" | "organizationPrivateAudience" | "verifyOrganizationPrivateAudience"
      >
    | undefined,
  audience: PrivateDestination,
): Promise<AudienceCheck> {
  if (!io) return { ok: false, code: "direct-address-unproved" };
  try {
    if (audience.kind === "slack-unshared-im") {
      const address = io.directAudience?.();
      if (
        !address ||
        address.channelId !== audience.channelId ||
        address.userId !== audience.userId ||
        address.threadKey !== audience.threadKey
      )
        return { ok: false, code: "direct-address-mismatch" };
      return io.verifyDirectAudience
        ? await io.verifyDirectAudience(audience)
        : { ok: false, code: "direct-address-unproved" };
    }
    const current = io.organizationPrivateAudience?.();
    if (!current || !samePrivateDestination(audience, current)) return { ok: false, code: "direct-address-mismatch" };
    return io.verifyOrganizationPrivateAudience
      ? await io.verifyOrganizationPrivateAudience(audience)
      : { ok: false, code: "direct-address-unproved" };
  } catch {
    return { ok: false, code: "direct-audience-unavailable" };
  }
}
