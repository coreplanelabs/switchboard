import type { Clock } from "../../core/trace/types.js";
import { LINEAR_TIMING } from "../../core/budgets.js";
import {
  object,
  required,
  type LinearActivity,
  type LinearApi,
  type LinearContent,
  type LinearSession,
} from "./api.js";
import type { LinearDelivery, LinearInbox } from "./inbox.js";
import { boundedBody } from "./webhook.js";

export const LINEAR_BRIDGE_PATH = "/internal/linear";

export interface LinearTransport {
  baseUrl: string;
  token: string;
  fetch: typeof fetch;
}

async function call<T>(transport: LinearTransport, body: Record<string, unknown>): Promise<T> {
  const url = new URL(LINEAR_BRIDGE_PATH, transport.baseUrl);
  if (
    url.protocol !== "https:" &&
    !(url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))
  )
    throw new Error("linear_bridge_requires_https");
  let response: Response;
  try {
    response = await transport.fetch(url, {
      method: "POST",
      redirect: "error",
      signal: AbortSignal.timeout(LINEAR_TIMING.apiTimeoutMs),
      headers: { "content-type": "application/json", authorization: `Bearer ${transport.token}` },
      body: JSON.stringify(body),
    });
  } catch {
    throw new Error("linear_bridge_unavailable");
  }
  if (!response.ok) throw new Error("linear_bridge_unavailable");
  return ((await response.json()) as { result: T }).result;
}

/** The bot holds this bridge bearer, never Linear's access/refresh token. */
export class RemoteLinearApi implements LinearApi {
  constructor(
    private readonly transport: LinearTransport,
    private readonly organizationId: string,
  ) {}
  session(sessionId: string): Promise<LinearSession> {
    return call(this.transport, { op: "session", organizationId: this.organizationId, sessionId });
  }
  activities(sessionId: string): Promise<LinearActivity[]> {
    return call(this.transport, { op: "activities", organizationId: this.organizationId, sessionId });
  }
  activity(sessionId: string, content: LinearContent, options?: { ephemeral?: boolean; id?: string }): Promise<void> {
    return call(this.transport, { op: "activity", organizationId: this.organizationId, sessionId, content, options });
  }
  link(sessionId: string, link: { url: string; label: string }): Promise<void> {
    return call(this.transport, { op: "link", organizationId: this.organizationId, sessionId, link });
  }
}

/** Delivery times and leases are chosen by the durable host, not a consumer's clock. */
export class RemoteLinearInbox {
  constructor(private readonly transport: LinearTransport) {}
  async claim(): Promise<LinearDelivery | undefined> {
    return (await call<LinearDelivery | null>(this.transport, { op: "claim" })) ?? undefined;
  }
  bind(key: string, lease: string, runId: string): Promise<boolean> {
    return call(this.transport, { op: "bind", key, lease, runId });
  }
  renew(key: string, lease: string): Promise<boolean> {
    return call(this.transport, { op: "renew", key, lease });
  }
  retry(key: string, lease: string): Promise<boolean> {
    return call(this.transport, { op: "retry", key, lease });
  }
  complete(key: string, lease: string): Promise<boolean> {
    return call(this.transport, { op: "complete", key, lease });
  }
}

const answer = (status: number, value: unknown) =>
  Response.json(value, { status, headers: { "cache-control": "no-store" } });

async function authenticates(request: Request, token: string): Promise<boolean> {
  const supplied = request.headers.get("authorization");
  if (!supplied || supplied.length > 1024) return false;
  // Compare fixed-size digests, with no token-dependent early return.
  const [left, right] = await Promise.all(
    [supplied, `Bearer ${token}`].map(
      async (value) => new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value))),
    ),
  );
  let different = 0;
  for (let i = 0; i < left!.length; i++) different |= left![i]! ^ right![i]!;
  return different === 0;
}

function contentOf(value: unknown): LinearContent {
  const content = object(value);
  if (content.type === "action")
    return {
      type: "action",
      action: required(content.action),
      parameter: required(content.parameter),
      ...(typeof content.result === "string" ? { result: content.result } : {}),
    };
  if (
    content.type === "thought" ||
    content.type === "response" ||
    content.type === "error" ||
    content.type === "elicitation"
  )
    return { type: content.type, body: required(content.body) };
  throw new Error("invalid_content");
}

/** A fixed RPC vocabulary: no arbitrary GraphQL, URL or credential-read route.
 *  The bearer authenticates the bot transport; request authorization still
 *  belongs to dispatch's resolved human actor and policy table. */
export async function handleLinearBridge(
  request: Request,
  deps: {
    token?: string;
    inbox: LinearInbox;
    clock: Clock;
    api(organizationId: string): Promise<LinearApi>;
  },
): Promise<Response> {
  if (!deps.token) return answer(503, { error: "linear_bridge_disabled" });
  if (!(await authenticates(request, deps.token))) return answer(401, { error: "unauthorized" });
  if (request.method !== "POST") return answer(405, { error: "method_not_allowed" });
  let body: Record<string, unknown>;
  try {
    const bytes = await boundedBody(request);
    if (!bytes) return answer(413, { error: "too_large" });
    body = object(JSON.parse(new TextDecoder().decode(bytes)));
  } catch {
    return answer(400, { error: "invalid_body" });
  }
  const op = body.op;
  if (
    !["claim", "bind", "renew", "retry", "complete", "session", "activities", "activity", "link"].includes(String(op))
  )
    return answer(400, { error: "unknown_operation" });
  try {
    let result: unknown;
    const now = deps.clock();
    if (op === "claim") result = await deps.inbox.claim(now, LINEAR_TIMING.deliveryLeaseMs, crypto.randomUUID());
    else if (op === "bind")
      result = await deps.inbox.bind(required(body.key), required(body.lease), required(body.runId));
    else if (op === "renew")
      result = await deps.inbox.renew(required(body.key), required(body.lease), now + LINEAR_TIMING.deliveryLeaseMs);
    else if (op === "retry")
      result = await deps.inbox.retry(required(body.key), required(body.lease), now + LINEAR_TIMING.progressMs);
    else if (op === "complete") result = await deps.inbox.complete(required(body.key), required(body.lease), now);
    else {
      const api = await deps.api(required(body.organizationId)),
        id = required(body.sessionId);
      // Every operation proves ownership and current access again. A guessed
      // session id cannot make the bridge read a different app's conversation.
      const session = await api.session(id);
      if (op === "session") result = session;
      else if (session.dismissedAt) return answer(409, { error: "session_dismissed" });
      else if (op === "activities") result = await api.activities(id);
      else if (op === "activity") {
        const options = object(body.options);
        result = await api.activity(id, contentOf(body.content), {
          ...(typeof options.ephemeral === "boolean" ? { ephemeral: options.ephemeral } : {}),
          ...(typeof options.id === "string" ? { id: options.id } : {}),
        });
      } else if (op === "link") {
        const link = object(body.link),
          url = new URL(required(link.url));
        if (url.protocol !== "https:" || url.username || url.password) return answer(400, { error: "invalid_link" });
        result = await api.link(id, { url: url.href, label: required(link.label) });
      }
    }
    return answer(200, { result: result ?? null });
  } catch {
    return answer(503, { error: "linear_bridge_unavailable" });
  }
}
