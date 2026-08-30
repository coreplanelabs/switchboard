// The ingress token map, parsed without any Node dependency so BOTH the bot
// (src/channels/http.ts, src/channels/mcp.ts) and the Cloudflare Worker shim
// (deploy/cloudflare/worker.ts, which fires scheduled runs through /ingress)
// read `SWITCHBOARD_INGRESS_TOKENS` with ONE parser. The shape is
//   {"<raw bearer token>": {"subject": "alice", "channel": "ops", "scopes": ["dispatch","runs:read"]}, ...}
// Absent, empty, or malformed => an empty map. Callers treat an empty map as
// "ingress disabled" (fail-closed) — this module never decides that, it only
// parses. Token material is never logged here; the caller may log the reason.

/** The identity a token maps to. `subject` becomes the platform-namespaced user
 *  id (`http:<subject>`); an optional `channel` pins the config scope. */
export interface IngressIdentity {
  subject: string;
  channel?: string;
  /** What the token may do beyond nothing: `dispatch` (POST /ingress) and
   *  command-registry scopes such as `runs:read` / `runs:write`
   *  (features/command-registry.md). Absent in the env → `DEFAULT_INGRESS_SCOPES`;
   *  malformed → the whole entry is skipped, never widened. */
  scopes: string[];
}

export const DEFAULT_INGRESS_SCOPES: readonly string[] = ["dispatch"];

/** `undefined` → the default; an array of non-empty strings → itself (deduped);
 *  anything else → null (the caller skips the entry). */
export function parseScopes(v: unknown): string[] | null {
  if (v === undefined) return [...DEFAULT_INGRESS_SCOPES];
  if (!Array.isArray(v) || v.some((s) => typeof s !== "string" || s === "")) return null;
  return [...new Set(v as string[])];
}

export type IngressTokenMap = Record<string, IngressIdentity>;

export type ParsedIngressTokens =
  | { ok: true; tokens: IngressTokenMap }
  /** `reason` names the shape problem (never the token material). */
  | { ok: false; reason: string; tokens: IngressTokenMap };

/** Parse the raw env value. Entries with an empty token, a non-object value, a
 *  missing/empty `subject`, or a non-string `channel` are skipped; the rest are
 *  kept. `ok: false` only for a value that is not a JSON object at all. */
export function parseIngressTokenMap(raw: string | undefined): ParsedIngressTokens {
  if (!raw || raw.trim() === "") return { ok: true, tokens: {} };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ok: false, reason: "not valid JSON", tokens: {} };
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return { ok: false, reason: "must be a JSON object", tokens: {} };
  }
  const tokens: IngressTokenMap = {};
  for (const [token, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (token === "") continue;
    if (typeof value !== "object" || value === null) continue;
    const v = value as Record<string, unknown>;
    const subject = v.subject;
    const channel = v.channel;
    if (typeof subject !== "string" || subject === "") continue;
    if (channel !== undefined && typeof channel !== "string") continue;
    const scopes = parseScopes(v.scopes);
    if (!scopes) continue;
    tokens[token] = typeof channel === "string" ? { subject, channel, scopes } : { subject, scopes };
  }
  return { ok: true, tokens };
}

/** The raw token that maps to `subject`, or undefined when no entry does (or
 *  more than one does — an ambiguous identity is refused, never guessed). */
export function tokenForSubject(tokens: IngressTokenMap, subject: string): string | undefined {
  const matches = Object.entries(tokens).filter(([, id]) => id.subject === subject);
  return matches.length === 1 ? matches[0][0] : undefined;
}
