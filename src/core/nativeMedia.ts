import { z } from "zod";
import type { IncomingMessage } from "./types.js";

const name = z.string().min(1).max(2048);
export const nativeMediaDigestSchema = z.string().regex(/^[0-9a-f]{64}$/);
const staged = z
  .object({
    name,
    size: z.number().int().positive().max(1_073_741_824),
    type: name,
    url: z.string().url().max(2048),
    messageId: name,
    workspaceIndex: z.number().int().nonnegative().max(999).optional(),
  })
  .strict();
export const nativeMediaSchema = z
  .object({
    version: z.literal(1),
    channelId: name,
    userId: name,
    threadKey: name,
    messageId: name,
    rawTextDigest: nativeMediaDigestSchema,
    sourceFilesDigest: nativeMediaDigestSchema,
    editedAt: name.optional(),
    files: z
      .array(
        z
          .object({
            id: z.string().regex(/^slack:file:F[A-Za-z0-9_]+$/),
            slot: z.number().int().nonnegative().max(999),
            kind: z.enum(["image", "document", "staged"]),
            index: z.number().int().nonnegative().max(9),
            mediaType: name,
            name: name.optional(),
            size: z.number().int().positive().max(1_073_741_824),
            representationDigest: nativeMediaDigestSchema.optional(),
            staged: staged.optional(),
          })
          .strict(),
      )
      .min(1)
      .max(30),
  })
  .strict()
  .refine((media) => {
    const ids = new Set<string>(),
      positions = new Set<string>(),
      slots = new Set<number>();
    return media.files.every((file) => {
      const position = `${file.kind}:${file.index}`;
      if (ids.has(file.id) || positions.has(position) || slots.has(file.slot)) return false;
      ids.add(file.id);
      positions.add(position);
      slots.add(file.slot);
      if (file.kind === "image" && file.size > 5 * 1024 * 1024) return false;
      if (file.kind === "document" && file.size > 10 * 1024 * 1024) return false;
      return file.kind === "staged" ? !!file.staged && !file.representationDigest : !!file.representationDigest;
    });
  });
export type NativeMedia = z.infer<typeof nativeMediaSchema>;
export async function nativeMediaDigest(value: string | NativeMedia): Promise<string> {
  const bytes = new TextEncoder().encode(
    typeof value === "string" ? value : JSON.stringify(nativeMediaSchema.parse(value)),
  );
  return [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}
export async function matchesNativeMedia(
  media: NativeMedia,
  value: Pick<IncomingMessage, "images" | "documents" | "staged">,
): Promise<boolean> {
  for (const kind of ["image", "document", "staged"] as const) {
    const files = media.files.filter((file) => file.kind === kind);
    const items =
      kind === "image" ? (value.images ?? []) : kind === "document" ? (value.documents ?? []) : (value.staged ?? []);
    if (files.length !== items.length) return false;
    for (let index = 0; index < files.length; index++) {
      const file = files[index]!,
        item = items[index]!;
      if (file.index !== index) return false;
      if (kind === "staged") {
        if (JSON.stringify(item) !== JSON.stringify(file.staged)) return false;
      } else {
        const inline = item as NonNullable<IncomingMessage["images"]>[number];
        if (
          inline.mediaType !== file.mediaType ||
          inline.name !== file.name ||
          (await nativeMediaDigest(inline.data)) !== file.representationDigest ||
          JSON.stringify(inline.staged ?? null) !== JSON.stringify(file.staged ?? null)
        )
          return false;
      }
    }
  }
  return true;
}
