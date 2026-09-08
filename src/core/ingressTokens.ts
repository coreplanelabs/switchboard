// The ingress token map, parsed without any Node dependency so BOTH the bot
// (src/channels/http.ts, src/channels/mcp.ts) and the Cloudflare Worker shim
// (deploy/cloudflare/worker.ts, which fires scheduled runs through /ingress)
// read `SWITCHBOARD_INGRESS_TOKENS` with ONE parser. The shape is
//   {"<raw bearer token>": {"subject": "alice", "channel": "ops"}, ...}
// A token is a CREDENTIAL, nothing more: what its bearer may do — start a run
// (`dispatch`), read runs, anything else — is the `grants` entry for
// `http:<subject>` / `mcp:<subject>` in config.yaml (features/authorization.md
// item 9). Absent, empty, or malformed => an empty map. Callers treat an empty
// map as "ingress disabled" (fail-closed) — this module never decides that, it
// only parses. Token material is never logged here; the caller may log the reason.

/** The identity a token maps to. `subject` becomes the platform-namespaced user
 *  id (`http:<subject>`); an optional `channel` names the channel a dispatch
 *  through this token is recorded under (`http:<channel>`) — routing, not a
 *  grant. */
export interface IngressIdentity {
  subject: string;
  channel?: string;
}

/** The field the token map carried before grants: a token's own list of
 *  actions. It grants nothing now; an entry that still has it is kept (the
 *  credential is intact) and the caller is told to remove the key. */
export const RETIRED_TOKEN_FIELD = "scopes";

export type IngressTokenMap = Record<string, IngressIdentity>;

export type ParsedIngressTokens =
  | {
      ok: true;
      tokens: IngressTokenMap;
      /** One line per entry that still carries the retired `scopes` field, naming the subject — never the token. */
      warnings: string[];
    }
  /** `reason` names the shape problem (never the token material). */
  | { ok: false; reason: string; tokens: IngressTokenMap; warnings: string[] };

/** Parse the raw env value. Entries with an empty token, a non-object value, a
 *  missing/empty `subject`, or a non-string `channel` are skipped; the rest are
 *  kept. `ok: false` only for a value that is not a JSON object at all. */
export function parseIngressTokenMap(raw: string | undefined): ParsedIngressTokens {
  if (!raw || raw.trim() === "") return { ok: true, tokens: {}, warnings: [] };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ok: false, reason: "not valid JSON", tokens: {}, warnings: [] };
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return { ok: false, reason: "must be a JSON object", tokens: {}, warnings: [] };
  }
  const tokens: IngressTokenMap = {};
  const warnings: string[] = [];
  for (const [token, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (token === "") continue;
    if (typeof value !== "object" || value === null) continue;
    const v = value as Record<string, unknown>;
    const subject = v.subject;
    const channel = v.channel;
    if (typeof subject !== "string" || subject === "") continue;
    if (channel !== undefined && typeof channel !== "string") continue;
    if (RETIRED_TOKEN_FIELD in v) {
      warnings.push(
        `entry for subject "${subject}" carries \`${RETIRED_TOKEN_FIELD}\`, which grants nothing any more — its rights are the grants entry for http:${subject} / mcp:${subject} in config.yaml; remove the key`,
      );
    }
    tokens[token] = typeof channel === "string" ? { subject, channel } : { subject };
  }
  return { ok: true, tokens, warnings };
}

/** The raw token that maps to `subject`, or undefined when no entry does (or
 *  more than one does — an ambiguous identity is refused, never guessed). */
export function tokenForSubject(tokens: IngressTokenMap, subject: string): string | undefined {
  const matches = Object.entries(tokens).filter(([, id]) => id.subject === subject);
  return matches.length === 1 ? matches[0][0] : undefined;
}
