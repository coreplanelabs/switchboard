import type { ConfigStore } from "../config.js";
import { sanitizeResidentBody } from "../execution/residentText.js";
import { tracedFetch } from "./trace/tracedFetch.js";
import type { Span } from "./trace/types.js";

// The resident Worker's admin plane, as the bot sees it (U8): the client for
// the `/onboard`, `/offboard`, `/reconfigure`, `/rebuild`, `/residents` routes
// (bearer = RESIDENT_ADMIN_TOKEN), its config-driven construction, and the two
// validators every repo surface shares — `parseSlug` (owner/name → lowercase
// slug) and `validRef` (the resident's strict branch-ref pattern). The commands
// that call it live in src/core/commands/repo.ts; the registry (command table
// included) is writable ONLY through these admin routes, and the bot never
// caches membership — `repo list` reads the live registry every time.

export interface ResidentAdminResponse {
  status: number;
  data: Record<string, unknown>;
}

/** Admin-scope client for the resident Worker (deploy/cloudflare-resident/).
 *  Injectable (tests, `CoreCommandWiring.residentAdmin`); the default is fetch
 *  with the RESIDENT_ADMIN_TOKEN bearer. */
export interface ResidentAdminClient {
  onboard(body: Record<string, unknown>): Promise<ResidentAdminResponse>;
  offboard(resource: string, dryRun: boolean): Promise<ResidentAdminResponse>;
  reconfigure(body: Record<string, unknown>): Promise<ResidentAdminResponse>;
  rebuild(resource: string, dryRun: boolean): Promise<ResidentAdminResponse>;
  residents(): Promise<ResidentAdminResponse>;
  /** One resident's `{ state, reason, inFlight }` (`GET /status`; 404 when not
   *  onboarded) — what the onboard/rebuild follow-up polls. */
  status(resource: string): Promise<ResidentAdminResponse>;
  /** The same client bound to one span: every call the view makes is an
   *  `http.client` child of it (features/tracing.md item 24). Optional so a
   *  test double stays a plain object; a command uses a client without the
   *  view as is. */
  withSpan?(span: Span): ResidentAdminClient;
}

/** Why there is no resident admin plane, when the config names no resident Worker. */
export const RESIDENTS_OFF_MESSAGE =
  "Resident repo environments aren't configured — set `execution.resident.baseUrl` in config.yaml.";

/** The admin client of a process without residents (Fowler's Special Case,
 *  routing-and-config item 16): every route answers 503 with the reason there
 *  is no fleet, so a view or a command that reaches it renders that reason
 *  instead of branching on a missing client. The reason is the config's —
 *  no resident Worker, or one whose admin bearer is unset. */
export class NullResidentAdminClient implements ResidentAdminClient {
  constructor(readonly reason: string = RESIDENTS_OFF_MESSAGE) {}
  private answer(): Promise<ResidentAdminResponse> {
    return Promise.resolve({ status: 503, data: { error: this.reason } });
  }
  onboard(_body: Record<string, unknown>): Promise<ResidentAdminResponse> {
    return this.answer();
  }
  offboard(_resource: string, _dryRun: boolean): Promise<ResidentAdminResponse> {
    return this.answer();
  }
  reconfigure(_body: Record<string, unknown>): Promise<ResidentAdminResponse> {
    return this.answer();
  }
  rebuild(_resource: string, _dryRun: boolean): Promise<ResidentAdminResponse> {
    return this.answer();
  }
  residents(): Promise<ResidentAdminResponse> {
    return this.answer();
  }
  status(_resource: string): Promise<ResidentAdminResponse> {
    return this.answer();
  }
  withSpan(_span: Span): ResidentAdminClient {
    return this;
  }
}

/** The admin routes, as the span names them: the path literal, never a query. */
type AdminRoute = "/onboard" | "/offboard" | "/reconfigure" | "/rebuild" | "/residents" | "/status";

export function makeResidentAdminClient(baseUrl: string, token: string): ResidentAdminClient {
  // One closure per parent: the unbound client, and the view `withSpan` makes
  // of it — the only way to a bound client, so no caller can mint one that
  // stays bound for the process's life.
  const clientFor = (parent: Span | undefined): ResidentAdminClient => {
    // `route` is what the span carries; `path` is what the request hits (the
    // status route adds its query, which never reaches a span).
    const call = async (
      route: AdminRoute,
      method: "GET" | "POST",
      body?: Record<string, unknown>,
      path: string = route,
    ): Promise<ResidentAdminResponse> => {
      let res: Response;
      try {
        res = await tracedFetch(
          parent,
          `${baseUrl.replace(/\/$/, "")}${path}`,
          {
            method,
            headers: {
              authorization: `Bearer ${token}`,
              ...(body ? { "content-type": "application/json" } : {}),
            },
            ...(body ? { body: JSON.stringify(body) } : {}),
          },
          { route },
        );
      } catch (err) {
        throw new Error(
          `resident admin ${route} request failed (${err instanceof Error ? err.message : String(err)}). ` +
            "The operation may still have run in the resident; check `repo list` before re-running it.",
          { cause: err },
        );
      }
      // Item 62: these bodies reach Slack replies (`repo list`, `repo rebuild`).
      const data = sanitizeResidentBody((await res.json().catch(() => ({}))) as Record<string, unknown>);
      return { status: res.status, data };
    };
    return {
      onboard: (body) => call("/onboard", "POST", body),
      offboard: (resource, dryRun) => call("/offboard", "POST", { resource, ...(dryRun ? { dryRun: true } : {}) }),
      reconfigure: (body) => call("/reconfigure", "POST", body),
      rebuild: (resource, dryRun) => call("/rebuild", "POST", { resource, ...(dryRun ? { dryRun: true } : {}) }),
      residents: () => call("/residents", "GET"),
      status: (resource) => call("/status", "GET", undefined, `/status?resource=${encodeURIComponent(resource)}`),
      withSpan: (span) => clientFor(span),
    };
  };
  return clientFor(undefined);
}

/** The admin client the config names, or the operator-facing reason there is
 *  none: no `execution.resident.baseUrl`, or its bearer env var unset. */
export function residentAdminFromConfig(
  config: ConfigStore,
  env: Record<string, string | undefined> = process.env,
): ResidentAdminClient | { unavailable: string } {
  const resident = config.config.execution?.resident;
  if (!resident?.baseUrl) {
    return {
      unavailable: "Resident repo environments aren't configured — set `execution.resident.baseUrl` in config.yaml.",
    };
  }
  const tokenEnv = resident.adminTokenEnv ?? "RESIDENT_ADMIN_TOKEN";
  const token = env[tokenEnv];
  if (!token) return { unavailable: `Repo management needs the resident admin bearer — \`${tokenEnv}\` is not set.` };
  return makeResidentAdminClient(resident.baseUrl, token);
}

// ---- validators -----------------------------------------------------------------

// Mirrors the resident's REPO_ID_RE (case-tolerant here; the slug is
// lowercased before it becomes a resource id).
const SLUG_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?\/[A-Za-z0-9](?:[A-Za-z0-9._-]{0,98}[A-Za-z0-9])?$/;
// Mirrors the resident's strict branch-ref pattern (U4).
const REF_RE = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/;

/** "owner/name" (optionally ".git") → lowercase slug, or undefined. */
export function parseSlug(token: string): string | undefined {
  const cleaned = token.replace(/\.git$/i, "");
  return SLUG_RE.test(cleaned) ? cleaned.toLowerCase() : undefined;
}

/** Validated ref or undefined — the resident's strict pattern. A ref that
 *  fails this NEVER reaches any backend (KTD8). */
export function validRef(candidate: string): string | undefined {
  if (!REF_RE.test(candidate)) return undefined;
  if (candidate.includes("..") || candidate.includes("@{") || candidate.endsWith(".lock")) return undefined;
  return candidate;
}

/** The resident service's resource id for a repo slug (KTD1: "<type>:<id>"). */
export function repoResourceId(slug: string): string {
  return `repo:${slug}`;
}
