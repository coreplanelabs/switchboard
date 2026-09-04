import type { IncomingMessage, ServerResponse } from "node:http";
import { resolveActor, type GrantsLookup } from "../core/authz/actor.js";
import { COMMAND_ID, CommandRegistry, ERROR_STATUS, type Caller, type CommandDef, type CommandInvoker, type InvokeErrorCode } from "../core/commandRegistry.js";
import { namedToInput } from "../core/commandSurface.js";
import { isServiceToken, type AccessIdentity } from "./accessAuth.js";
import { MAX_BODY_BYTES, readBody } from "./http.js";

// Generic HTTP adapter for the command registry (#157 U7 — R7/R9/R10, KTD13/
// KTD15): `/api/<group>.<verb>` for every registered command, with NO
// per-command code. Its only logic is transport: resolve the Caller (identity
// only — the policy table decides, features/authorization.md) from the
// Access identity the gate in index.ts already verified, enforce write safety,
// map the by-name query/body onto the definition's `{ args, options }`
// (`namedToInput` — kebab-case query keys, camelCase JSON keys), pass it to
// `invoke`, and write the JSON it returns.
//
// KTD13 — ONE route predicate. `isCommandPath` is what index.ts gates on, and
// the handler claims ALL of `/api/*`, answering its own 404 so no `/api` spelling
// ever falls through to the `200 ok` health probe. Under the local-dev Access
// bypass, `/api/*` is served only to a loopback caller on a localhost deployment.
//
// KTD15 — write safety. `effect: "write"` commands are POST-only (405), require
// `content-type: application/json`, and refuse a foreign `Origin` /
// `Sec-Fetch-Site` (403) — same-origin is judged against PUBLIC_BASE_URL when
// set, else the request's Host. No CORS headers are ever emitted, so a browser
// cannot read a cross-site response either. Every response is `no-store`.
// Authorization happens before the body is buffered (readBody with a cap).

export interface CommandHttpOptions {
  /** Grants by actor id (`ConfigStore.grantsFor`) for the `Caller.actor` every
   *  `/api` call carries — `access:<sub>` (a browser session: every group's
   *  read implicitly, writes when `permissions.operators` lists it) or
   *  `access:svc:<common_name>` (exactly its `permissions.serviceTokens`
   *  scopes). The translation is config's; the adapter only names the id. */
  grantsFor: GrantsLookup;
  /** True when the Access gate is admitting requests WITHOUT a JWT
   *  (`ACCESS_DEV_BYPASS` with no Access config). Enables the loopback rule. */
  devBypassActive: boolean;
  /** `PUBLIC_BASE_URL`, when set: the origin writes must come from, and the
   *  host that decides whether the deployment counts as localhost. */
  publicBaseUrl?: string;
  maxBodyBytes?: number;
}

/** Called by index.ts AFTER the Access gate: the identity is the gate's result. */
export type CommandHttpHandler = (req: IncomingMessage, res: ServerResponse, identity: AccessIdentity) => Promise<void>;

const API_ROOT = "/api";
const LOOPBACK = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);
const LOCALHOST_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);

/** The ONE loopback rule for the dev bypass: true for the v4/v6/mapped loopback
 *  addresses node reports on `socket.remoteAddress` (`/api/*` here, the `/runs`
 *  history reads in index.ts). */
export function isLoopbackAddress(addr: string | undefined): boolean {
  return addr !== undefined && LOOPBACK.has(addr);
}

/**
 * Normalize a raw request path the way an attacker might spell it: percent-
 * decoded (once; undecodable → as-is), runs of `/` collapsed, lower-cased for
 * the prefix test only. `//api/x`, `/api/x/`, `/%61pi/x` all normalize under
 * `/api`. Used by the gate predicate AND the handler's own lookup, so what the
 * gate claims is exactly what the handler answers.
 */
function normalizePath(pathname: string): string {
  let decoded = pathname;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    // keep the raw spelling; it still gets the prefix test
  }
  return decoded.replace(/\/{2,}/g, "/");
}

/** KTD13: true for `/api` and everything under `/api/`, in any spelling that
 *  could reach the handler. index.ts gates on THIS — never a second prefix list. */
export function isCommandPath(pathname: string): boolean {
  const p = normalizePath(pathname).toLowerCase();
  return p === API_ROOT || p === `${API_ROOT}/` || p.startsWith(`${API_ROOT}/`);
}

/** `/api/runs.list` → `runs.list`; anything that is not exactly one well-formed
 *  command id under `/api/` → undefined (the handler answers 404). */
function commandIdFromPath(pathname: string): string | undefined {
  const p = normalizePath(pathname);
  if (!p.startsWith(`${API_ROOT}/`)) return undefined;
  const rest = p.slice(API_ROOT.length + 1);
  return COMMAND_ID.test(rest) ? rest : undefined;
}

/**
 * The ONE caller-id mapping for an Access identity, shared by the `/api`
 * Caller and the `/runs` history-read audit line: a browser session is
 * `access:<sub>`; a service token is `access:svc:<common_name>` — never a bare
 * `access:` (its `sub` is empty).
 */
export function callerIdFor(identity: AccessIdentity): string {
  return isServiceToken(identity) ? `access:svc:${identity.commonName}` : `access:${identity.sub}`;
}

/**
 * A service token is a command-surface credential ONLY: it may reach `/api/*`
 * (where `callerFor` gives it exactly its configured scopes, or none) and
 * nothing else the Access gate fronts — `/runs*` renders live capability tokens
 * and `/residents*` / `/costs*` are people's dashboards. A browser session (and
 * the dev-bypass identity) is allowed everywhere the gate admits it. index.ts
 * applies this right after the gate; a refusal is a 403.
 */
export function serviceTokenAllowed(pathname: string, identity: AccessIdentity): boolean {
  return !isServiceToken(identity) || isCommandPath(pathname);
}

/**
 * R9: the Caller an Access identity resolves to — the same identity as an
 * `Actor` the policy table decides on: a browser session is the `user`
 * `access:<sub>`, a service token the `service` `access:svc:<common_name>`,
 * each with the grants config names for that id (`opts.grantsFor`). Nothing
 * here decides what either may do (KTD3).
 */
export function callerFor(identity: AccessIdentity, opts: Pick<CommandHttpOptions, "grantsFor">): Caller {
  const id = callerIdFor(identity);
  if (isServiceToken(identity)) return { kind: "access", id, actor: resolveActor({ surface: "access-service", subjectId: identity.commonName }, opts.grantsFor) };
  return { kind: "access", id, actor: resolveActor({ surface: "access-browser", subjectId: identity.sub }, opts.grantsFor) };
}

function hostOf(url: string | undefined): string | undefined {
  if (!url) return undefined;
  try {
    return new URL(url).host.toLowerCase();
  } catch {
    return undefined;
  }
}

/**
 * The ONE localhost rule for the dev bypass (`/api/*` here, the `/runs` history
 * reads in index.ts): unset `PUBLIC_BASE_URL` → a localhost deployment;
 * otherwise its host must be `localhost`, `127.0.0.1` or `[::1]` (any port). A
 * malformed value (no scheme, not a URL) is NOT localhost and never throws —
 * boot must not crash on a typo, it must fail closed.
 */
export function isLocalhostBase(publicBaseUrl: string | undefined): boolean {
  if (!publicBaseUrl) return true;
  const hostname = (() => {
    try {
      return new URL(publicBaseUrl).hostname.toLowerCase();
    } catch {
      return undefined;
    }
  })();
  return hostname !== undefined && LOCALHOST_HOSTS.has(hostname);
}

function header(req: IncomingMessage, name: string): string | undefined {
  const v = req.headers[name];
  return Array.isArray(v) ? v[0] : v;
}

/** KTD15: a write request must come from our own origin. `Sec-Fetch-Site`
 *  (browsers) must be same-origin/none when present; `Origin` (browsers, and
 *  anything that sends one) must equal PUBLIC_BASE_URL's full origin (scheme,
 *  host and port — a same-host deployment on another port is foreign), or the
 *  Host header's host when no base URL is configured (the scheme is unknown
 *  there). No `Origin` at all (curl, service tokens) is fine. */
function originAllowed(req: IncomingMessage, opts: CommandHttpOptions): boolean {
  const site = header(req, "sec-fetch-site");
  if (site !== undefined && site !== "same-origin" && site !== "none") return false;
  const origin = header(req, "origin");
  if (origin === undefined) return true;
  const expected = originOf(opts.publicBaseUrl);
  if (expected !== undefined) return originOf(origin) === expected; // scheme + host + port, not host alone
  const host = header(req, "host")?.toLowerCase();
  const actual = hostOf(origin);
  return host !== undefined && actual !== undefined && actual === host;
}

/** The full origin (scheme://host[:port], lower-cased) of a URL, or undefined
 *  when it does not parse. */
function originOf(url: string | undefined): string | undefined {
  if (!url) return undefined;
  try {
    const o = new URL(url).origin;
    return o === "null" ? undefined : o.toLowerCase();
  } catch {
    return undefined;
  }
}

function isJsonContentType(req: IncomingMessage): boolean {
  const ct = header(req, "content-type");
  return ct !== undefined && ct.split(";")[0].trim().toLowerCase() === "application/json";
}

/** Transport-level refusals that have no registry code. */
type TransportCode = "not_found" | "method_not_allowed" | "unsupported_media_type" | "forbidden_origin" | "forbidden" | "payload_too_large";

export function createCommandHttpHandler(commands: CommandInvoker, opts: CommandHttpOptions): CommandHttpHandler {
  const maxBytes = opts.maxBodyBytes ?? MAX_BODY_BYTES;

  const send = (res: ServerResponse, status: number, body: unknown, extra: Record<string, string> = {}) => {
    res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...extra });
    res.end(JSON.stringify(body));
  };
  const refuse = (res: ServerResponse, status: number, code: TransportCode | InvokeErrorCode, error: string, extra: Record<string, string> = {}) =>
    send(res, status, { error, code }, extra);

  return async (req, res, identity) => {
    // KTD13 dev-bypass rule: a bypassed gate serves /api/* only on loopback, on a
    // localhost deployment. Checked before anything else so nothing about the
    // catalogue leaks to a remote caller of a misconfigured dev box.
    if (opts.devBypassActive) {
      if (!isLoopbackAddress(req.socket?.remoteAddress) || !isLocalhostBase(opts.publicBaseUrl)) {
        refuse(res, 403, "forbidden", "dev bypass serves /api only to loopback on a localhost deployment");
        return;
      }
    }

    const url = new URL(req.url ?? "/", "http://placeholder.invalid");
    const id = commandIdFromPath(url.pathname);
    const cmd: CommandDef<unknown> | undefined = id === undefined ? undefined : commands.get(id);
    if (!cmd || !CommandRegistry.exposedTo(cmd, "access")) {
      refuse(res, 404, "not_found", "unknown command");
      return;
    }

    const method = (req.method ?? "GET").toUpperCase();
    const allow = cmd.effect === "write" ? "POST" : "GET, POST";
    if (method !== "POST" && (cmd.effect === "write" || method !== "GET")) {
      refuse(res, 405, "method_not_allowed", `${cmd.id} accepts ${allow}`, { allow });
      return;
    }
    if (method === "POST" && !isJsonContentType(req)) {
      refuse(res, 415, "unsupported_media_type", "content-type must be application/json");
      return;
    }
    if (cmd.effect === "write" && !originAllowed(req, opts)) {
      refuse(res, 403, "forbidden_origin", "cross-origin writes are refused");
      return;
    }

    // Refuse BEFORE buffering where the table can decide without the input
    // (KTD15). `invoke` re-checks in every case; this only spares an
    // unauthorized caller's body from being read.
    const caller = callerFor(identity, opts);
    if (CommandRegistry.refuses(cmd, caller)) {
      refuse(res, ERROR_STATUS.unauthorized, "unauthorized", `${caller.id} is not allowed to run ${cmd.id}`);
      return;
    }

    // Arguments and options are addressed BY NAME in one flat object (KTD21):
    // a GET query string in kebab-case (`?id=…&after-seq=3`, coerced by the
    // schemas), a POST body in camelCase JSON (`{"id":…,"afterSeq":3}`). The
    // split into positional `args` and `options` is the definition's, not ours.
    let named: Record<string, unknown>;
    let keys: "kebab" | "camel";
    if (method === "GET") {
      named = Object.fromEntries(url.searchParams);
      keys = "kebab";
    } else {
      const read = await readBody(req, maxBytes);
      if (!read.ok) {
        refuse(res, 413, "payload_too_large", "request body too large");
        req.destroy();
        return;
      }
      let body: unknown;
      try {
        body = read.body.trim() === "" ? {} : JSON.parse(read.body);
      } catch {
        refuse(res, ERROR_STATUS.invalid_input, "invalid_input", "body must be a JSON object");
        return;
      }
      if (typeof body !== "object" || body === null || Array.isArray(body)) {
        refuse(res, ERROR_STATUS.invalid_input, "invalid_input", "body must be a JSON object");
        return;
      }
      named = body as Record<string, unknown>;
      keys = "camel";
    }
    const input = namedToInput(cmd, named, keys);
    if ("error" in input) {
      refuse(res, ERROR_STATUS.invalid_input, "invalid_input", input.error);
      return;
    }

    const result = await commands.invoke(cmd.id, input, caller);
    if (!result.ok) {
      refuse(res, result.status, result.error, result.message);
      return;
    }
    send(res, 200, result.value);
  };
}
