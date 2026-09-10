import { timingSafeEqual } from "node:crypto";
import type { IncomingHttpHeaders, IncomingMessage as HttpRequest, ServerResponse } from "node:http";
import { dispatch as realDispatch, type CoreDeps, type DispatchOptions } from "../core/dispatcher.js";
import { startRequestRoot } from "../core/requestTrace.js";
import { systemClock } from "../core/trace/clock.js";
import { parseIngressTokenMap, type IngressIdentity } from "../core/ingressTokens.js";
import { hasAction } from "../core/authz/authorize.js";
import type { GrantsLookup } from "../core/authz/actor.js";
import type { Grants } from "../core/authz/types.js";
import type { ChannelIO, HistoryItem, IncomingMessage, RunReceipt, StatusHandle, StatusUpdate } from "../core/types.js";

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

/** The identity a token maps to (`subject` → `userId` "http:<subject>"; an
 *  optional `channel` pins the config scope regardless of the request body).
 *  Defined in src/core/ingressTokens.ts (node-free, shared with the Worker
 *  shim); re-exported here so the MCP adapter and tests keep one import site. */
export type { IngressIdentity };

/** Ingress auth config: raw bearer token -> identity. An empty map means the
 *  endpoint is DISABLED (fail-closed) — never open. */
export interface IngressConfig {
  tokens: Record<string, IngressIdentity>;
}

/** The dispatch signature; injectable so tests never hit real providers. */
export type DispatchFn = (deps: CoreDeps, msg: IncomingMessage, io: ChannelIO, opts?: DispatchOptions) => Promise<void>;

export interface IngressOptions {
  auth: IngressConfig;
  /** Defaults to the real core dispatch(); overridden in tests. */
  dispatch?: DispatchFn;
  /** Max body size in bytes (node wrapper enforces at read time). */
  maxBodyBytes?: number;
  /** Base URL for the run's live page in async acknowledgements (from
   *  PUBLIC_BASE_URL). Absent => `runUrl` is a path-only `/runs/<id>`. */
  publicBaseUrl?: string;
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
  /** `"async": true` => acknowledge with 202 + run id; run continues in background. */
  async: boolean;
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
 *  no-op, history() replays what the body supplied, runFinished() keeps the run
 *  receipt for the response body. */
export class HttpIO implements ChannelIO {
  private replies: string[] = [];
  private receipt: RunReceipt | undefined;
  private resolveStarted!: (started: { id: string }) => void;
  /** Resolves when the core has created a run in the registry (runStarted).
   *  The async ingress path races this against dispatch completion to answer
   *  202 with the run id; never resolves for a run-less request (config reply). */
  readonly started: Promise<{ id: string }> = new Promise((resolve) => {
    this.resolveStarted = resolve;
  });
  constructor(private readonly priorTurns: HistoryItem[] = []) {}

  runStarted(started: { id: string }): void {
    this.resolveStarted(started);
  }

  async reply(text: string): Promise<void> {
    this.replies.push(text);
  }

  runFinished(receipt: RunReceipt): void {
    this.receipt = receipt;
  }

  /** The run this request produced (id + terminal status), if the core made one. */
  run(): RunReceipt | undefined {
    return this.receipt;
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
  if (obj.async !== undefined && typeof obj.async !== "boolean") {
    return { error: "`async` must be a boolean" };
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
      async: obj.async === true,
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
 *   3b. token lacks `dispatch` -> 403 forbidden (code unauthorized)
 *   4. invalid/bad JSON body   -> 400
 *   5. authed + valid          -> dispatch(), reply collected -> 200
 * Steps 1-3b are header-only (`authorizeRequest` + `requireDispatch`), so the node wrapper runs them
 * BEFORE reading the body — an unauthorized/wrong-method/disabled caller never
 * buffers a body. Body-size enforcement (413) is streamed in `readBody`.
 */

/** Header-only authorization gate: method (405), fail-closed disabled check
 *  (503), and bearer auth (401). Decidable without the body, so the transport
 *  wrapper can reject before buffering. Returns the rejection response, or the
 *  resolved identity to proceed with. */
export function authorizeRequest(
  method: string | undefined,
  headers: IncomingHttpHeaders,
  options: IngressOptions,
): IngressResponse | { identity: IngressIdentity } {
  if ((method ?? "GET").toUpperCase() !== "POST") {
    return { status: 405, body: { error: "method not allowed; POST only" } };
  }
  // Fail-closed: with no tokens configured the endpoint is disabled, never open.
  if (Object.keys(options.auth.tokens).length === 0) {
    return { status: 503, body: { error: "disabled", detail: "no ingress tokens configured" } };
  }
  const identity = authenticate(headers, options.auth);
  if (!identity) {
    return { status: 401, body: { error: "unauthorized" } };
  }
  return { identity };
}

/** The action that lets an actor start an agent run through this endpoint (and
 *  the MCP `dispatch` tool): a grant on `http:<subject>` / `mcp:<subject>` in
 *  config.yaml (`actions: [dispatch, …]`, or `all`). A token with no entry
 *  holds nothing and dispatches nothing (authorization.md item 9). */
export const DISPATCH_ACTION = "dispatch";

/** True when these grants let their holder start an agent run. */
export function hasDispatch(grants: Grants): boolean {
  return hasAction(grants.actions, DISPATCH_ACTION);
}

/** Header-only, after `authorizeRequest`: a token whose `http:<subject>` actor
 *  holds no `dispatch` grant is refused (403) before its body is read and before
 *  `dispatch()` is ever reached — fail-closed, the same `code:"unauthorized"`
 *  the registry uses. */
export function requireDispatch(identity: IngressIdentity, grantsFor: GrantsLookup): IngressResponse | null {
  if (hasDispatch(grantsFor(`${PLATFORM}:${identity.subject}`))) return null;
  return { status: 403, body: { error: "forbidden", code: "unauthorized" } };
}

/** Post-auth handling: validate the (already-read) body and dispatch. */
async function handleAuthorized(
  identity: IngressIdentity,
  body: string,
  deps: CoreDeps,
  options: IngressOptions,
): Promise<IngressResponse> {
  const parsed = parseBody(body);
  if ("error" in parsed) {
    return { status: 400, body: { error: parsed.error } };
  }
  // The request's root (docs/reference/specs/tracing.md): started once the caller's
  // identity is established and the body parsed; `dispatch()` ends it.
  const receivedAt = systemClock();
  const trace = startRequestRoot(deps, { channel: "http", receivedAt });
  const msg: IncomingMessage = { ...toIncomingMessage(identity, parsed.body), receivedAt };
  const io = new HttpIO(parsed.body.history);
  const dispatchFn = options.dispatch ?? realDispatch;
  if (parsed.body.async) {
    // Async mode (`"async": true`): same validation and authorization as the
    // sync path (both already happened above), but the caller gets a 202 the
    // moment the core has CREATED the run — the run continues to completion in
    // the background and its record lands in run history as usual (the reply
    // text goes to the run record, not to any HTTP response). The dispatch
    // promise is started (not awaited), which increments the dispatcher's
    // activeRuns counter on its first line — so the shutdown drain awaits
    // async runs exactly like synchronous ones. Errors are the dispatcher's
    // own (it catches and records); the catch here is a belt against a
    // transport-level throw escaping as an unhandled rejection.
    const done = dispatchFn(deps, msg, io, { trace }).catch((err) => {
      console.error(`[ingress] async dispatch: ${err instanceof Error ? err.message : String(err)}`);
    });
    // Race run creation against completion: a request the core answers WITHOUT
    // a run (a config reply, a refused command) finishes dispatch with no
    // runStarted — fall back to the synchronous response shape so the caller
    // still gets the reply text rather than hanging.
    const started = await Promise.race([io.started, done.then(() => undefined)]);
    if (!started) {
      const run = io.run();
      return { status: 200, body: { reply: io.collected(), ...(run ? { run } : {}) } };
    }
    const base = options.publicBaseUrl?.replace(/\/+$/, "") ?? "";
    return {
      status: 202,
      body: { runId: started.id, runUrl: `${base}/runs/${started.id}`, threadKey: msg.threadKey },
    };
  }
  await dispatchFn(deps, msg, io, { trace });
  // `run` is present only when the core created a run for this request (agent
  // runs, inline command runs); a config reply has none. Id + status only —
  // never the view token.
  const run = io.run();
  return { status: 200, body: { reply: io.collected(), ...(run ? { run } : {}) } };
}

export async function handleIngressRequest(
  req: IngressRequest,
  deps: CoreDeps,
  options: IngressOptions,
): Promise<IngressResponse> {
  const gate = authorizeRequest(req.method, req.headers, options);
  if ("status" in gate) return gate;
  const scopeRefusal = requireDispatch(gate.identity, (id) => deps.config.grantsFor(id));
  if (scopeRefusal) return scopeRefusal;
  return handleAuthorized(gate.identity, req.body, deps, options);
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
        // Authorize from headers BEFORE reading the body: a wrong-method /
        // disabled / unauthorized caller is rejected without ever buffering a
        // body it has no right to send (pre-auth DoS surface — review follow-up).
        const gate = authorizeRequest(req.method, req.headers, options);
        if ("status" in gate) {
          write(res, gate.status, gate.body);
          req.destroy();
          return;
        }
        const scopeRefusal = requireDispatch(gate.identity, (id) => deps.config.grantsFor(id));
        if (scopeRefusal) {
          write(res, scopeRefusal.status, scopeRefusal.body);
          req.destroy();
          return;
        }
        const read = await readBody(req, maxBytes);
        if (!read.ok) {
          write(res, 413, { error: "request body too large" });
          req.destroy();
          return;
        }
        const result = await handleAuthorized(gate.identity, read.body, deps, options);
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
 *   {"s3cr3t":{"subject":"alice","channel":"ops"},
 *    "ci-bot":{"subject":"ci"}}
 * Each entry: `subject` (required, non-empty) and `channel` (optional: the
 * channel a dispatch through this token is recorded under). A token is a
 * credential and nothing more — what its bearer may do is the `grants` entry
 * for `http:<subject>` / `mcp:<subject>` in config.yaml. Absent, empty, or
 * malformed => an empty map => the endpoint is DISABLED (fail-closed). A
 * malformed value is logged (without token material) and treated as no tokens
 * rather than silently opening the endpoint; any field of an entry other than
 * `subject` and `channel` is ignored.
 */
export function parseIngressTokens(env: Record<string, string | undefined>): IngressConfig {
  // One parser for the bot and the Worker shim (src/core/ingressTokens.ts).
  const parsed = parseIngressTokenMap(env.SWITCHBOARD_INGRESS_TOKENS);
  if (!parsed.ok) console.error(`[ingress] SWITCHBOARD_INGRESS_TOKENS is ${parsed.reason} — ingress disabled`);
  return { tokens: parsed.tokens };
}
