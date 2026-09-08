import type { IncomingMessage, ServerResponse } from "node:http";
import { resolveActor, type GrantsLookup } from "../core/authz/actor.js";
import type { Actor } from "../core/authz/types.js";
import {
  COMMAND_ID,
  CommandRegistry,
  ERROR_STATUS,
  type Caller,
  type CommandDef,
  type CommandInvoker,
  type InvokeErrorCode,
} from "../core/commandRegistry.js";
import { namedToInput } from "../core/commandSurface.js";
import { isServiceToken, type AccessIdentity } from "./accessAuth.js";
import { MAX_BODY_BYTES, readBody } from "./http.js";

// Generic HTTP adapter for the command registry: `/api/<group>.<verb>` for
// every registered command, with NO
// per-command code. Its only logic is transport: resolve the Caller (identity
// only — the policy table decides, features/authorization.md) from the
// Access identity the gate in index.ts already verified, enforce write safety,
// map the by-name query/body onto the definition's `{ args, options }`
// (`namedToInput` — kebab-case query keys, camelCase JSON keys), pass it to
// `invoke`, and write the JSON it returns.
//
// ONE route predicate. `isCommandPath` is what index.ts gates on, and
// the handler claims ALL of `/api/*`, answering its own 404 so no `/api` spelling
// ever falls through to the `200 ok` health probe. Who may reach it at all is
// the dashboard auth strategy's decision (dashboardAuth.ts), made before this
// handler runs — the `none` strategy's loopback rule included.
//
// Write safety. `effect: "write"` commands are POST-only (405), require
// `content-type: application/json`, and refuse a foreign `Origin` /
// `Sec-Fetch-Site` (403) — same-origin is judged against PUBLIC_BASE_URL when
// set, else the request's Host. No CORS headers are ever emitted, so a browser
// cannot read a cross-site response either. Every response is `no-store`.
// Authorization happens before the body is buffered (readBody with a cap).

export interface CommandHttpOptions {
  /** Grants by actor id (`ConfigStore.grantsFor`) for the `Caller.actor` every
   *  `/api` call carries — `access:<sub>` (a browser session: every group's
   *  read implicitly, plus whatever its `grants` entry adds) or
   *  `access:svc:<common_name>` (exactly its `grants` entry, nothing implicit).
   *  The table is config's; the adapter only names the id. */
  grantsFor: GrantsLookup;
  /** `PUBLIC_BASE_URL`, when set: the origin writes must come from. */
  publicBaseUrl?: string;
  maxBodyBytes?: number;
}

/** Called by index.ts AFTER the Access gate: the identity is the gate's result. */
export type CommandHttpHandler = (req: IncomingMessage, res: ServerResponse, identity: AccessIdentity) => Promise<void>;

const API_ROOT = "/api";

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

/** True for `/api` and everything under `/api/`, in any spelling that
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
 * The ONE caller-id mapping for an Access identity — the `Caller.id` the `/api`
 * audit line prints, and the id `accessActor` gives the same identity: a
 * browser session is `access:<sub>`; a service token is
 * `access:svc:<common_name>` — never a bare `access:` (its `sub` is empty).
 */
export function callerIdFor(identity: AccessIdentity): string {
  return isServiceToken(identity) ? `access:svc:${identity.commonName}` : `access:${identity.sub}`;
}

/**
 * The `Actor` an Access identity resolves to — the ONE resolver for every
 * surface the Access gate fronts: `/api/*` here (through `callerFor`) and the
 * `/runs` pages (index.ts hands it to the live-view handler as `ctx.actor`,
 * features/authorization.md item 1). A browser session is the `user`
 * `access:<sub>`, a service token the `service` `access:svc:<common_name>`,
 * each with the grants config names for that id (`grantsFor`). Nothing here
 * decides what either may do (docs/decisions/0007-authorization-policy-table.md).
 */
export function accessActor(identity: AccessIdentity, grantsFor: GrantsLookup): Actor {
  return isServiceToken(identity)
    ? resolveActor({ surface: "access-service", subjectId: identity.commonName }, grantsFor)
    : resolveActor({ surface: "access-browser", subjectId: identity.sub }, grantsFor);
}

/**
 * A service token is a command-surface credential ONLY: it may reach `/api/*`
 * (where `callerFor` gives it exactly its configured scopes, or none) and
 * nothing else the Access gate fronts — `/runs*` renders live capability tokens
 * and `/residents*` / `/costs*` are people's dashboards. A browser-shaped
 * identity (an Access session, the `token` strategy's actor, the `none`
 * strategy's local operator) is allowed everywhere the gate admits it. index.ts
 * applies this right after the gate; a refusal is a 403.
 */
export function serviceTokenAllowed(pathname: string, identity: AccessIdentity): boolean {
  return !isServiceToken(identity) || isCommandPath(pathname);
}

/** The `/api` Caller for an Access identity: its caller id and the `Actor`
 *  the policy table decides on (`accessActor`). */
export function callerFor(identity: AccessIdentity, opts: Pick<CommandHttpOptions, "grantsFor">): Caller {
  return { kind: "access", id: callerIdFor(identity), actor: accessActor(identity, opts.grantsFor) };
}

function hostOf(url: string | undefined): string | undefined {
  if (!url) return undefined;
  try {
    return new URL(url).host.toLowerCase();
  } catch {
    return undefined;
  }
}

function header(req: IncomingMessage, name: string): string | undefined {
  const v = req.headers[name];
  return Array.isArray(v) ? v[0] : v;
}

/** A write request must come from our own origin. `Sec-Fetch-Site`
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
type TransportCode =
  | "not_found"
  | "method_not_allowed"
  | "unsupported_media_type"
  | "forbidden_origin"
  | "forbidden"
  | "payload_too_large";

export function createCommandHttpHandler(commands: CommandInvoker, opts: CommandHttpOptions): CommandHttpHandler {
  const maxBytes = opts.maxBodyBytes ?? MAX_BODY_BYTES;

  const send = (res: ServerResponse, status: number, body: unknown, extra: Record<string, string> = {}) => {
    res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...extra });
    res.end(JSON.stringify(body));
  };
  const refuse = (
    res: ServerResponse,
    status: number,
    code: TransportCode | InvokeErrorCode,
    error: string,
    extra: Record<string, string> = {},
  ) => send(res, status, { error, code }, extra);

  return async (req, res, identity) => {
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
    // (write safety). `invoke` re-checks in every case; this only spares an
    // unauthorized caller's body from being read.
    const caller = callerFor(identity, opts);
    if (CommandRegistry.refuses(cmd, caller)) {
      refuse(res, ERROR_STATUS.unauthorized, "unauthorized", `${caller.id} is not allowed to run ${cmd.id}`);
      return;
    }

    // Arguments and options are addressed BY NAME in one flat object:
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
