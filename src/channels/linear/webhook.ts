import type { Clock } from "../../core/trace/types.js";
import { LINEAR_TIMING } from "../../core/budgets.js";

export const LINEAR_WEBHOOK_PATH = "/webhooks/linear";
const MAX_BYTES = 1024 * 1024;
const MAX_SKEW_MS = LINEAR_TIMING.webhookSkewMs;
const TYPES = new Set(["AgentSessionEvent", "OAuthApp", "PermissionChange", "AppUserNotification"]);

export interface LinearWebhookEvent {
  /** Derived from signed data; a retry cannot change this by changing a header. */
  key: string;
  receivedAt: number;
  payload: Record<string, unknown> & { type: string; action: string; organizationId: string };
}

export interface LinearWebhookDeps {
  secret?: string;
  /** The application's UUID, distinct from its public OAuth client id. */
  applicationId: string;
  organizationId?: string;
  clock: Clock;
  /** Persist-if-absent, atomically. False means the delivery is already recorded. */
  accept(event: LinearWebhookEvent): Promise<boolean>;
}

const answer = (status: number, outcome: string) => Response.json({ outcome }, { status });
const record = (value: unknown): Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
const id = (value: unknown): value is string => typeof value === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(value);

/** Cap actual streamed bytes, regardless of whether Content-Length is present or truthful. */
export async function boundedBody(request: Request): Promise<Uint8Array | undefined> {
  const reader = request.body?.getReader();
  if (!reader) return new Uint8Array();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > MAX_BYTES) {
        await reader.cancel();
        return undefined;
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

async function eventKey(payload: LinearWebhookEvent["payload"]): Promise<string | undefined> {
  if (payload.type === "AgentSessionEvent") {
    const sessionId = record(payload.agentSession).id;
    if (!id(sessionId)) return undefined;
    if (payload.action === "created") return `${payload.organizationId}:${sessionId}:created`;
    const activityId = record(payload.agentActivity).id;
    if (payload.action === "prompted" && id(activityId))
      return `${payload.organizationId}:${sessionId}:prompted:${activityId}`;
    return undefined;
  }
  // The delivery timestamp may change on a retry. The remainder is signed
  // event data; webhookId identifies the subscription, not a unique event.
  const { webhookTimestamp: _, ...stable } = payload;
  const bytes = new TextEncoder().encode(JSON.stringify(stable));
  const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  const digest = Array.from(hash, (b) => b.toString(16).padStart(2, "0")).join("");
  return `${payload.organizationId}:${payload.type}:${digest}`;
}

export async function handleLinearWebhook(request: Request, deps: LinearWebhookDeps): Promise<Response> {
  if (request.method !== "POST") return answer(405, "method_not_allowed");
  if (!deps.secret || !deps.applicationId) return answer(503, "linear_disabled");
  const signature = request.headers.get("linear-signature");
  if (!signature || !/^[a-fA-F0-9]{64}$/.test(signature)) return answer(401, "invalid_signature");
  const receivedAt = deps.clock();
  try {
    const body = await boundedBody(request);
    if (!body) return answer(413, "too_large");
    const key = await crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode(deps.secret),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["verify"],
    );
    const signatureBytes = Uint8Array.from(signature.match(/../g)!, (part) => parseInt(part, 16));
    if (!(await crypto.subtle.verify("HMAC", key, signatureBytes, body as Uint8Array<ArrayBuffer>)))
      return answer(401, "invalid_signature");
    let decoded: unknown;
    try {
      decoded = JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(body));
    } catch {
      return answer(400, "invalid_payload");
    }
    const payload = record(decoded);
    if (
      typeof payload.webhookTimestamp !== "number" ||
      !Number.isFinite(payload.webhookTimestamp) ||
      Math.abs(receivedAt - payload.webhookTimestamp) > MAX_SKEW_MS
    )
      return answer(401, "expired_delivery");
    if (typeof payload.type !== "string" || typeof payload.action !== "string" || !id(payload.organizationId))
      return answer(400, "invalid_payload");
    if (
      payload.oauthClientId !== deps.applicationId ||
      (deps.organizationId && payload.organizationId !== deps.organizationId)
    )
      return answer(403, "wrong_installation");
    if (!TYPES.has(payload.type)) return answer(200, "ignored");
    const typed = payload as LinearWebhookEvent["payload"];
    const eventId = await eventKey(typed);
    if (!eventId) return answer(400, "invalid_payload");
    const created = await deps.accept({ key: eventId, receivedAt, payload: typed });
    // Linear requires HTTP 200; another 2xx can still trigger redelivery.
    return answer(200, created ? "accepted" : "duplicate");
  } catch {
    // A non-2xx asks Linear to redeliver. The signed event is never acknowledged
    // until durable storage accepted it, and errors cannot echo its contents.
    return answer(503, "intake_unavailable");
  }
}
