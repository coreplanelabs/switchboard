// The Slack adapter's attachment ingestion: which of a message's files reach the
// model (images, PDFs, text/code — never a secret-shaped file) and their
// downloads within the per-message and thread-wide budgets.

import { extname } from "node:path";
import type { DocumentAttachment, ImageAttachment } from "../../core/types.js";

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
const PDF_TYPE = "application/pdf";
// Text-ish mimetypes beyond the `text/*` family that Slack may report.
// `application/json` is deliberately absent: JSON is a common container for
// credentials (service-account keys, token dumps), so a file is never inlined
// just because Slack tags it application/json — the denylist below plus the
// extension allowlist decide, never the JSON mimetype on its own.
const TEXT_MIME_TYPES = new Set([
  "application/xml",
  "application/yaml",
  "application/x-yaml",
  "application/toml",
  "application/x-sh",
  "application/javascript",
  "application/typescript",
]);
// Mimetypes Slack assigns when it can't identify a file — fall back to the
// filename extension to decide whether it's a text/code file.
const GENERIC_MIME_TYPES = new Set(["application/octet-stream", "binary/octet-stream", ""]);
// Extensions inlined as text under the generic-mimetype fallback. JSON (`.json`,
// `.jsonl`) and config formats (`.env`, `.ini`, `.cfg`, `.conf`) are absent by
// design — the first two are frequent secret containers, the rest are covered by
// the secret-file denylist — so a generic-typed config/JSON file is not "fair
// game" for inlining just because of its extension.
const TEXT_EXTENSIONS = new Set([
  ".txt",
  ".md",
  ".markdown",
  ".log",
  ".csv",
  ".tsv",
  ".rst",
  ".yaml",
  ".yml",
  ".toml",
  ".xml",
  ".html",
  ".htm",
  ".css",
  ".scss",
  ".less",
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".py",
  ".rb",
  ".go",
  ".rs",
  ".java",
  ".kt",
  ".c",
  ".h",
  ".cpp",
  ".hpp",
  ".cc",
  ".cs",
  ".php",
  ".swift",
  ".sh",
  ".bash",
  ".zsh",
  ".sql",
  ".r",
  ".pl",
  ".lua",
  ".dart",
  ".scala",
  ".clj",
  ".ex",
  ".exs",
  ".vue",
  ".svelte",
  ".graphql",
  ".proto",
  ".dockerfile",
]);
// Secret-file denylist — filename shapes whose contents are likely credentials,
// private keys, or secret config. Matching files are skipped-with-note and their
// bytes NEVER reach the model prompt. This OVERRIDES text classification
// (checked before the text-mimetype/extension allowlist), because the whole risk
// is a secret file whose mimetype/extension otherwise reads as harmless text.
//
// Matched on the filename, case-insensitive, and independent of
// `node:path.extname` — which returns "" for dotfiles like `.env` and `.npmrc`,
// so an extname-based check would miss exactly the files that matter most.
const SECRET_FILE_EXTENSIONS = [".pem", ".key", ".p12", ".pfx", ".npmrc", ".netrc", ".ini", ".cfg", ".conf"];
const SECRET_FILE_PREFIXES = ["id_rsa"];

/** Does this filename look like a secret/credential/key/config file? Case-
 *  insensitive; conservative (a false match only skips a file, never leaks one).
 *  Exported for tests. */
export function isSecretFile(name: string | undefined): boolean {
  const n = (name ?? "").trim().toLowerCase();
  if (!n) return false;
  // `.env` in any position: bare `.env`, dotfiles (`.env.local`,
  // `.env.production`), and suffixed configs (`config.env`, `prod.env`).
  if (n.includes(".env")) return true;
  // SSH / private-key material by filename prefix (`id_rsa`, `id_rsa.pub`, …).
  if (SECRET_FILE_PREFIXES.some((p) => n.startsWith(p))) return true;
  // Credential JSON blobs — the common shapes secrets ship in.
  if (n === "credentials.json") return true;
  if (n.endsWith(".json") && (n.includes("service-account") || n.endsWith("-key.json"))) return true;
  // Secret-ish extensions, including dotfiles `extname` can't see.
  return SECRET_FILE_EXTENSIONS.some((ext) => n.endsWith(ext));
}
const MAX_DOCUMENT_BYTES = 10 * 1024 * 1024; // per-file cap; PDFs run larger than images
export const MAX_DOCS_PER_MESSAGE = 10;
// Thread-wide budget, spent newest-first (recent files matter most). Sized to
// stay under Anthropic's ~32MB request ceiling for a document-heavy thread.
export const MAX_HISTORY_DOCS = 20;
export const MAX_HISTORY_DOCUMENT_BYTES = 32 * 1024 * 1024;

/** Classify a file for document ingestion: a PDF, an inlinable text/code file,
 *  or neither. A secret-file denylist match (`isSecretFile`) is classified as
 *  neither — before any text check — so credentials never inline. Otherwise text
 *  detection prefers the mimetype and falls back to the filename extension only
 *  when Slack reports a generic/unknown type. Exported for tests. */
export function classifyDocument(mimetype: string | undefined, name: string | undefined): "pdf" | "text" | null {
  if (mimetype === PDF_TYPE) return "pdf";
  // Secret-file denylist OVERRIDES text classification: a credentials/key/config
  // file is skipped, never decoded into the prompt, even when its mimetype
  // (application/json, text/plain) or extension would otherwise mark it text.
  if (isSecretFile(name)) return null;
  const mt = mimetype ?? "";
  if (mt.startsWith("text/") || TEXT_MIME_TYPES.has(mt)) return "text";
  if (GENERIC_MIME_TYPES.has(mt) && TEXT_EXTENSIONS.has(extname(name ?? "").toLowerCase())) {
    return "text";
  }
  return null;
}

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
): Promise<{ images: ImageAttachment[]; skipped: string[]; bytes: number }> {
  const images: ImageAttachment[] = [];
  const skipped: string[] = [];
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
      return;
    }
    bytes += buf.byteLength;
    images.push({ mediaType, data: buf.toString("base64"), name: f.name });
  });
  return { images, skipped, bytes };
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
  const token = process.env.SLACK_BOT_TOKEN;
  try {
    const res = await fetch(url, { headers: token ? { authorization: `Bearer ${token}` } : {} });
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
): Promise<{ documents: DocumentAttachment[]; skipped: string[]; bytes: number }> {
  const documents: DocumentAttachment[] = [];
  const skipped: string[] = [];
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
      return;
    }
    bytes += buf.byteLength;
    documents.push({
      mediaType: f.mimetype ?? "text/plain",
      data: kind === "pdf" ? buf.toString("base64") : buf.toString("utf-8"),
      name: f.name,
    });
  });
  return { documents, skipped, bytes };
}
