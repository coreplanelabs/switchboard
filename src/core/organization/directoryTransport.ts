import { z } from "zod";
import {
  bindingSchema,
  changeSchema,
  identitySchema,
  personIdSchema,
  receiptSchema,
  type PersonDirectory,
} from "../identity/contract.js";
import { linkAuditSchema, linkCommandSchema, linkIntentSchema } from "../identity/linkContract.js";
export const directoryCommandSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("createPerson") }).strict(),
  z.object({ action: z.literal("resolve"), identity: identitySchema }).strict(),
  z.object({ action: z.literal("change"), change: changeSchema }).strict(),
  z.object({ action: z.literal("receipts"), identity: identitySchema }).strict(),
  z.object({ action: z.literal("link"), command: linkCommandSchema }).strict(),
]);
export type DirectoryCommand = z.infer<typeof directoryCommandSchema>;
export async function executeDirectory(directory: PersonDirectory, command: DirectoryCommand) {
  switch (command.action) {
    case "createPerson":
      return directory.createPerson();
    case "resolve":
      return directory.resolve(command.identity);
    case "change":
      return directory.change(command.change);
    case "receipts":
      return directory.receipts(command.identity);
    case "link":
      return directory.link(command.command);
  }
}
const failure = <const T extends readonly [string, ...string[]]>(values: T) =>
  z.object({ status: z.enum(values) }).strict();
export const directoryResponses = {
  createPerson: z.union([
    z
      .object({
        status: z.literal("created"),
        person: z.object({ id: personIdSchema, createdAt: bindingSchema.shape.changedAt }).strict(),
      })
      .strict(),
    failure(["unavailable"]),
  ]),
  resolve: z.union([
    z.object({ status: z.literal("bound"), binding: bindingSchema }).strict(),
    z.object({ status: z.literal("revoked"), revision: bindingSchema.shape.revision }).strict(),
    failure(["unknown", "conflict", "invalid", "unavailable"]),
  ]),
  change: z.union([
    z.object({ status: z.literal("changed"), binding: bindingSchema }).strict(),
    failure(["conflict", "stale", "revoked", "unknown", "unknown_person", "invalid", "unavailable"]),
  ]),
  receipts: z.union([
    z.object({ status: z.literal("ok"), receipts: z.array(receiptSchema) }).strict(),
    failure(["invalid", "conflict", "unavailable"]),
  ]),
  link: z.union([
    z
      .object({
        status: z.literal("context"),
        intent: linkIntentSchema
          .refine((i) => i.state === "pending" || i.state === "exchanging" || i.state === "awaiting-consent")
          .transform((i) => {
            if (!("accessRevision" in i)) throw new Error("invalid link context");
            return i;
          }),
      })
      .strict(),
    z
      .object({
        status: z.enum(["ok", "claimed"]),
        intent: z
          .object({
            id: linkCommandSchema.options[1].shape.id,
            state: z.enum(["pending", "exchanging", "awaiting-consent", "committed", "failed", "cancelled", "expired"]),
            revision: z.number().int().nonnegative(),
            expiresAt: bindingSchema.shape.changedAt,
          })
          .strict(),
      })
      .strict(),
    z.object({ status: z.literal("committed"), receipt: linkAuditSchema }).strict(),
    failure([
      "conflict",
      "stale",
      "revoked",
      "failed",
      "cancelled",
      "expired",
      "not_found",
      "invalid",
      "unavailable",
      "already_claimed",
      "not_ready",
      "consent_required",
    ]),
  ]),
};
