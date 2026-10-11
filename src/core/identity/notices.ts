import { z } from "zod";
import { identitySchema } from "./contract.js";
import { identityNoticeSchema, type IdentityNotice } from "./linkContract.js";

/** Internal fixed-organization outbox work, authenticated by the store host.
 * This seam cannot change a binding or acknowledge a browser notice. */
export const noticeCommandSchema = z.discriminatedUnion("action", [
  z
    .object({
      action: z.literal("pending"),
      organization: identitySchema.shape.subject,
      limit: z.number().int().min(1).max(100),
    })
    .strict(),
  z
    .object({
      action: z.literal("attempted"),
      organization: identitySchema.shape.subject,
      id: identityNoticeSchema.shape.id,
    })
    .strict(),
  z
    .object({
      action: z.literal("delivered"),
      organization: identitySchema.shape.subject,
      id: identityNoticeSchema.shape.id,
    })
    .strict(),
]);
export type NoticeCommand = z.infer<typeof noticeCommandSchema>;
export const noticeResultSchema = z.union([
  z.object({ status: z.literal("notices"), notices: z.array(identityNoticeSchema) }).strict(),
  z.object({ status: z.enum(["delivered", "attempted", "not_found", "invalid", "unavailable"]) }).strict(),
]);
export type NoticeResult = z.infer<typeof noticeResultSchema>;
export interface NoticeQuery {
  organization?: string;
  actor?: import("./contract.js").ExternalIdentity;
  recipient?: import("./contract.js").ExternalIdentity;
  id?: string;
  slack?: boolean;
  pending?: boolean;
  limit?: number;
  retryOrder?: boolean;
}
export function executeNotices(
  tx: { notices(query?: NoticeQuery): unknown[]; putNotice(notice: IdentityNotice): void },
  input: NoticeCommand,
  now: number,
): NoticeResult {
  const parsed = noticeCommandSchema.safeParse(input);
  if (!parsed.success || !Number.isSafeInteger(now) || now < 0) return { status: "invalid" };
  const command = parsed.data;
  const notices = tx
    .notices({
      organization: command.organization,
      slack: true,
      ...(command.action === "pending"
        ? { pending: true, limit: command.limit, retryOrder: true }
        : { id: command.id }),
    })
    .map((row) => identityNoticeSchema.parse(row))
    .filter(
      (row) =>
        row.organization === command.organization &&
        row.identity.issuer === "https://slack.com" &&
        row.identity.tenant !== null,
    );
  if (command.action === "pending")
    return { status: "notices", notices: notices.filter((row) => row.deliveredAt === null).slice(0, command.limit) };
  const notice = notices.find((row) => row.id === command.id);
  if (!notice) return { status: "not_found" };
  if (command.action === "attempted") {
    if (notice.deliveredAt !== null) return { status: "delivered" };
    const attempts = (notice.attempts ?? 0) + 1;
    const updated = identityNoticeSchema.parse({ ...notice, attempts, attemptedAt: now });
    tx.putNotice(updated);
    return { status: "attempted" };
  }
  if (notice.deliveredAt === null) tx.putNotice({ ...notice, deliveredAt: now });
  return { status: "delivered" };
}
