import { createHash } from "node:crypto";
import type { ContentPart } from "../../chatMessage.js";
import type { OpenCodePrompt } from "./client.js";
export function openCodeMediaFiles(parts: readonly ContentPart[]): NonNullable<OpenCodePrompt["files"]> {
  return parts.flatMap((part) => {
    if (part.type !== "image" && part.type !== "document") return [];
    const mime = part.mediaType;
    if (!["image/png", "image/jpeg", "image/gif", "image/webp", "application/pdf"].includes(mime))
      throw new Error("The media type is unsupported by this input transport.");
    const bytes = Buffer.from(part.data, "base64");
    if (!bytes.length || bytes.length > 20 * 1024 * 1024 || bytes.toString("base64") !== part.data)
      throw new Error("The original media representation exceeds this input transport's bounds.");
    return [{ uri: `data:${mime};base64,${part.data}`, ...("name" in part && part.name ? { name: part.name } : {}) }];
  });
}
export function openCodeMediaId(
  runId: string,
  text: string,
  files: NonNullable<OpenCodePrompt["files"]>,
  sourceId?: string,
): string {
  return `msg_${createHash("sha256")
    .update(JSON.stringify([runId, sourceId ?? null, text, files]))
    .digest("hex")}`;
}
/** A binary admission cannot be inferred from an echo of its caption alone. */
export function openCodeMediaAck(body: unknown, sessionID: string, expected: OpenCodePrompt): boolean {
  const files = expected.files;
  if (!files?.length) return false;
  let value: unknown = body;
  if (typeof value === "string") {
    try {
      value = JSON.parse(value);
    } catch {
      return false;
    }
  }
  if (!value || typeof value !== "object") return false;
  const row = (
    value as {
      data?: {
        id?: string;
        sessionID?: string;
        type?: string;
        payload?: {
          text?: string;
          files?: { data?: string; mime?: string; name?: string; source?: { type?: string } }[];
        };
      };
    }
  ).data;
  if (
    !row ||
    row.id !== expected.id ||
    row.sessionID !== sessionID ||
    row.type !== "user" ||
    row.payload?.text !== expected.text ||
    !Array.isArray(row.payload.files) ||
    row.payload.files.length !== expected.files?.length
  )
    return false;
  return files.every((file, index) => {
    const match = /^data:([^;]+);base64,(.+)$/.exec(file.uri);
    const actual = row.payload!.files![index];
    if (
      !match ||
      !actual ||
      actual.source?.type !== "inline" ||
      actual.name !== file.name ||
      typeof actual.data !== "string"
    )
      return false;
    if (!match[1]!.startsWith("image/")) return actual.mime === match[1] && actual.data === match[2];
    // The installed server can resize and reencode accepted images. Its exact
    // request-derived ID binds the original ordered bytes; the ACK proves that
    // each image was materialized, not that normalized bytes equal the source.
    if (actual.mime !== match[1] && actual.mime !== "image/png" && actual.mime !== "image/jpeg") return false;
    const bytes = Buffer.from(actual.data, "base64");
    return bytes.length > 0 && bytes.length <= 20 * 1024 * 1024 && bytes.toString("base64") === actual.data;
  });
}
