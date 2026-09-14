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

export interface ArtifactStore {
  readonly bucket: string;
  /** A URL a container may PUT `contentType` bytes to for `PRESIGN_TTL_SECONDS`; the type is signed, so the PUT must send it. */
  presignPut(key: string, contentType: string): Promise<string>;
  /** A URL a container may GET for `PRESIGN_TTL_SECONDS`. */
  presignGet(key: string): Promise<string>;
  /** The object's size and type, or null when there is none. */
  head(key: string): Promise<ArtifactHead | null>;
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
    const signed = await this.client.sign(new Request(this.objectUrl(key), { method: "HEAD" }), {
      aws: { datetime: amzDate(this.clock()) },
    });
    const res = await this.fetchImpl(signed);
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`artifact store: HEAD ${key} answered HTTP ${res.status}`);
    const size = Number(res.headers.get("content-length"));
    if (!Number.isFinite(size) || size < 0) throw new Error(`artifact store: HEAD ${key} answered without a length`);
    return { size, contentType: res.headers.get("content-type") ?? "application/octet-stream" };
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
