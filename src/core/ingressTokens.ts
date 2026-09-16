// The ingress token map, parsed without any Node dependency so BOTH the bot
// (src/channels/http.ts, src/channels/mcp.ts) and the Cloudflare Worker shim
// (deploy/cloudflare/worker.ts, which fires scheduled runs through /ingress)
// read `SWITCHBOARD_INGRESS_TOKENS` with ONE parser. The shape is
//   {"<raw bearer token>": {"subject": "alice", "channel": "ops", "email": "alice@example.com"}, ...}
// A token is a CREDENTIAL, nothing more: what its bearer may do — start a run
// (`dispatch`), read runs, anything else — is the `grants` entry for
// `http:<subject>` / `mcp:<subject>` in config.yaml (docs/reference/specs/authorization.md
// item 9). `email` names the PERSON the credential belongs to (identity, never
// authority: the run is theirs, the grants stay the credential's —
// authorization.md item 15). Absent, empty, or malformed => an empty map.
// Callers treat an empty map as "ingress disabled" (fail-closed) — this module
// never decides that, it only parses. Token material is never logged here; the
// caller may log the reason.

/** The identity a token maps to. `subject` becomes the platform-namespaced
 *  credential id (`http:<subject>`); an optional `channel` names the channel a
 *  dispatch through this token is recorded under (`http:<channel>`) — routing,
 *  not a grant; an optional `email` names the person the credential is bound
 *  to, resolved to their Slack identity by the adapter (`boundRequester`) so
 *  the run is requested by the person and the credential is `authenticatedAs`.
 *  These three are the whole identity: any other field in an entry is ignored,
 *  so nothing in the token map can widen what the grants entry says. */
export interface IngressIdentity {
  subject: string;
  channel?: string;
  email?: string;
}

export type IngressTokenMap = Record<string, IngressIdentity>;

export type ParsedIngressTokens =
  | { ok: true; tokens: IngressTokenMap }
  /** `reason` names the shape problem (never the token material). */
  | { ok: false; reason: string; tokens: IngressTokenMap };

/** Parse the raw env value. Entries with an empty token, a non-object value, a
 *  missing/empty `subject`, a non-string `channel` or a non-string `email` are
 *  skipped; the rest are kept, each reduced to `{ subject, channel?, email? }`
 *  (an `email` without an `@` is dropped from the entry, never the entry).
 *  `ok: false` only for a value that is not a JSON object at all. */
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
    const email = v.email;
    if (typeof subject !== "string" || subject === "") continue;
    if (channel !== undefined && typeof channel !== "string") continue;
    if (email !== undefined && typeof email !== "string") continue;
    tokens[token] = {
      subject,
      ...(typeof channel === "string" ? { channel } : {}),
      ...(typeof email === "string" && email.includes("@") ? { email: email.trim().toLowerCase() } : {}),
    };
  }
  return { ok: true, tokens };
}

/** The raw token that maps to `subject`, or undefined when no entry does (or
 *  more than one does — an ambiguous identity is refused, never guessed). */
export function tokenForSubject(tokens: IngressTokenMap, subject: string): string | undefined {
  const matches = Object.entries(tokens).filter(([, id]) => id.subject === subject);
  return matches.length === 1 ? matches[0][0] : undefined;
}
