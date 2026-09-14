// The artifact copy route (docs/reference/specs/execution.md item 20, record
// 0033): `POST /artifacts/copy { url, size, key }` streams a Slack file into
// the artifacts bucket without the bot's container ever holding the bytes.
// The bot asks (`R2ArtifactStore.copyFromUrl`, bearer ARTIFACTS_COPY_TOKEN);
// this Worker holds the two things the copy needs — the R2 binding and the
// Slack bot token that `url_private` requires — and answers `{ key, size }`
// only once the bucket holds exactly `size` bytes under `key`.
//
// Pure over its deps so it is tested in plain Node (this directory's tests
// run no workerd): the bucket, the upstream fetch, the length pipe (workerd's
// `FixedLengthStream`, which refuses a body of another length) and the tokens
// are handed in; `worker.ts` binds them from `env`.

/** What the route needs from the bucket: R2's `put` with a stream and the object's type. */
export interface CopyBucket {
  put(
    key: string,
    value: ReadableStream<Uint8Array>,
    options?: { httpMetadata?: { contentType?: string } },
  ): Promise<unknown>;
}

export interface CopyDeps {
  /** The `ARTIFACTS` R2 binding; absent when the deployment configures no bucket. */
  bucket: CopyBucket | undefined;
  /** The bucket's name as the Worker was deployed with (`ARTIFACTS_BUCKET_NAME`), for `GET`. */
  bucketName: string | undefined;
  /** The bearer the bot presents (`ARTIFACTS_COPY_TOKEN`). */
  copyToken: string | undefined;
  /** The Slack bot token `url_private` requires. Read from the Worker's env, never from the request. */
  slackToken: string | undefined;
  fetch: typeof fetch;
  /** A pipe that carries exactly `size` bytes and fails on any other count:
   *  `new FixedLengthStream(size)` in workerd, whose reader R2 accepts as a
   *  stream of known length; a `TransformStream` in tests. */
  lengthPipe: (size: number) => { readable: ReadableStream<Uint8Array>; writable: WritableStream<Uint8Array> };
  /** The largest copy accepted; default `MAX_COPY_BYTES`. */
  maxBytes?: number;
}

export const COPY_PATH = "/artifacts/copy";

/** Slack's own per-file ceiling; a larger declared size is refused before any fetch. */
export const MAX_COPY_BYTES = 1_073_741_824;

/** The hosts a `url_private` may name: Slack's file host and the workspace's own. */
export function slackFileHost(hostname: string): boolean {
  return hostname === "files.slack.com" || hostname === "slack.com" || hostname.endsWith(".slack.com");
}

/** Inbound keys as `inboundKey` (src/artifacts/keys.ts) builds them and nothing
 *  else: under `threads/`, one character class, no empty or dot segments. */
const KEY_RE = /^threads\/[A-Za-z0-9._-]+\/in\/[A-Za-z0-9._-]+\/\d+-[A-Za-z0-9._-]+$/;
export function validCopyKey(key: string): boolean {
  return KEY_RE.test(key) && !key.split("/").some((s) => s === "" || /^\.+$/.test(s));
}

/** Constant-time equality over the two strings' UTF-8 bytes (a length difference is a mismatch). */
export function sameToken(a: string, b: string): boolean {
  const x = new TextEncoder().encode(a);
  const y = new TextEncoder().encode(b);
  let diff = x.length ^ y.length;
  for (let i = 0; i < Math.max(x.length, y.length); i++) diff |= (x[i] ?? 0) ^ (y[i] ?? 0);
  return diff === 0;
}

export type CopyRequest = { url: URL; size: number; key: string };

/** Pure: the body parsed and checked, or the 4xx that refuses it — before any fetch. */
export function parseCopyRequest(
  raw: string,
  maxBytes: number,
): { ok: true; value: CopyRequest } | { ok: false; status: 400 | 413; reason: string } {
  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    return { ok: false, status: 400, reason: "body is not JSON" };
  }
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return { ok: false, status: 400, reason: "body is not an object" };
  }
  const { url, size, key } = body as Record<string, unknown>;
  if (typeof url !== "string") return { ok: false, status: 400, reason: "url must be a string" };
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { ok: false, status: 400, reason: "url is not a URL" };
  }
  if (parsed.protocol !== "https:" || !slackFileHost(parsed.hostname)) {
    return { ok: false, status: 400, reason: `url host ${parsed.hostname} is not a Slack file host` };
  }
  if (typeof size !== "number" || !Number.isInteger(size) || size < 1) {
    return { ok: false, status: 400, reason: "size must be a positive integer" };
  }
  if (size > maxBytes) return { ok: false, status: 413, reason: `size ${size} is over the ${maxBytes}-byte ceiling` };
  if (typeof key !== "string" || !validCopyKey(key)) {
    return { ok: false, status: 400, reason: "key is not an inbound artifact key" };
  }
  return { ok: true, value: { url: parsed, size, key } };
}

const json = (status: number, body: Record<string, unknown>) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

/** The route. WHO: the copy bearer, checked in constant time before anything
 *  else (401, and never the bucket's existence). WHAT: a Slack `url_private`,
 *  a positive size within the ceiling and an inbound key (400/413, before any
 *  fetch). THEN the upstream: Slack answers the login page (`text/html`) when
 *  the token does not reach the file — refused as unauthorized, nothing put;
 *  a status other than 200 is Slack's word (502); a `Content-Length` absent or
 *  other than `size` is a 409 before any `put`. The body flows through the
 *  length pipe into one `put` with Slack's content type; a stream that ends
 *  short fails the pipe, the put rejects and the bucket keeps nothing (502). */
export async function handleArtifactsCopy(request: Request, deps: CopyDeps): Promise<Response> {
  const bearer = /^Bearer\s+(\S+)$/.exec(request.headers.get("authorization") ?? "")?.[1];
  if (!deps.copyToken || !bearer || !sameToken(bearer, deps.copyToken)) {
    return json(401, { ok: false, error: "artifacts copy: bearer refused" });
  }
  if (request.method === "GET") {
    return deps.bucket && deps.bucketName
      ? json(200, { ok: true, bucket: deps.bucketName })
      : json(503, { ok: false, error: "artifacts copy: this Worker has no ARTIFACTS bucket binding" });
  }
  if (request.method !== "POST") return json(405, { ok: false, error: `method not allowed: POST ${COPY_PATH}` });
  if (!deps.bucket)
    return json(503, { ok: false, error: "artifacts copy: this Worker has no ARTIFACTS bucket binding" });
  if (!deps.slackToken)
    return json(503, { ok: false, error: "artifacts copy: SLACK_BOT_TOKEN is not set on this Worker" });
  const parsed = parseCopyRequest(await request.text().catch(() => ""), deps.maxBytes ?? MAX_COPY_BYTES);
  if (!parsed.ok) return json(parsed.status, { ok: false, error: `artifacts copy: ${parsed.reason}` });
  const { url, size, key } = parsed.value;

  let upstream: Response;
  try {
    upstream = await deps.fetch(url.toString(), {
      headers: { authorization: `Bearer ${deps.slackToken}` },
      redirect: "manual",
    });
  } catch (err) {
    return json(502, { ok: false, error: `artifacts copy: slack did not answer: ${describe(err)}` });
  }
  const contentType = upstream.headers.get("content-type") ?? "application/octet-stream";
  if (upstream.status === 200 && /^text\/html\b/i.test(contentType)) {
    await upstream.body?.cancel().catch(() => {});
    return json(502, {
      ok: false,
      error: "artifacts copy: slack answered its login page — the bot token is not authorized for this file",
    });
  }
  if (upstream.status !== 200 || !upstream.body) {
    await upstream.body?.cancel().catch(() => {});
    return json(502, { ok: false, error: `artifacts copy: slack answered HTTP ${upstream.status}` });
  }
  const declared = Number(upstream.headers.get("content-length"));
  if (!upstream.headers.has("content-length") || !Number.isInteger(declared)) {
    await upstream.body.cancel().catch(() => {});
    return json(409, { ok: false, error: "artifacts copy: slack stated no length for the file" });
  }
  if (declared !== size) {
    await upstream.body.cancel().catch(() => {});
    return json(409, { ok: false, error: `artifacts copy: slack states ${declared} bytes, not the ${size} declared` });
  }

  // The bytes: upstream → the fixed-length pipe → one put. Either side failing
  // rejects the whole copy; R2 keeps nothing for a stream that did not complete.
  const { readable, writable } = deps.lengthPipe(size);
  try {
    await Promise.all([
      upstream.body.pipeTo(writable),
      deps.bucket.put(key, readable, { httpMetadata: { contentType } }),
    ]);
  } catch (err) {
    return json(502, { ok: false, error: `artifacts copy: the copy of ${key} failed mid-stream: ${describe(err)}` });
  }
  return json(200, { ok: true, key, size });
}

const describe = (err: unknown): string => (err instanceof Error ? err.message : String(err));
