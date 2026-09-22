// Authentication for typed failures crossing from the model proxy to a run's
// pi bridge (docs/reference/specs/model-proxy.md item 12b). Provider stream
// content shares the same wire shape as a proxy-generated error, so shape is
// not authority: only an envelope carrying a marker signed by this bot process
// may choose its own ProviderFailure cause.

import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { PROVIDER_FAILURE_CAUSES, type ProviderFailureCause, type ProviderSchemaRejection } from "../provider.js";

export const PROXY_PROVIDER_FAILURE_AUTH_FIELD = "_switchboard_proxy_auth";

const AUTH_VERSION = "v1";
const AUTH_KEY = randomBytes(32);
const NONCE_BYTES = 16;

export interface ProxyProviderFailureEnvelope {
  type: "provider_failure";
  cause: ProviderFailureCause;
  message: string;
  schemaRejection?: ProviderSchemaRejection;
}

export type AuthenticatedProxyProviderFailureEnvelope = ProxyProviderFailureEnvelope & {
  [PROXY_PROVIDER_FAILURE_AUTH_FIELD]: string;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isCause = (value: unknown): value is ProviderFailureCause =>
  typeof value === "string" && (PROVIDER_FAILURE_CAUSES as readonly string[]).includes(value);

function payload(envelope: ProxyProviderFailureEnvelope, nonce: string): string {
  return JSON.stringify([
    AUTH_VERSION,
    nonce,
    envelope.type,
    envelope.cause,
    envelope.message,
    envelope.schemaRejection ?? null,
  ]);
}

function signature(envelope: ProxyProviderFailureEnvelope, nonce: string): Buffer {
  return createHmac("sha256", AUTH_KEY).update(payload(envelope, nonce)).digest();
}

/** Called only by the proxy after it has classified and rendered a provider
 * failure. The random nonce makes every marker response-specific; the HMAC
 * keeps provider-controlled stream content from minting one. */
export function authenticateProxyProviderFailure(
  envelope: ProxyProviderFailureEnvelope,
): AuthenticatedProxyProviderFailureEnvelope {
  const nonce = randomBytes(NONCE_BYTES).toString("base64url");
  const mac = signature(envelope, nonce).toString("base64url");
  return { ...envelope, [PROXY_PROVIDER_FAILURE_AUTH_FIELD]: `${AUTH_VERSION}.${nonce}.${mac}` };
}

function parseBody(value: unknown): unknown {
  if (typeof value !== "string") return value;
  const text = value.trim();
  for (let at = text.indexOf("{"); at >= 0; at = text.indexOf("{", at + 1)) {
    try {
      return JSON.parse(text.slice(at)) as unknown;
    } catch {
      // SDKs prefix a status and label before the JSON body. Keep looking when
      // a prefix itself contained a brace rather than trusting malformed text.
    }
  }
  return undefined;
}

function candidates(value: unknown, into: Record<string, unknown>[] = []): Record<string, unknown>[] {
  if (Array.isArray(value)) {
    for (const item of value) candidates(item, into);
    return into;
  }
  const row = isRecord(value) ? value : undefined;
  if (!row) return into;
  if (row.type === "provider_failure") into.push(row);
  for (const item of Object.values(row)) candidates(item, into);
  return into;
}

/** True only for one exact proxy-signed typed envelope. Requiring one candidate
 * prevents an attacker from placing an unmarked cause before a marked nested
 * envelope and having the generic classifier select the unmarked one. */
export function proxyProviderFailureIsAuthenticated(value: unknown): boolean {
  const found = candidates(parseBody(value));
  if (found.length !== 1) return false;
  const row = found[0];
  if (row.type !== "provider_failure" || !isCause(row.cause) || typeof row.message !== "string") return false;
  const rejection = isRecord(row.schemaRejection) ? row.schemaRejection : undefined;
  if (
    row.schemaRejection !== undefined &&
    (typeof rejection?.tool !== "string" ||
      rejection.tool.length === 0 ||
      typeof rejection.keyword !== "string" ||
      rejection.keyword.length === 0)
  )
    return false;
  const schemaRejection =
    rejection !== undefined ? { tool: rejection.tool as string, keyword: rejection.keyword as string } : undefined;
  const marker = row[PROXY_PROVIDER_FAILURE_AUTH_FIELD];
  if (typeof marker !== "string") return false;
  const parts = marker.split(".");
  if (parts.length !== 3 || parts[0] !== AUTH_VERSION) return false;
  const [, nonce, encodedMac] = parts;
  if (!/^[A-Za-z0-9_-]{22}$/.test(nonce) || !/^[A-Za-z0-9_-]{43}$/.test(encodedMac)) return false;
  let offered: Buffer;
  try {
    offered = Buffer.from(encodedMac, "base64url");
  } catch {
    return false;
  }
  const expected = signature(
    {
      type: "provider_failure",
      cause: row.cause,
      message: row.message,
      ...(schemaRejection !== undefined ? { schemaRejection } : {}),
    },
    nonce,
  );
  return offered.length === expected.length && timingSafeEqual(offered, expected);
}
