import type { DocumentAttachment, ImageAttachment, StagedFile } from "../../core/types.js";
import { ARTIFACT_DEFAULTS } from "../../artifacts/config.js";
import { LINEAR_TIMING } from "../../core/budgets.js";
import { INLINE_IMAGE_TYPES } from "../../artifacts/contentType.js";
import { classifyDocument, isSecretFile } from "../attachmentTypes.js";

export const LINEAR_FILE_LIMITS = {
  count: 10,
  historyCount: 20,
  imageBytes: 5 * 1024 * 1024,
  documentBytes: 10 * 1024 * 1024,
  totalBytes: 12 * 1024 * 1024,
  stagedFileBytes: 1024 * 1024 * 1024,
} as const;
export interface LinearFileReference {
  url: string;
  name: string;
}
export interface LinearFile extends LinearFileReference {
  image?: ImageAttachment;
  document?: DocumentAttachment;
  staged?: { size: number; type: string };
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
  const encoded = /filename\*\s*=\s*UTF-8'[^']*'([^;]+)/i.exec(header)?.[1];
  if (encoded) {
    try {
      return filename(decodeURIComponent(encoded));
    } catch {
      return;
    }
  }
  const plain = /filename\s*=\s*(?:"([^"]*)"|([^;]+))/i.exec(header);
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

/** Web APIs only: the credential-holding Worker does not enable Node globals.
 * Chunk conversion also avoids spreading a multi-megabyte file onto the stack. */
function base64(bytes: Uint8Array): string {
  let binary = "";
  const chunkSize = 32 * 1024;
  for (let offset = 0; offset < bytes.length; offset += chunkSize)
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
  return btoa(binary);
}

/** Called only after the edge has proved these references belong to the
 * requester's current session context. The OAuth token never leaves this call. */
export async function downloadLinearFiles(
  refs: readonly LinearFileReference[],
  deps: { fetch: typeof fetch; token(): Promise<string>; maxStagedBytes?: number },
  count: number = LINEAR_FILE_LIMITS.count,
): Promise<LinearFile[]> {
  const files: LinearFile[] = [];
  let total = 0;
  let stagedBytes = 0;
  const stagingBudget = Math.min(deps.maxStagedBytes ?? 0, LINEAR_FILE_LIMITS.stagedFileBytes * count);
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
    if (index >= count || (total >= LINEAR_FILE_LIMITS.totalBytes && !stagingBudget)) {
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
      const declared = Number(response.headers.get("content-length"));
      const max = Math.min(
        image ? LINEAR_FILE_LIMITS.imageBytes : LINEAR_FILE_LIMITS.documentBytes,
        LINEAR_FILE_LIMITS.totalBytes - total,
      );
      if (stagingBudget && ((!image && !kind) || declared > max)) {
        await response.body?.cancel();
        if (!Number.isSafeInteger(declared) || declared <= 0) file.skipped = "no size for workspace staging";
        else if (declared > LINEAR_FILE_LIMITS.stagedFileBytes || stagedBytes + declared > stagingBudget)
          file.skipped = "workspace staging byte budget";
        else {
          stagedBytes += declared;
          file.staged = { size: declared, type: mediaType };
        }
        continue;
      }
      if (!image && !kind) {
        await response.body?.cancel();
        file.skipped = "unsupported inline file type";
        continue;
      }
      const bytes = await readLimited(response, max);
      if (!bytes) {
        file.skipped = "attachment byte limit";
        continue;
      }
      total += bytes.byteLength;
      const data = image || kind === "pdf" ? base64(bytes) : new TextDecoder().decode(bytes);
      if (image) file.image = { name: file.name, mediaType, data };
      else file.document = { name: file.name, mediaType, data };
    } catch {
      throw new Error("linear_file_unavailable");
    }
  }
  return files;
}

export function applyLinearFiles<
  T extends {
    text: string;
    messageId?: string;
    images?: ImageAttachment[];
    documents?: DocumentAttachment[];
    staged?: StagedFile[];
  },
>(
  turn: T,
  files: readonly LinearFile[],
): T & { images?: ImageAttachment[]; documents?: DocumentAttachment[]; staged?: StagedFile[] } {
  const urls = new Set(fileReferences(turn.text).map((ref) => ref.url));
  const selected = files.filter((file) => urls.has(file.url));
  const images = selected.flatMap((file) => (file.image ? [file.image] : []));
  const documents = selected.flatMap((file) => (file.document ? [file.document] : []));
  const staged = selected.flatMap((file) =>
    file.staged && turn.messageId
      ? [{ name: file.name, url: file.url, ...file.staged, messageId: turn.messageId }]
      : [],
  );
  const skipped = selected.filter((file) => file.skipped).map((file) => `${file.name}: ${file.skipped}`);
  return {
    ...turn,
    ...(images.length ? { images: [...(turn.images ?? []), ...images] } : {}),
    ...(documents.length ? { documents: [...(turn.documents ?? []), ...documents] } : {}),
    ...(staged.length ? { staged: [...(turn.staged ?? []), ...staged] } : {}),
    ...(skipped.length ? { text: `${turn.text}\n\n[Attachments not read: ${skipped.join("; ")}]` } : {}),
  };
}

export interface LinearFileCopy {
  put(key: string, stream: ReadableStream<Uint8Array>, type: string): Promise<unknown>;
  lengthPipe(size: number): { readable: ReadableStream<Uint8Array>; writable: WritableStream<Uint8Array> };
}

/** The edge streams a freshly authorized reference into the artifact store.
 * The caller binds the key to the session; no credential or bytes leave here. */
export async function copyLinearFile(
  ref: LinearFileReference,
  file: StagedFile,
  key: string,
  deps: { fetch: typeof fetch; token(): Promise<string>; copy: LinearFileCopy; signal?: AbortSignal },
): Promise<{ key: string; size: number }> {
  if (
    privateUrl(file.url) !== file.url ||
    file.url !== ref.url ||
    isSecretFile(ref.name) ||
    isSecretFile(urlName(file.url)) ||
    isSecretFile(file.name)
  )
    throw new Error("linear_file_denied");
  deps.signal?.throwIfAborted();
  const controller = new AbortController();
  const signal = AbortSignal.any([
    controller.signal,
    AbortSignal.timeout(ARTIFACT_DEFAULTS.copyTimeoutMs),
    ...(deps.signal ? [deps.signal] : []),
  ]);
  const response = await deps.fetch(file.url, {
    redirect: "error",
    signal,
    headers: { authorization: `Bearer ${await deps.token()}` },
  });
  const name = responseName(response.headers.get("content-disposition")) ?? ref.name;
  const size = Number(response.headers.get("content-length"));
  if (response.status !== 200 || !response.body || size !== file.size || name !== file.name || isSecretFile(name)) {
    await response.body?.cancel();
    throw new Error("linear_file_changed_or_unavailable");
  }
  const pipe = deps.copy.lengthPipe(file.size);
  const pumping = response.body.pipeTo(pipe.writable, { signal });
  try {
    await Promise.all([
      pumping,
      deps.copy.put(key, pipe.readable, response.headers.get("content-type") ?? "application/octet-stream"),
    ]);
  } catch {
    controller.abort();
    // A put can fail before it starts reading. Release the pipe's backpressure
    // too, so its pending write cannot keep the authenticated download alive.
    await pipe.readable.cancel().catch(() => {});
    await pumping.catch(() => {});
    await response.body.cancel().catch(() => {});
    throw new Error("linear_file_copy_failed");
  }
  return { key, size: file.size };
}
