import { timingSafeEqual } from "node:crypto";
import type { IncomingHttpHeaders, IncomingMessage as HttpRequest, ServerResponse } from "node:http";
import { dispatch as realDispatch, type CoreDeps } from "../core/dispatcher.js";
import type { ChannelIO, HistoryItem, IncomingMessage, StatusHandle, StatusUpdate } from "../core/types.js";

// HTTP channel adapter: adapter #3. Like Slack and the CLI, it is pure
// transport — it turns an inbound HTTP POST into an IncomingMessage, calls the
// channel-agnostic core dispatch(), and provides a ChannelIO to reply through.
// Nothing about routing, config, permissions, or agents lives here.
//
// HTTP is single-shot request/response, unlike Slack's long-lived threads:
//   - reply() collects text; the collected text is the HTTP response body.
//   - status() is a no-op handle (no live surface to edit in a one-shot call).
//   - history() returns the optional `history` array from the body, else [].
//
// Security is owned in-band (this endpoint is our own service, not behind a
// platform's auth): bearer-token auth, fail-closed, constant-time compares,
// identity mapped from the token. See authenticate() below.

const PLATFORM = "http";
const DEFAULT_CHANNEL = "default";
const DEFAULT_THREAD = "default";
/** Reject bodies larger than this before buffering them fully. */
export const MAX_BODY_BYTES = 1_000_000; // 1 MB

/** The identity a token maps to. `subject` becomes `userId` "http:<subject>";
 *  an optional `channel` pins the config scope regardless of the request body
 *  (a token can be locked to one channel scope). */
export interface IngressIdentity {
  subject: string;
  channel?: string;
}

/** Ingress auth config: raw bearer token -> identity. An empty map means the
 *  endpoint is DISABLED (fail-closed) — never open. */
export interface IngressConfig {
  tokens: Record<string, IngressIdentity>;
}

/** The dispatch signature; injectable so tests never hit real providers. */
export type DispatchFn = (deps: CoreDeps, msg: IncomingMessage, io: ChannelIO) => Promise<void>;

export interface IngressOptions {
  auth: IngressConfig;
  /** Defaults to the real core dispatch(); overridden in tests. */
  dispatch?: DispatchFn;
  /** Max body size in bytes (node wrapper enforces at read time). */
  maxBodyBytes?: number;
}

/** Equal-length constant-time string compare. Guards length first (differing
 *  lengths cannot be timingSafeEqual'd and are never a match); never logged. */
function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

/**
 * Pure auth: map request headers to an identity, or null if unauthenticated.
 * Requires `Authorization: Bearer <token>`; an unknown/missing/malformed token
 * yields null. The compare is constant-time and does NOT short-circuit on the
 * first match (every configured token is checked), so neither the presence nor
 * the position of a matching token is a timing oracle. Token material is never
 * logged. Fail-closed is the CALLER's job: an empty token map must be treated
 * as "disabled" before authenticate() is consulted.
 */
export function authenticate(headers: IncomingHttpHeaders, config: IngressConfig): IngressIdentity | null {
  const header = headers.authorization;
  const raw = Array.isArray(header) ? header[0] : header;
  if (!raw) return null;
  const match = /^Bearer\s+(.+)$/i.exec(raw.trim());
  if (!match) return null;
  const presented = match[1];

  let identity: IngressIdentity | null = null;
  for (const [token, mapped] of Object.entries(config.tokens)) {
    if (safeEqual(presented, token)) identity = mapped;
  }
  return identity;
}

/** Parsed, validated request payload. */
interface IngressBody {
  text: string;
  channel?: string;
  thread?: string;
  history: HistoryItem[];
}

/** Build the namespaced IncomingMessage from an authed identity + the body.
 *  Mirrors the Slack adapter's namespacing (invariant 4): userId "http:<sub>",
 *  channelId "http:<channel>", threadKey "http:<channel>:<thread>". A token's
 *  pinned channel wins over the body's; otherwise the body chooses, else the
 *  default scope. */
function toIncomingMessage(identity: IngressIdentity, body: IngressBody): IncomingMessage {
  const channel = identity.channel ?? body.channel ?? DEFAULT_CHANNEL;
  const thread = body.thread ?? DEFAULT_THREAD;
  return {
    userId: `${PLATFORM}:${identity.subject}`,
    channelId: `${PLATFORM}:${channel}`,
    threadKey: `${PLATFORM}:${channel}:${thread}`,
    text: body.text,
  };
}

/** ChannelIO for a single-shot HTTP request: reply() collects, status() is a
 *  no-op, history() replays what the body supplied. */
export class HttpIO implements ChannelIO {
  private replies: string[] = [];
  constructor(private readonly priorTurns: HistoryItem[] = []) {}

  async reply(text: string): Promise<void> {
    this.replies.push(text);
  }

  async status(_initial: StatusUpdate): Promise<StatusHandle> {
    // No live surface in a one-shot HTTP call; the final reply carries the
    // result. Honest no-op rather than a fake progress channel.
    return {
      update: () => {},
      done: async () => {},
    };
  }

  async history(): Promise<HistoryItem[]> {
    return this.priorTurns;
  }

  /** The collected reply text — the HTTP response body. */
  collected(): string {
    return this.replies.join("\n\n");
  }
}

/** Validate and normalize the JSON body. Returns an error string on bad shape
 *  (surfaced as 400), never throws for caller-controlled input. */
function parseBody(raw: string): { body: IngressBody } | { error: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { error: "invalid JSON body" };
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return { error: "body must be a JSON object" };
  }
  const obj = parsed as Record<string, unknown>;
  if (typeof obj.text !== "string" || obj.text.trim() === "") {
    return { error: "`text` is required and must be a non-empty string" };
  }
  if (obj.channel !== undefined && typeof obj.channel !== "string") {
    return { error: "`channel` must be a string" };
  }
  if (obj.thread !== undefined && typeof obj.thread !== "string") {
    return { error: "`thread` must be a string" };
  }
  const history: HistoryItem[] = [];
  if (obj.history !== undefined) {
    if (!Array.isArray(obj.history)) return { error: "`history` must be an array" };
    for (const item of obj.history) {
      if (typeof item !== "object" || item === null) return { error: "each `history` item must be an object" };
      const h = item as Record<string, unknown>;
      if (h.role !== "user" && h.role !== "assistant") {
        return { error: '`history[].role` must be "user" or "assistant"' };
      }
      if (typeof h.text !== "string") return { error: "`history[].text` must be a string" };
      history.push({ role: h.role, text: h.text });
    }
  }
  return {
    body: {
      text: obj.text,
      channel: obj.channel as string | undefined,
      thread: obj.thread as string | undefined,
      history,
    },
  };
}

export interface IngressRequest {
  method?: string;
  headers: IncomingHttpHeaders;
  body: string;
}

export interface IngressResponse {
  status: number;
  body: unknown;
}

/**
 * Core request handler, decoupled from node's http so it is fully unit-testable
 * (no socket). Ordering matters and is deliberate:
 *   1. non-POST                -> 405
 *   2. no tokens configured    -> 503 disabled   (FAIL-CLOSED: never open)
 *   3. missing/unknown token   -> 401 unauthorized
 *   4. invalid/bad JSON body   -> 400
 *   5. authed + valid          -> dispatch(), reply collected -> 200
 * Body-size enforcement (413) happens upstream in the node wrapper, before the
 * body is ever fully buffered.
 */
export async function handleIngressRequest(
  req: IngressRequest,
  deps: CoreDeps,
  options: IngressOptions,
): Promise<IngressResponse> {
  if ((req.method ?? "GET").toUpperCase() !== "POST") {
    return { status: 405, body: { error: "method not allowed; POST only" } };
  }
  // Fail-closed: with no tokens configured the endpoint is disabled, never open.
  if (Object.keys(options.auth.tokens).length === 0) {
    return { status: 503, body: { error: "disabled", detail: "no ingress tokens configured" } };
  }
  const identity = authenticate(req.headers, options.auth);
  if (!identity) {
    return { status: 401, body: { error: "unauthorized" } };
  }
  const parsed = parseBody(req.body);
  if ("error" in parsed) {
    return { status: 400, body: { error: parsed.error } };
  }
  const msg = toIncomingMessage(identity, parsed.body);
  const io = new HttpIO(parsed.body.history);
  const dispatchFn = options.dispatch ?? realDispatch;
  await dispatchFn(deps, msg, io);
  return { status: 200, body: { reply: io.collected() } };
}

/**
 * Read the request body with a hard size cap, aborting before a large payload
 * is buffered. Exported for tests (fed a fake async-iterable). Returns
 * `tooLarge` rather than throwing so the caller answers 413.
 */
export async function readBody(
  req: AsyncIterable<Buffer | Uint8Array>,
  maxBytes: number,
): Promise<{ ok: true; body: string } | { ok: false; tooLarge: true }> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buf.length;
    if (total > maxBytes) return { ok: false, tooLarge: true };
    chunks.push(buf);
  }
  return { ok: true, body: Buffer.concat(chunks).toString("utf8") };
}

/**
 * node:http adapter around handleIngressRequest: reads the body (size-capped),
 * runs the handler, and writes a JSON response. Wire this at POST /ingress in
 * the server (src/index.ts).
 */
export function createIngressHandler(
  deps: CoreDeps,
  options: IngressOptions,
): (req: HttpRequest, res: ServerResponse) => void {
  const maxBytes = options.maxBodyBytes ?? MAX_BODY_BYTES;
  const write = (res: ServerResponse, status: number, body: unknown) => {
    const payload = JSON.stringify(body);
    res.writeHead(status, { "content-type": "application/json" });
    res.end(payload);
  };
  return (req, res) => {
    void (async () => {
      try {
        const read = await readBody(req, maxBytes);
        if (!read.ok) {
          write(res, 413, { error: "request body too large" });
          req.destroy();
          return;
        }
        const result = await handleIngressRequest(
          { method: req.method, headers: req.headers, body: read.body },
          deps,
          options,
        );
        write(res, result.status, result.body);
      } catch (err) {
        // dispatch() catches its own errors and replies, so reaching here means
        // a transport/parse fault. Answer honestly; never leak internals.
        console.error(`[ingress] ${err instanceof Error ? err.message : String(err)}`);
        write(res, 500, { error: "internal error" });
      }
    })();
  };
}

/**
 * Parse ingress token config from the environment. `SWITCHBOARD_INGRESS_TOKENS`
 * is a JSON object mapping raw bearer token -> identity, e.g.
 *   {"s3cr3t":{"subject":"alice","channel":"ops"},"other":{"subject":"bob"}}
 * Absent, empty, or malformed => an empty map => the endpoint is DISABLED
 * (fail-closed). A malformed value is logged (without token material) and
 * treated as no tokens rather than silently opening the endpoint.
 */
export function parseIngressTokens(env: Record<string, string | undefined>): IngressConfig {
  const raw = env.SWITCHBOARD_INGRESS_TOKENS;
  if (!raw || raw.trim() === "") return { tokens: {} };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    console.error("[ingress] SWITCHBOARD_INGRESS_TOKENS is not valid JSON — ingress disabled");
    return { tokens: {} };
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    console.error("[ingress] SWITCHBOARD_INGRESS_TOKENS must be a JSON object — ingress disabled");
    return { tokens: {} };
  }
  const tokens: Record<string, IngressIdentity> = {};
  for (const [token, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (typeof value !== "object" || value === null) continue;
    const v = value as Record<string, unknown>;
    if (typeof v.subject !== "string" || v.subject === "") continue;
    if (v.channel !== undefined && typeof v.channel !== "string") continue;
    if (token === "") continue;
    tokens[token] = { subject: v.subject, channel: v.channel as string | undefined };
  }
  return { tokens };
}
