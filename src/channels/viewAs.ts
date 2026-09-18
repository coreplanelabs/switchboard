import type { IncomingMessage, ServerResponse } from "node:http";
import type { Actor } from "../core/authz/types.js";
import { MINUTE_MS } from "../core/budgets.js";
import { holdsAll, isViewablePerson, viewingRefusal } from "../core/authz/viewAs.js";
import type { RunView } from "../core/runsService.js";
import { originAllowed } from "./commandHttp.js";
import { readBody } from "./http.js";
import type { ViewablePerson } from "./webSeed.js";

// View-as on the dashboard (record 0053): the cookie that carries the admin's
// choice, the two routes that set and clear it, and the refusal every write
// route outside the registry door answers with. Under /runs because the Access
// application covers that prefix; the paths are route words `parseRunRoute`
// reserves, never run ids.
//
// The cookie is the carrier, not the authority: the gate reads its value onto
// the identity, and `resolveAccessActor` honours it only for a session whose
// own actor holds `all` (a forged or stale cookie narrows nobody else's view,
// it is simply not read). HttpOnly so no script reads it, SameSite=Strict so
// no cross-site request carries it, Path=/ so every gated page sees it, a
// session cookie so it dies with the browser.

export const VIEW_AS_COOKIE = "sb-view-as";
export const VIEW_AS_PATH = "/runs/view-as";
export const VIEW_AS_EXIT_PATH = "/runs/view-as/exit";
/** A `{ person }` body is a few dozen bytes; anything past this is not one. */
const MAX_BODY_BYTES = 1024;

/** The person the `Cookie` header asks to view as, or undefined when it carries none. */
export function viewAsFromCookie(header: string | string[] | undefined): string | undefined {
  const raw = Array.isArray(header) ? header.join("; ") : header;
  if (!raw) return undefined;
  for (const part of raw.split(";")) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() !== VIEW_AS_COOKIE) continue;
    try {
      const value = decodeURIComponent(part.slice(eq + 1).trim());
      if (value !== "") return value;
    } catch {
      // a bad escape is no value; a later part of the same name may still carry one
    }
  }
  return undefined;
}

export function isViewAsPath(pathname: string): boolean {
  return pathname === VIEW_AS_PATH || pathname === VIEW_AS_EXIT_PATH;
}

/** The people a runs page can name for the picker: its rows' Slack requesters, once each, by name. */
export function requestersOf(rows: readonly RunView[]): ViewablePerson[] {
  return peopleOf(rows, []);
}

/** The picker's people: the page's Slack requesters and the installation's known people
 *  (`LiveViewDeps.people` — everyone the grants table names and every requester in run history),
 *  once each, a name kept from whichever source has one, sorted by name. A row's requester is
 *  always offered, so a page never names someone the picker cannot pick. */
export function peopleOf(rows: readonly RunView[], known: readonly ViewablePerson[]): ViewablePerson[] {
  const seen = new Map<string, ViewablePerson>();
  const add = (id: string, name?: string) => {
    if (!isViewablePerson(id)) return;
    const had = seen.get(id);
    if (!had) seen.set(id, { id, ...(name ? { name } : {}) });
    else if (!had.name && name) seen.set(id, { id, name });
  };
  for (const r of rows) if (r.userId) add(r.userId, r.userName);
  for (const p of known) add(p.id, p.name);
  return [...seen.values()].sort((a, b) => (a.name ?? a.id).localeCompare(b.name ?? b.id));
}

export interface KnownPeopleDeps {
  /** The grants table's Slack people (`ConfigStore.grantedPeople`). */
  granted: () => readonly string[];
  /** Every requester the run history holds: the service's list under the admin's own `all`. */
  requesters: () => Promise<readonly RunView[]>;
  /** A person's display name from the directory; undefined when it has none. */
  name: (personId: string) => Promise<string | undefined>;
}

/**
 * The installation's known people for the picker: the grants table's Slack people, named
 * through the directory, and every requester in the run history the service lists. A failing
 * directory leaves an id unnamed; a failing history read leaves only the granted people.
 */
export async function knownPeople(deps: KnownPeopleDeps): Promise<ViewablePerson[]> {
  const rows = await deps.requesters().catch((): RunView[] => []);
  const fromRuns = peopleOf(rows, []);
  const namedIds = new Set(fromRuns.filter((p) => p.name).map((p) => p.id));
  const granted = await Promise.all(
    deps.granted().map(async (id): Promise<ViewablePerson> => {
      if (namedIds.has(id)) return { id };
      const name = await deps.name(id).catch((): undefined => undefined);
      return { id, ...(name ? { name } : {}) };
    }),
  );
  return peopleOf(rows, granted);
}

/** How long the picker's people stand before a paint asks for a refresh: a minute, the same
 *  order as the directory's own caches — a new person appears within it, never mid-paint. */
export const KNOWN_PEOPLE_TTL_MS = MINUTE_MS;

export interface PeopleSource {
  /** The people as last computed — empty before the first refresh lands. Never waits: when the
   *  list is stale it starts one refresh in the background and answers with what it has. */
  current(): readonly ViewablePerson[];
  /** Compute the list now (single-flight: a refresh in flight is shared). Never rejects. */
  refresh(): Promise<void>;
}

/**
 * The people source the index reads from (index.ts wires it and primes it at startup): the
 * known people behind a cache, refreshed in the background once they are older than the TTL.
 * A page paint therefore never waits on the run store or Slack — the reads `knownPeople` makes
 * happen off the request, and a paint that finds the cache stale is served the last list while
 * the refresh runs. A refresh that fails (a throwing `granted`) keeps the last list.
 */
export function peopleSource(deps: KnownPeopleDeps, opts: { ttlMs?: number; now?: () => number } = {}): PeopleSource {
  const ttlMs = opts.ttlMs ?? KNOWN_PEOPLE_TTL_MS;
  const now = opts.now ?? Date.now;
  let people: readonly ViewablePerson[] = [];
  let refreshedAt = Number.NEGATIVE_INFINITY;
  let inFlight: Promise<void> | undefined;
  const refresh = (): Promise<void> => {
    inFlight ??= knownPeople(deps)
      .then((next) => {
        people = next;
        refreshedAt = now();
      })
      .catch(() => undefined)
      .finally(() => {
        inFlight = undefined;
      });
    return inFlight;
  };
  return {
    current() {
      if (now() - refreshedAt >= ttlMs) void refresh();
      return people;
    },
    refresh,
  };
}

const JSON_NO_STORE = { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" };

/** The 403 a write route outside the registry door answers while the viewer views as a person:
 *  the same `{ error, message }` shape `/api/*` gives, the same sentence. Returns true (handled). */
export function refuseWhileViewing(res: ServerResponse, person: ViewablePerson): boolean {
  res.writeHead(403, JSON_NO_STORE);
  res.end(JSON.stringify({ error: "unauthorized", message: viewingRefusal(person) }));
  return true;
}

export interface ViewAsDeps {
  /** Same-origin for the POSTs, judged as commandHttp judges a write (`originAllowed`). */
  publicBaseUrl?: string;
  /** `Secure` on the cookie: on for an https deployment, off for a local http one (the browser
   *  would drop a Secure cookie set over http). */
  secure: boolean;
}

export interface ViewAsContext {
  /** The request's actor as the gate resolved it — the admin's own grants, whatever it views as. */
  actor: Actor;
}

function cookieHeader(value: string, deps: ViewAsDeps, clear: boolean): string {
  const attrs = [
    "Path=/",
    "HttpOnly",
    "SameSite=Strict",
    ...(deps.secure ? ["Secure"] : []),
    ...(clear ? ["Max-Age=0"] : []),
  ];
  return `${VIEW_AS_COOKIE}=${encodeURIComponent(value)}; ${attrs.join("; ")}`;
}

/**
 * `POST /runs/view-as` `{ person }` sets the cookie for a session holding `all` and answers 204;
 * `POST /runs/view-as/exit` clears it, 204. Anyone else is refused before the body is read
 * (403 `unauthorized`), a body that names no Slack person is 400 `invalid_input`, a foreign
 * origin 403, any other method 405. The page navigates after the 204 (the shell's CSP forbids
 * form posts, so the picker and the banner call this from script).
 */
export function createViewAsHandler(
  deps: ViewAsDeps,
): (req: IncomingMessage, res: ServerResponse, ctx: ViewAsContext) => boolean {
  const json = (res: ServerResponse, status: number, body: unknown, extra: Record<string, string> = {}) => {
    res.writeHead(status, { ...JSON_NO_STORE, ...extra });
    res.end(JSON.stringify(body));
  };
  return (req, res, ctx) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (!isViewAsPath(url.pathname)) return false;
    if ((req.method ?? "GET").toUpperCase() !== "POST") {
      json(res, 405, { error: "method_not_allowed" }, { allow: "POST" });
      return true;
    }
    if (!originAllowed(req, { publicBaseUrl: deps.publicBaseUrl })) {
      json(res, 403, { error: "forbidden_origin" });
      req.destroy();
      return true;
    }
    if (!holdsAll(ctx.actor)) {
      json(res, 403, { error: "unauthorized", message: "Only a session holding every grant may view as a person." });
      req.destroy();
      return true;
    }
    if (url.pathname === VIEW_AS_EXIT_PATH) {
      res.writeHead(204, { "set-cookie": cookieHeader("", deps, true), "cache-control": "no-store" });
      res.end();
      return true;
    }
    readBody(req, MAX_BODY_BYTES)
      .then((read) => {
        if (!read.ok) {
          json(res, 413, { error: "invalid_input", message: "body too large" });
          return;
        }
        let person: unknown;
        try {
          person = (JSON.parse(read.body) as { person?: unknown }).person;
        } catch {
          person = undefined;
        }
        if (typeof person !== "string" || !isViewablePerson(person)) {
          json(res, 400, { error: "invalid_input", message: "person must be a Slack person id" });
          return;
        }
        res.writeHead(204, { "set-cookie": cookieHeader(person, deps, false), "cache-control": "no-store" });
        res.end();
      })
      .catch(() => json(res, 400, { error: "invalid_input", message: "body unreadable" }));
    return true;
  };
}
