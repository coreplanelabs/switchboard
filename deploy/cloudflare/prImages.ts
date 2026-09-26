import { MAX_PR_IMAGE_BYTES, prImageKey, readPrImage, validPrImageSource } from "../../src/artifacts/prImages.ts";
import { DAY_MS } from "../../src/core/budgets.ts";
import { systemClock } from "../../src/core/trace/clock.ts";
import { sameToken } from "./artifactsCopy.ts";

/** The small part of R2 needed for deliberate publication. No list or public
 *  bucket capability: reads can address only copies this handler marked. */
export interface PrImageBucket {
  get(key: string): Promise<{
    size: number;
    body: ReadableStream<Uint8Array>;
    httpMetadata?: { contentType?: string };
    customMetadata?: Record<string, string>;
  } | null>;
  put(
    key: string,
    bytes: Uint8Array,
    options: {
      httpMetadata: { contentType: string };
      customMetadata: Record<string, string>;
    },
  ): Promise<unknown>;
}

const json = (status: number, body: Record<string, unknown>) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });

export async function publishPrImage(
  request: Request,
  deps: { bucket?: PrImageBucket; token?: string; clock?: () => number },
): Promise<Response> {
  const bearer = /^Bearer\s+(\S+)$/.exec(request.headers.get("authorization") ?? "")?.[1];
  if (!deps.token || !bearer || !sameToken(bearer, deps.token))
    return json(401, { error: "publication bearer refused" });
  if (request.method !== "POST") return json(405, { error: "publication requires POST" });
  if (!deps.bucket) return json(503, { error: "artifact store unavailable" });
  let key: unknown;
  let retentionDays: unknown;
  try {
    const input = (await request.json()) as { key?: unknown; retentionDays?: unknown } | null;
    key = input?.key;
    retentionDays = input?.retentionDays;
  } catch {
    /* Refuse below, before reading storage. */
  }
  if (typeof key !== "string" || !validPrImageSource(key))
    return json(400, { error: "publication requires an outbound artifact key" });
  if (typeof retentionDays !== "number" || !Number.isSafeInteger(retentionDays) || retentionDays < 1)
    return json(400, { error: "publication requires retentionDays as a positive integer" });
  const expiresAt = (deps.clock ?? systemClock)() + retentionDays * DAY_MS;
  if (!Number.isSafeInteger(expiresAt) || expiresAt < 1)
    return json(400, { error: "publication expiry is out of range" });
  const object = await deps.bucket.get(key);
  if (!object) return json(404, { error: "artifact not found" });
  let bytes: Uint8Array;
  try {
    bytes = await readPrImage({ ...object, contentType: object.httpMetadata?.contentType ?? "" });
  } catch {
    // A storage stream can fail with internal paths or stack details; the caller
    // needs only the stable validation result.
    return json(400, { error: "invalid PR image" });
  }
  const path = `/pr-images/${crypto.randomUUID()}.png`;
  await deps.bucket.put(prImageKey(path)!, bytes, {
    httpMetadata: { contentType: "image/png" },
    customMetadata: { publishedForPr: "true", sourceKey: key, expiresAt: String(expiresAt) },
  });
  return json(200, { path });
}

/** Public only by deliberate copy. The URL is an address, not a run-reader
 *  capability; there is no way to substitute a private key into this route. */
export async function handlePrImage(
  request: Request,
  bucket?: PrImageBucket,
  clock: () => number = systemClock,
): Promise<Response> {
  if (request.method !== "GET" && request.method !== "HEAD") return json(405, { error: "GET or HEAD only" });
  const url = new URL(request.url);
  const key = prImageKey(url.pathname);
  if (!key || url.search || !bucket) return json(404, { error: "not found" });
  const object = await bucket.get(key);
  // Lifecycle deletion is asynchronous; it must not extend public availability.
  // Older or malformed copies without a valid deadline also fail closed.
  const expiresAt = Number(object?.customMetadata?.expiresAt);
  if (
    !object ||
    object.customMetadata?.publishedForPr !== "true" ||
    !Number.isSafeInteger(expiresAt) ||
    expiresAt < 1 ||
    clock() >= expiresAt ||
    object.httpMetadata?.contentType !== "image/png" ||
    object.size < 1 ||
    object.size > MAX_PR_IMAGE_BYTES
  ) {
    await object?.body.cancel();
    return json(404, { error: "not found" });
  }
  if (request.method === "HEAD") await object.body.cancel();
  return new Response(request.method === "HEAD" ? null : object.body, {
    headers: {
      "content-type": "image/png",
      "content-length": String(object.size),
      "content-disposition": 'inline; filename="screenshot.png"',
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
      "content-security-policy": "default-src 'none'; sandbox",
    },
  });
}
