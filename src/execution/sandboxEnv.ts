// The env map a per-thread sandbox request carries (features/execution.md
// item 5): ONE reader, shared by the sandbox Worker and its tests. Deliberately
// free of node: imports so wrangler can bundle it into the Worker, like
// bashTimeout.ts, shellQuote.ts and sandboxErrors.ts.
//
// Why the body and not headers (2026-09-07, the #447 receipt): Workers Logs
// record every invocation's request HEADERS and redact them by a name
// heuristic — `x-env-gh_token` showed as REDACTED, but the receipt probe's
// `x-env-PROBE_VAR: hello-from-env-option` was logged in clear. Request bodies
// are not recorded. So the executor sends the map as `env` in the JSON body on
// every route, and the Worker reads it from there. The `x-env-*` header path is
// read as a FALLBACK for one release — a bot deployed after the Worker still
// works — and retires with the next release.

/** A shell identifier: what an env NAME must be after upper-casing. Same rule
 *  as the resident Worker's `ENV_NAME_RE`; anything else is dropped, never
 *  interpolated. */
export const ENV_NAME_PATTERN = /^[A-Z_][A-Z0-9_]*$/;

const HEADER_PREFIX = "x-env-";

/** The validated env map for one request: `body.env` (an object of string
 *  values) first, `x-env-<NAME>` headers as the fallback; when both name a
 *  key the body wins. Names are upper-cased and must match
 *  `ENV_NAME_PATTERN`; non-string values and an `env` that is not a plain
 *  object are dropped. Never throws — a malformed request yields `{}`. */
export function envFromRequest(req: { body: unknown; headers: Iterable<[string, string]> }): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of req.headers) {
    if (name.toLowerCase().startsWith(HEADER_PREFIX)) put(out, name.slice(HEADER_PREFIX.length), value);
  }
  const env = isPlainObject(req.body) ? req.body.env : undefined;
  if (isPlainObject(env)) {
    for (const [name, value] of Object.entries(env)) put(out, name, value);
  }
  return out;
}

function put(out: Record<string, string>, rawName: string, value: unknown): void {
  if (typeof value !== "string") return;
  const name = rawName.toUpperCase();
  if (!ENV_NAME_PATTERN.test(name)) return;
  out[name] = value;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
