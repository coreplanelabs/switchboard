// How a message's file renders in its panel (docs/reference/specs/live-view.md
// item 26), decided by the event's recorded content type — never sniffed, never
// the object's own header. Pure, so the component and its tests share one table.
import { INLINE_IMAGE_TYPES } from "@core/artifacts/contentType.js";

/** What the panel under a file's row renders. */
export type PreviewKind = "image" | "video" | "audio" | "text" | "other";

/** Bytes of a text file the panel shows before it stops reading. */
export const TEXT_PREVIEW_CAP = 64 * 1024;

/** Structured text types beside `text/*` that read as text. */
const TEXT_TYPES: ReadonlySet<string> = new Set([
  "application/json",
  "application/x-ndjson",
  "application/xml",
  "application/yaml",
]);

export function previewKindOf(contentType: string): PreviewKind {
  if (INLINE_IMAGE_TYPES.has(contentType)) return "image";
  if (contentType.startsWith("video/")) return "video";
  if (contentType.startsWith("audio/")) return "audio";
  if (contentType.startsWith("text/") || TEXT_TYPES.has(contentType)) return "text";
  return "other";
}
