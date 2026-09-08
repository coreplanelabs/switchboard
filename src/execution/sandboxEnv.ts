// The env map a per-thread sandbox request carries (docs/reference/specs/execution.md
// item 5): ONE reader, shared by the sandbox Worker and its tests. Deliberately
// free of node: imports so wrangler can bundle it into the Worker, like
// bashTimeout.ts, shellQuote.ts and sandboxErrors.ts.
//
// Why the body and not headers: Workers Logs record every invocation's request
// HEADERS and redact them by a name heuristic — a header named like a token
// (`x-env-gh_token`) shows as REDACTED, but any other env name
// (`x-env-PROBE_VAR: hello`) is logged in clear. Request bodies are not
// recorded. So the executor sends the map as `env` in the JSON body on every
// route and the Worker reads it from there — the ONLY channel. Request headers
// are never a credential channel.

/** A shell identifier: what an env NAME must be after upper-casing. Same rule
 *  as the resident Worker's `ENV_NAME_RE`; anything else is dropped, never
 *  interpolated. */
export const ENV_NAME_PATTERN = /^[A-Z_][A-Z0-9_]*$/;

/** The validated env map for one request, read from `body.env` alone (an
 *  object of string values). Names are upper-cased and must match
 *  `ENV_NAME_PATTERN`; non-string values and an `env` that is not a plain
 *  object are dropped. Request headers are never read — Workers Logs record
 *  them (see above). Never throws — a malformed request yields `{}`. */
export function envFromRequest(req: { body: unknown }): Record<string, string> {
  const out: Record<string, string> = {};
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
