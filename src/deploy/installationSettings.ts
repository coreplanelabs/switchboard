import { z } from "zod";
import { importCredentialKey, openCredential } from "../mcp/sealed.js";

const row = z.record(z.string(), z.union([z.string(), z.number().int(), z.null()]));
export const settingsSnapshotSchema = z
  .object({
    schema: z.literal(1),
    kind: z.enum(["config", "organization"]),
    tables: z.record(z.string(), z.array(row)),
  })
  .strict();
export type SettingsSnapshot = z.infer<typeof settingsSnapshotSchema>;
export type SettingsKind = SettingsSnapshot["kind"];
export const settingsTransferSchema = z
  .object({
    schema: z.literal(1),
    config: settingsSnapshotSchema,
    installations: z.array(z.string().min(1)),
    organizations: z.array(settingsSnapshotSchema),
  })
  .strict()
  .refine(
    (value) =>
      value.config.kind === "config" &&
      value.organizations.length === value.installations.length &&
      value.organizations.every((snapshot) => snapshot.kind === "organization"),
    "reset settings scope differs",
  );
export type SettingsTransfer = z.infer<typeof settingsTransferSchema>;

/** A matching name is insufficient: authenticate each blob with the original key. */
export async function authenticateResetCredentials(transfer: SettingsTransfer, key: string) {
  try {
    const imported = importCredentialKey(key);
    for (const record of transfer.config.tables.secrets ?? []) {
      const sealed = z
        .object({ serverId: z.string(), keyId: z.string(), sealed: z.string(), updatedAt: z.number() })
        .strict()
        .parse(JSON.parse(String(record.sealed)));
      if (sealed.serverId !== record.server_id) throw new Error("credential identity differs");
      await openCredential(imported, sealed);
    }
    return { authenticated: transfer.config.tables.secrets?.length ?? 0 };
  } catch {
    throw new Error("reset cannot authenticate the saved MCP credentials with the restoration key");
  }
}
