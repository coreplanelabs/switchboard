import { AwsClient } from "aws4fetch";
import { systemClock } from "../core/trace/clock.js";
import type { Secret } from "../secrets.js";
import { ARTIFACT_DEFAULTS } from "./config.js";

type Clock = () => number;

// The artifact store (docs/decisions/0033-artifacts-move-by-reference-through-r2.md,
// docs/reference/specs/execution.md item 20): where a run's files live by
// reference. The bot signs URLs and reads sizes; it never carries a file. The
// container PUTs and pulls with `curl` against the presigned URLs; the bot's
// Worker copies an inbound Slack file into the bucket on `copyFromUrl`. Two
// implementations behind the seam (AGENTS.md invariant 2): R2 through its S3
// API, and an in-memory store for tests and the conformance suite.

/** What the store knows about an object without its bytes. */
export interface ArtifactHead {
  size: number;
  contentType: string;
}

/** What a copy answers: the key it landed under and the bytes it holds. */
export interface ArtifactRef {
  key: string;
  size: number;
}

/** An object opened for reading: its head and a stream of its bytes, for the
 *  run page's proxy route (live-view.md item 26) to pipe — the one place the
 *  bot's process touches an artifact's bytes, and only in transit. */
export interface ArtifactObject extends ArtifactHead {
  body: ReadableStream<Uint8Array>;
  /** The slice `body` holds when the read asked for one (inclusive offsets
   *  into the object; `size` stays the WHOLE object's). Absent, the body is
   *  the whole object. */
  part?: { start: number; end: number };
}

/** A ranged read that lands past the object's end: the size the 416 names. */
export interface ArtifactUnsatisfiable extends ArtifactHead {
  unsatisfiable: true;
}

/** RFC 9110's single-range forms, as the proxy accepts them and the stores
 *  serve them: `bytes=start-end`, `bytes=start-` (to the end), `bytes=-suffix`
 *  (the last `suffix` bytes). Anything else — a list of ranges, another unit,
 *  an inverted pair, prose — is `undefined`: the read then ignores the header
 *  and answers the whole object, which the RFC allows and every player takes. */
export interface ByteRange {
  start?: number;
  end?: number;
  suffix?: number;
}

export function parseByteRange(header: string | undefined): ByteRange | undefined {
  if (!header) return undefined;
  const m = /^\s*bytes=(\d*)-(\d*)\s*$/i.exec(header);
  if (!m) return undefined;
  const [, from, to] = m;
  if (from === "" && to === "") return undefined;
  if (from === "") return { suffix: Number(to) };
  const start = Number(from);
  if (to === "") return { start };
  const end = Number(to);
  return end < start ? undefined : { start, end };
}

/** The header the wire carries for a parsed range — canonical, one form each. */
function rangeHeader(range: ByteRange): string {
  if (range.suffix !== undefined) return `bytes=-${range.suffix}`;
  return `bytes=${range.start}-${range.end ?? ""}`;
}

/** Where a parsed range lands on an object of `total` bytes: the inclusive
 *  offsets, or null when the start is past the end (a 416). */
export function resolveByteRange(range: ByteRange, total: number): { start: number; end: number } | null {
  if (range.suffix !== undefined) {
    if (range.suffix === 0 || total === 0) return null;
    return { start: Math.max(0, total - range.suffix), end: total - 1 };
  }
  const start = range.start ?? 0;
  if (start >= total) return null;
  return { start, end: Math.min(total - 1, range.end ?? total - 1) };
}

/** What a read may ask for beyond the key. */
export interface ArtifactGetOptions {
  /** The request's `Range` header, verbatim; a form `parseByteRange` refuses is ignored. */
  range?: string;
}

export interface ArtifactStore {
  readonly bucket: string;
  /** A URL a container may PUT `contentType` bytes to for `PRESIGN_TTL_SECONDS`; the type is signed, so the PUT must send it. */
  presignPut(key: string, contentType: string): Promise<string>;
  /** A URL a container may GET for `PRESIGN_TTL_SECONDS`. */
  presignGet(key: string): Promise<string>;
  /** The object's size and type, or null when there is none. */
  head(key: string): Promise<ArtifactHead | null>;
  /** The object's bytes as a stream (a signed GET, minted per call), or null
   *  when there is none. With a `range`, the slice as `part` (the proxy's
   *  players seek by it), the whole object when the store ignores the range,
   *  or `unsatisfiable` with the size when the range starts past the end. */
  get(key: string, opts?: ArtifactGetOptions): Promise<ArtifactObject | ArtifactUnsatisfiable | null>;
  /** Copy `size` bytes from `url` (a Slack `url_private`) into `key` without the bot holding them. */
  copyFromUrl(input: { url: string; size: number; key: string }): Promise<ArtifactRef>;
}

export const PRESIGN_TTL_SECONDS = ARTIFACT_DEFAULTS.presignTtlSeconds;

type Fetch = typeof fetch;

export interface R2ArtifactStoreOptions {
  accountId: string;
  bucket: string;
  accessKeyId: Secret;
  secretAccessKey: Secret;
  /** The bot's own Worker, which holds the R2 binding and the Slack token the copy needs. */
  copy: { baseUrl: string; token: Secret; timeoutMs?: number };
  fetch?: Fetch;
  clock?: Clock;
}

/** The one request header the store's reads carry beside the signature.
 *  Node's fetch advertises `br, gzip, deflate, zstd` on any https request that
 *  names no encoding; the edge then compresses a compressible object's answer
 *  (text/plain from 48 bytes) and omits Content-Length, and a HEAD carries the
 *  compressed GET's headers — so the size the bot verifies by was gone. Asking
 *  for identity keeps the object's own length on the wire; signed, so R2
 *  accepts it. */
const IDENTITY = { "accept-encoding": "identity" } as const;

/** The AWS SigV4 timestamp for a clock reading: `YYYYMMDDTHHMMSSZ`. */
function amzDate(now: number): string {
  return new Date(now).toISOString().replace(/[:-]|\.\d{3}/g, "");
}

/** One key segment at a time, so `/` stays a delimiter and everything else is URL-safe. */
function encodeKey(key: string): string {
  return key.split("/").map(encodeURIComponent).join("/");
}

/** R2 over its S3-compatible API. Every URL admits a request for
 *  `PRESIGN_TTL_SECONDS` and names one key; the region is `auto` (R2 ignores it,
 *  the signer requires it); the payload is unsigned, as S3 presigned URLs are. */
export class R2ArtifactStore implements ArtifactStore {
  readonly bucket: string;
  private readonly client: AwsClient;
  private readonly endpoint: string;
  private readonly fetchImpl: Fetch;
  private readonly clock: Clock;
  private readonly copy: { baseUrl: string; token: Secret; timeoutMs: number };

  constructor(opts: R2ArtifactStoreOptions) {
    this.bucket = opts.bucket;
    this.endpoint = `https://${opts.accountId}.r2.cloudflarestorage.com/${opts.bucket}`;
    this.client = new AwsClient({
      accessKeyId: opts.accessKeyId.reveal(),
      secretAccessKey: opts.secretAccessKey.reveal(),
      service: "s3",
      region: "auto",
      retries: 0,
    });
    this.fetchImpl = opts.fetch ?? fetch;
    this.clock = opts.clock ?? systemClock;
    this.copy = { ...opts.copy, timeoutMs: opts.copy.timeoutMs ?? ARTIFACT_DEFAULTS.copyTimeoutMs };
  }

  private objectUrl(key: string): URL {
    return new URL(`${this.endpoint}/${encodeKey(key)}`);
  }

  private async presign(key: string, method: "PUT" | "GET", headers: Record<string, string> = {}): Promise<string> {
    const url = this.objectUrl(key);
    url.searchParams.set("X-Amz-Expires", String(PRESIGN_TTL_SECONDS));
    // `allHeaders`: the signer leaves `content-type` unsigned by default; a PUT
    // signs it so the object's type is the one the tool derived, not whatever
    // the container sends.
    const signed = await this.client.sign(new Request(url, { method, headers }), {
      aws: { signQuery: true, allHeaders: Object.keys(headers).length > 0, datetime: amzDate(this.clock()) },
    });
    return signed.url;
  }

  presignPut(key: string, contentType: string): Promise<string> {
    return this.presign(key, "PUT", { "content-type": contentType });
  }

  presignGet(key: string): Promise<string> {
    return this.presign(key, "GET");
  }

  async head(key: string): Promise<ArtifactHead | null> {
    const signed = await this.client.sign(new Request(this.objectUrl(key), { method: "HEAD", headers: IDENTITY }), {
      aws: { datetime: amzDate(this.clock()) },
    });
    const res = await this.fetchImpl(signed);
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`artifact store: HEAD ${key} answered HTTP ${res.status}`);
    // `Number(null)` is 0: an answer with no length header must not read as an
    // empty object — the tool would then report "holds 0 bytes", a size nobody measured.
    const length = res.headers.get("content-length");
    const size = length === null ? Number.NaN : Number(length);
    if (!Number.isFinite(size) || size < 0) {
      throw new Error(`artifact store: HEAD ${key} answered HTTP ${res.status} without a length`);
    }
    return { size, contentType: res.headers.get("content-type") ?? "application/octet-stream" };
  }

  async get(key: string, opts: ArtifactGetOptions = {}): Promise<ArtifactObject | ArtifactUnsatisfiable | null> {
    // `range` rides beside the signature, not inside it: aws4fetch lists it
    // among the headers it never signs, which is how S3 clients send it.
    const range = parseByteRange(opts.range);
    const headers = range ? { ...IDENTITY, range: rangeHeader(range) } : IDENTITY;
    const signed = await this.client.sign(new Request(this.objectUrl(key), { method: "GET", headers }), {
      aws: { datetime: amzDate(this.clock()) },
    });
    const res = await this.fetchImpl(signed);
    if (res.status === 404) return null;
    const contentType = res.headers.get("content-type") ?? "application/octet-stream";
    if (res.status === 416) {
      // A 416 names the size as `Content-Range: bytes */<size>` — when it does.
      // R2's S3 endpoint answers InvalidRange with an XML body and no such
      // header, so the size is read from one HEAD instead; the range was the
      // caller's, and a start past the end must answer 416, never a throw. An
      // object the HEAD no longer finds is gone: null, the route's 410.
      const total = /\/(\d+)\s*$/.exec(res.headers.get("content-range") ?? "");
      if (total) return { unsatisfiable: true, size: Number(total[1]), contentType };
      const head = await this.head(key);
      if (!head) return null;
      return { unsatisfiable: true, size: head.size, contentType: head.contentType };
    }
    if (!res.ok || !res.body) throw new Error(`artifact store: GET ${key} answered HTTP ${res.status}`);
    if (res.status === 206) {
      const m = /^bytes (\d+)-(\d+)\/(\d+)\s*$/.exec(res.headers.get("content-range") ?? "");
      if (!m) throw new Error(`artifact store: GET ${key} answered HTTP 206 without a content-range`);
      return { size: Number(m[3]), contentType, body: res.body, part: { start: Number(m[1]), end: Number(m[2]) } };
    }
    const size = Number(res.headers.get("content-length"));
    if (!Number.isFinite(size) || size < 0) throw new Error(`artifact store: GET ${key} answered without a length`);
    return { size, contentType, body: res.body };
  }

  async copyFromUrl(input: { url: string; size: number; key: string }): Promise<ArtifactRef> {
    const res = await this.fetchImpl(`${this.copy.baseUrl.replace(/\/$/, "")}/artifacts/copy`, {
      method: "POST",
      headers: { authorization: `Bearer ${this.copy.token.reveal()}`, "content-type": "application/json" },
      body: JSON.stringify(input),
      signal: AbortSignal.timeout(this.copy.timeoutMs),
    });
    const text = await res.text();
    if (!res.ok)
      throw new Error(`artifact store: copy of ${input.key} answered HTTP ${res.status}: ${text.slice(0, 300)}`);
    const answer = JSON.parse(text) as { key?: unknown; size?: unknown };
    if (answer.key !== input.key || answer.size !== input.size) {
      throw new Error(
        `artifact store: copy of ${input.key} answered ${text.slice(0, 300)}, not the ${input.size} bytes asked for`,
      );
    }
    return { key: input.key, size: input.size };
  }
}

/** The second implementation: objects in a Map, URLs that name the store.
 *  `copyFromUrl` fetches with the injected `fetch`, so the inbound path is
 *  testable with no Worker. */
export class InMemoryArtifactStore implements ArtifactStore {
  readonly bucket: string;
  readonly objects = new Map<string, { bytes: Uint8Array; contentType: string }>();
  /** Every copy asked for, in order, for a test to read. */
  readonly copies: Array<{ url: string; size: number; key: string }> = [];
  private readonly fetchImpl: Fetch;

  constructor(opts: { bucket?: string; fetch?: Fetch } = {}) {
    this.bucket = opts.bucket ?? "memory";
    this.fetchImpl = opts.fetch ?? fetch;
  }

  put(key: string, bytes: Uint8Array, contentType: string): void {
    this.objects.set(key, { bytes, contentType });
  }

  async presignPut(key: string, contentType: string): Promise<string> {
    return `memory://${this.bucket}/${encodeKey(key)}?method=PUT&content-type=${encodeURIComponent(contentType)}&expires=${PRESIGN_TTL_SECONDS}`;
  }

  async presignGet(key: string): Promise<string> {
    return `memory://${this.bucket}/${encodeKey(key)}?method=GET&expires=${PRESIGN_TTL_SECONDS}`;
  }

  async head(key: string): Promise<ArtifactHead | null> {
    const o = this.objects.get(key);
    return o ? { size: o.bytes.byteLength, contentType: o.contentType } : null;
  }

  async get(key: string, opts: ArtifactGetOptions = {}): Promise<ArtifactObject | ArtifactUnsatisfiable | null> {
    const o = this.objects.get(key);
    if (!o) return null;
    const size = o.bytes.byteLength;
    const range = parseByteRange(opts.range);
    const part = range ? resolveByteRange(range, size) : undefined;
    if (range && !part) return { unsatisfiable: true, size, contentType: o.contentType };
    const bytes = part ? o.bytes.slice(part.start, part.end + 1) : o.bytes;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(bytes);
        controller.close();
      },
    });
    return { size, contentType: o.contentType, body, ...(part ? { part } : {}) };
  }

  async copyFromUrl(input: { url: string; size: number; key: string }): Promise<ArtifactRef> {
    this.copies.push(input);
    const res = await this.fetchImpl(input.url);
    if (!res.ok) throw new Error(`artifact store: copy of ${input.key} from ${input.url} answered HTTP ${res.status}`);
    const bytes = new Uint8Array(await res.arrayBuffer());
    if (bytes.byteLength !== input.size) {
      throw new Error(
        `artifact store: copy of ${input.key} received ${bytes.byteLength} of ${input.size} bytes; nothing stored`,
      );
    }
    this.put(input.key, bytes, res.headers.get("content-type") ?? "application/octet-stream");
    return { key: input.key, size: input.size };
  }
}
