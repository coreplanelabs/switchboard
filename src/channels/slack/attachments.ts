// The Slack adapter's attachment ingestion: which of a message's files reach the
// model (images, PDFs, text/code — never a secret-shaped file) and their
// downloads within the per-message and thread-wide budgets.

import { classifyDocument, isSecretFile } from "../attachmentTypes.js";
export { classifyDocument, isSecretFile } from "../attachmentTypes.js";
import type { DocumentAttachment, ImageAttachment, StagedFile } from "../../core/types.js";
import { processSecrets } from "../../secrets.js";

// Attachment ingestion. Only image types every provider accepts; Slack file
// downloads need the files:read bot scope.
const IMAGE_TYPES = new Set(["image/jpeg", "image/png", "image/gif", "image/webp"]);
const MAX_IMAGE_BYTES = 5 * 1024 * 1024; // provider hard limit per image
export const MAX_IMAGES_PER_MESSAGE = 10;
// Budget across a whole thread history so a screenshot-heavy thread can't
// blow up the request payload; spent newest-first (recent images matter most).
export const MAX_HISTORY_IMAGES = 20;
export const MAX_HISTORY_IMAGE_BYTES = 24 * 1024 * 1024;

// Document ingestion (mirrors images): PDFs (native document block where the
// provider supports it) and text/code/CSV/log files (inlined as fenced text).
const MAX_DOCUMENT_BYTES = 10 * 1024 * 1024; // per-file cap; PDFs run larger than images
export const MAX_DOCS_PER_MESSAGE = 10;
// Thread-wide budget, spent newest-first (recent files matter most). Sized to
// stay under Anthropic's ~32MB request ceiling for a document-heavy thread.
export const MAX_HISTORY_DOCS = 20;
export const MAX_HISTORY_DOCUMENT_BYTES = 32 * 1024 * 1024;

export interface SlackFile {
  id?: string;
  name?: string;
  mimetype?: string;
  size?: number;
  url_private_download?: string;
  url_private?: string;
}

/**
 * Download Slack-hosted files and return the ones usable as model image input.
 * Anything else (wrong type, too big, download failed) lands in `skipped` with
 * a human-readable label. Requires the files:read bot scope.
 */
export async function fetchImages(
  files: SlackFile[] | undefined,
  maxImages: number,
  maxTotalBytes = Infinity,
): Promise<{ images: ImageAttachment[]; skipped: string[]; skippedFiles: SlackFile[]; bytes: number }> {
  const images: ImageAttachment[] = [];
  const skipped: string[] = [];
  /** The same files as `skipped`, as objects: what staging matches on (a label can collide). */
  const skippedFiles: SlackFile[] = [];
  let bytes = 0;
  // Pass 1 (sync): decide which files are even candidates — type, declared
  // size, and the per-message count budget. Pass 2: download the candidates
  // CONCURRENTLY (each is a Slack CDN round trip; a screenshot-heavy message
  // used to pay them one after another). Pass 3 (sync, in the original order):
  // apply the byte budgets, so which file gets cut when the budget overflows is
  // the same as it was serially. One deliberate drift from the serial loop: the
  // count budget is spent by CANDIDATES, not by successful downloads, so a
  // failed fetch no longer frees its slot for a later file (serially, the
  // eleventh image got in when the third failed). Refilling would mean a
  // second download round;
  // a failed Slack fetch is rare and the cost is one fewer attachment.
  const candidates: Array<{ f: SlackFile; label: string; url: string; mediaType: string }> = [];
  for (const f of files ?? []) {
    const label = fileLabel(f);
    const url = f.url_private_download ?? f.url_private;
    if (
      !url ||
      !f.mimetype ||
      !IMAGE_TYPES.has(f.mimetype) ||
      (f.size ?? 0) > MAX_IMAGE_BYTES ||
      candidates.length >= maxImages
    ) {
      skipped.push(label);
      skippedFiles.push(f);
      continue;
    }
    candidates.push({ f, label, url, mediaType: f.mimetype });
  }
  // An image is never text/html, so any HTML answer is Slack's login page.
  const downloads = await Promise.all(
    candidates.map(({ url, label }) =>
      downloadSlackFile(url, label, (contentType) => contentType.includes("text/html")),
    ),
  );
  candidates.forEach(({ f, label, mediaType }, i) => {
    const buf = downloads[i];
    if (!buf || buf.byteLength > MAX_IMAGE_BYTES || bytes + buf.byteLength > maxTotalBytes) {
      skipped.push(label);
      skippedFiles.push(f);
      return;
    }
    bytes += buf.byteLength;
    images.push({ mediaType, data: buf.toString("base64"), name: f.name });
  });
  return { images, skipped, skippedFiles, bytes };
}

const fileLabel = (f: SlackFile) => `${f.name ?? f.id ?? "file"} (${f.mimetype ?? "unknown type"})`;

/** One Slack-hosted file's bytes, or undefined when the download failed (the
 *  failure is logged here; the caller only has to list the file as skipped).
 *  Slack answers an unauthorized file fetch with an HTML login page and HTTP
 *  200 — content-type is the reliable failure signal, judged by the caller
 *  (`isLoginPage`) because a genuine .html attachment is itself text/html. */
async function downloadSlackFile(
  url: string,
  label: string,
  isLoginPage: (contentType: string) => boolean,
): Promise<Buffer | undefined> {
  const token = processSecrets.get("SLACK_BOT_TOKEN");
  try {
    const res = await fetch(url, { headers: token ? { authorization: `Bearer ${token.reveal()}` } : {} });
    if (!res.ok || isLoginPage(res.headers.get("content-type") ?? "")) {
      console.error(`[files] download failed for ${label}: HTTP ${res.status}`);
      return undefined;
    }
    return Buffer.from(await res.arrayBuffer());
  } catch (err) {
    console.error(`[files] download failed for ${label}: ${err instanceof Error ? err.message : String(err)}`);
    return undefined;
  }
}

/**
 * Download Slack-hosted files and return the ones usable as model document
 * input: PDFs (base64) and text/code/CSV/log files (decoded to UTF-8). Anything
 * else (an image, an unsupported type, too big, download failed) lands in
 * `skipped` with a human-readable label. Mirrors `fetchImages`; requires the
 * files:read bot scope.
 */
export async function fetchDocuments(
  files: SlackFile[] | undefined,
  maxDocs: number,
  maxTotalBytes = Infinity,
): Promise<{ documents: DocumentAttachment[]; skipped: string[]; skippedFiles: SlackFile[]; bytes: number }> {
  const documents: DocumentAttachment[] = [];
  const skipped: string[] = [];
  const skippedFiles: SlackFile[] = [];
  let bytes = 0;
  // Same three passes as fetchImages: candidates → concurrent downloads →
  // budgets applied in the original order.
  const candidates: Array<{ f: SlackFile; label: string; url: string; kind: "pdf" | "text" }> = [];
  for (const f of files ?? []) {
    const label = fileLabel(f);
    const url = f.url_private_download ?? f.url_private;
    const kind = classifyDocument(f.mimetype, f.name);
    if (!url || !kind || (f.size ?? 0) > MAX_DOCUMENT_BYTES || candidates.length >= maxDocs) {
      skipped.push(label);
      skippedFiles.push(f);
      continue;
    }
    candidates.push({ f, label, url, kind });
  }
  const downloads = await Promise.all(
    candidates.map(({ url, label, f }) =>
      downloadSlackFile(url, label, (contentType) => contentType.includes("text/html") && f.mimetype !== "text/html"),
    ),
  );
  candidates.forEach(({ f, label, kind }, i) => {
    const buf = downloads[i];
    if (!buf || buf.byteLength > MAX_DOCUMENT_BYTES || bytes + buf.byteLength > maxTotalBytes) {
      skipped.push(label);
      skippedFiles.push(f);
      return;
    }
    bytes += buf.byteLength;
    documents.push({
      mediaType: f.mimetype ?? "text/plain",
      data: kind === "pdf" ? buf.toString("base64") : buf.toString("utf-8"),
      name: f.name,
    });
  });
  return { documents, skipped, skippedFiles, bytes };
}

// Staging (docs/reference/specs/execution.md item 20, record 0033): the files
// NEITHER pass could carry — a video, a 6 MiB screenshot, a PDF over the
// document cap, a zip — are not lost when the artifact store is configured:
// they stay on Slack by reference and a run with a workspace pulls them into
// `attachments/` before its turn. The inline caps above do not move: a 1 MiB
// PNG still inlines, a 5 MiB one still inlines, a 6 MiB one is staged.
/** Slack's own per-file ceiling; a larger file is skipped with the reason. */
export const MAX_STAGED_FILE_BYTES = 1_073_741_824;
/** Files staged per message; the rest are skipped with the reason. */
export const MAX_STAGED_PER_MESSAGE = 10;

/**
 * Which of the files the inline passes rejected are staged instead, in message
 * order, and which stay skipped — each skipped file's label carrying its reason.
 * `unsupported` is the FILES both passes rejected (their `skippedFiles`,
 * matched by identity — two files of one name and type on a message are two
 * files, and the one an inline pass carried is never staged twice). The
 * secret-file denylist wins over staging exactly as it wins over inlining: a
 * `.pem` is never copied anywhere. Off (`staging: false`) → nothing is staged
 * and the labels come back as the note always read them, so a deployment
 * without a store is unchanged.
 */
export function stagedFiles(
  unsupported: readonly SlackFile[],
  opts: { staging: boolean; maxBytesPerMessage: number; messageId: string },
): { staged: StagedFile[]; skipped: string[] } {
  if (!opts.staging) return { staged: [], skipped: unsupported.map(fileLabel) };
  const staged: StagedFile[] = [];
  const skipped: string[] = [];
  let total = 0;
  for (const f of unsupported) {
    const label = fileLabel(f);
    const url = f.url_private_download ?? f.url_private;
    const size = f.size ?? 0;
    if (isSecretFile(f.name)) {
      skipped.push(`${label} — looks like a credential or key file`);
      continue;
    }
    if (!url || !f.name || size <= 0) {
      skipped.push(`${label} — Slack gave no download URL, name or size`);
      continue;
    }
    if (size > MAX_STAGED_FILE_BYTES) {
      skipped.push(`${label} — ${size} bytes is over the ${MAX_STAGED_FILE_BYTES}-byte per-file ceiling`);
      continue;
    }
    if (staged.length >= MAX_STAGED_PER_MESSAGE) {
      skipped.push(`${label} — more than ${MAX_STAGED_PER_MESSAGE} files on one message`);
      continue;
    }
    if (total + size > opts.maxBytesPerMessage) {
      skipped.push(`${label} — the message's files exceed the ${opts.maxBytesPerMessage}-byte budget`);
      continue;
    }
    total += size;
    staged.push({ name: f.name, size, type: f.mimetype ?? "application/octet-stream", url, messageId: opts.messageId });
  }
  return { staged, skipped };
}
