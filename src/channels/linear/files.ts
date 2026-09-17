import type { DocumentAttachment, ImageAttachment } from "../../core/types.js";
import { LINEAR_TIMING } from "../../core/budgets.js";
import { INLINE_IMAGE_TYPES } from "../../artifacts/contentType.js";
import { classifyDocument, isSecretFile } from "../attachmentTypes.js";

export const LINEAR_FILE_LIMITS = {
  count: 10,
  historyCount: 20,
  imageBytes: 5 * 1024 * 1024,
  documentBytes: 10 * 1024 * 1024,
  totalBytes: 12 * 1024 * 1024,
} as const;
export interface LinearFileReference {
  url: string;
  name: string;
}
export interface LinearFile extends LinearFileReference {
  image?: ImageAttachment;
  document?: DocumentAttachment;
  skipped?: string;
}

function privateUrl(value: string): string | undefined {
  try {
    const url = new URL(value);
    if (
      url.protocol !== "https:" ||
      url.hostname !== "uploads.linear.app" ||
      url.port ||
      url.username ||
      url.password ||
      url.pathname === "/"
    )
      return;
    // Signed query strings are capabilities; use the edge credential instead.
    url.search = "";
    url.hash = "";
    return url.href;
  } catch {
    return;
  }
}
function filename(value: string): string {
  return (
    [...value.split(/[\\/]/).at(-1)!]
      .filter((char) => char.charCodeAt(0) >= 32 && char.charCodeAt(0) !== 127)
      .join("")
      .slice(0, 255) || "attachment"
  );
}
function urlName(url: string): string {
  try {
    return filename(decodeURIComponent(new URL(url).pathname));
  } catch {
    return "attachment";
  }
}

/** Markdown links carry original filenames even when storage uses opaque ids.
 * Bare URLs work too. External links never become authenticated downloads. */
export function fileReferences(text: string): LinearFileReference[] {
  const refs = new Map<string, LinearFileReference>();
  for (const match of text.matchAll(
    /!?\[([^\]\n]{0,255})\]\(\s*<?(https:\/\/uploads\.linear\.app\/[^\s<>)]+)>?(?:\s+"[^"]*")?\s*\)/g,
  )) {
    const url = privateUrl(match[2]!);
    if (url && !refs.has(url)) refs.set(url, { url, name: filename(match[1] || urlName(url)) });
  }
  for (const match of text.matchAll(/https:\/\/uploads\.linear\.app[^\s<>"'\])]+/g)) {
    const url = privateUrl(match[0].replace(/[.,;]+$/, ""));
    if (url && !refs.has(url)) refs.set(url, { url, name: urlName(url) });
  }
  return [...refs.values()];
}

function responseName(header: string | null): string | undefined {
  if (!header) return;
  const encoded = /filename\*=UTF-8''([^;]+)/i.exec(header)?.[1];
  if (encoded) {
    try {
      return filename(decodeURIComponent(encoded));
    } catch {
      return;
    }
  }
  const plain = /filename=(?:"([^"]*)"|([^;]+))/i.exec(header);
  return plain ? filename((plain[1] ?? plain[2]!).trim()) : undefined;
}

/** Streaming limits apply even when Content-Length is absent or dishonest. */
async function readLimited(response: Response, limit: number): Promise<Uint8Array | undefined> {
  const length = Number(response.headers.get("content-length"));
  if (length > limit) {
    await response.body?.cancel();
    return;
  }
  const reader = response.body?.getReader();
  if (!reader) return new Uint8Array();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) {
        await reader.cancel();
        return;
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

/** Called only after the edge has proved these references belong to the
 * requester's current session context. The OAuth token never leaves this call. */
export async function downloadLinearFiles(
  refs: readonly LinearFileReference[],
  deps: { fetch: typeof fetch; token(): Promise<string> },
  count: number = LINEAR_FILE_LIMITS.count,
): Promise<LinearFile[]> {
  const files: LinearFile[] = [];
  let total = 0;
  for (const [index, ref] of refs.entries()) {
    const file: LinearFile = { ...ref };
    files.push(file);
    if (privateUrl(ref.url) !== ref.url) {
      file.skipped = "invalid private file URL";
      continue;
    }
    if (isSecretFile(ref.name) || isSecretFile(urlName(ref.url))) {
      file.skipped = "looks like a credential or key file";
      continue;
    }
    if (index >= count || total >= LINEAR_FILE_LIMITS.totalBytes) {
      file.skipped = "attachment budget limit";
      continue;
    }
    try {
      const response = await deps.fetch(ref.url, {
        redirect: "error",
        signal: AbortSignal.timeout(LINEAR_TIMING.apiTimeoutMs),
        headers: { authorization: `Bearer ${await deps.token()}` },
      });
      if (response.status === 429 || response.status >= 500) {
        await response.body?.cancel();
        throw new Error("retry");
      }
      if (!response.ok) {
        await response.body?.cancel();
        file.skipped = "not available from Linear";
        continue;
      }
      file.name = responseName(response.headers.get("content-disposition")) ?? ref.name;
      if (isSecretFile(file.name)) {
        await response.body?.cancel();
        file.skipped = "looks like a credential or key file";
        continue;
      }
      const mediaType = (response.headers.get("content-type") ?? "application/octet-stream")
        .split(";")[0]!
        .trim()
        .toLowerCase();
      const image = INLINE_IMAGE_TYPES.has(mediaType);
      const kind = classifyDocument(mediaType, file.name);
      if (!image && !kind) {
        await response.body?.cancel();
        file.skipped = "unsupported inline file type";
        continue;
      }
      const max = Math.min(
        image ? LINEAR_FILE_LIMITS.imageBytes : LINEAR_FILE_LIMITS.documentBytes,
        LINEAR_FILE_LIMITS.totalBytes - total,
      );
      const bytes = await readLimited(response, max);
      if (!bytes) {
        file.skipped = "attachment byte limit";
        continue;
      }
      total += bytes.byteLength;
      const data = image || kind === "pdf" ? Buffer.from(bytes).toString("base64") : new TextDecoder().decode(bytes);
      if (image) file.image = { name: file.name, mediaType, data };
      else file.document = { name: file.name, mediaType, data };
    } catch {
      throw new Error("linear_file_unavailable");
    }
  }
  return files;
}

export function applyLinearFiles<
  T extends { text: string; images?: ImageAttachment[]; documents?: DocumentAttachment[] },
>(turn: T, files: readonly LinearFile[]): T & { images?: ImageAttachment[]; documents?: DocumentAttachment[] } {
  const urls = new Set(fileReferences(turn.text).map((ref) => ref.url));
  const selected = files.filter((file) => urls.has(file.url));
  const images = selected.flatMap((file) => (file.image ? [file.image] : []));
  const documents = selected.flatMap((file) => (file.document ? [file.document] : []));
  const skipped = selected.filter((file) => file.skipped).map((file) => `${file.name}: ${file.skipped}`);
  return {
    ...turn,
    ...(images.length ? { images: [...(turn.images ?? []), ...images] } : {}),
    ...(documents.length ? { documents: [...(turn.documents ?? []), ...documents] } : {}),
    ...(skipped.length ? { text: `${turn.text}\n\n[Attachments not read: ${skipped.join("; ")}]` } : {}),
  };
}
