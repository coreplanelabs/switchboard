// The content type of a produced file, derived once from its extension
// (docs/reference/specs/execution.md item 20): it is signed into the R2 PUT,
// carried on the `artifact` event, and served by the run page's proxy from the
// event, so the three never disagree. Types the model can already see inline
// (src/channels/slack/attachments.ts) and the artifacts a run produces; anything
// else is a plain binary.

const BY_EXTENSION: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  svg: "image/svg+xml",
  pdf: "application/pdf",
  mp4: "video/mp4",
  webm: "video/webm",
  mov: "video/quicktime",
  mp3: "audio/mpeg",
  wav: "audio/wav",
  txt: "text/plain",
  md: "text/markdown",
  csv: "text/csv",
  json: "application/json",
  html: "text/html",
  zip: "application/zip",
  gz: "application/gzip",
  tar: "application/x-tar",
};

export const OCTET_STREAM = "application/octet-stream";

/** The four image types the run page renders inline; every other type is a download. */
export const INLINE_IMAGE_TYPES: ReadonlySet<string> = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);

export function contentTypeFor(name: string): string {
  const dot = name.lastIndexOf(".");
  if (dot < 0 || dot === name.length - 1) return OCTET_STREAM;
  return BY_EXTENSION[name.slice(dot + 1).toLowerCase()] ?? OCTET_STREAM;
}
