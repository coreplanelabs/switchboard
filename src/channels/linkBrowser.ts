import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { ExternalIdentity } from "../core/identity/contract.js";
import type { AccessEvidence } from "../core/identity/humanProof.js";
import type { LinkBrowserSession, LinkCeremony } from "../core/identity/linkCeremony.js";
import type { LinkResult } from "../core/identity/linkContract.js";

/** Safe rendering contract, deliberately separate from intent/audit schemas.
 * Exact verified identifiers are labels, never client-selected person targets. */
export type LinkConsentView =
  | { stage: "start"; csrf: string }
  | {
      stage: "pending" | "exchanging" | "awaiting-consent";
      revision: number;
      expiresAt: number;
      access: ExternalIdentity & { audience: string };
      slack: ExternalIdentity | null;
      csrf: string;
      cancelCsrf: string;
      interruptCsrf?: string;
    }
  | {
      stage: "committed" | "cancelled" | "expired" | "failed" | "unavailable" | "result-expired";
      restartCsrf?: string;
    };

const PATH = "/account-link";
const COOKIE = "__Host-sb-link";
const secretPattern = "[A-Za-z0-9_-]{43}";
const sessionPattern = new RegExp(
  `^(link:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\\.(${secretPattern})$`,
);
const seedPattern = new RegExp(`^seed:(${secretPattern})$`);
const headers = {
  "Cache-Control": "no-store",
  "Referrer-Policy": "no-referrer",
  "Content-Security-Policy": "default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
  "X-Content-Type-Options": "nosniff",
};
function cookieValue(request: Request): string | null {
  const matches = (request.headers.get("cookie") ?? "")
    .split(";")
    .map((s) => s.trim())
    .filter((s) => s.startsWith(`${COOKIE}=`));
  if (matches.length !== 1) return null;
  const value = matches[0].slice(COOKIE.length + 1);
  return seedPattern.test(value) || sessionPattern.test(value) ? value : null;
}
function session(value: string | null): LinkBrowserSession | null {
  const match = value?.match(sessionPattern);
  return match ? { id: match[1], browser: match[2] } : null;
}
function setCookie(value: string): string {
  // Lax is intentional: the provider returns through a top-level cross-site GET.
  // No Domain, persistent expiry, JS access, or query/body alternative.
  return `${COOKIE}=${value}; Path=/; Secure; HttpOnly; SameSite=Lax`;
}
function csrf(value: string, action: string, revision = ""): string {
  return createHmac("sha256", value).update(`link-form:${action}:${revision}`).digest("hex");
}
function equalToken(actual: string | null, expected: string): boolean {
  return !!actual && /^[0-9a-f]{64}$/.test(actual) && timingSafeEqual(Buffer.from(actual), Buffer.from(expected));
}
function terminal(result: LinkResult, value: string): LinkConsentView {
  return {
    stage:
      result.status === "committed" ||
      result.status === "cancelled" ||
      result.status === "expired" ||
      result.status === "unavailable"
        ? result.status
        : "failed",
    ...(["cancelled", "expired", "failed"].includes(result.status) ? { restartCsrf: csrf(value, "restart") } : {}),
  };
}

/** Disabled entry point. No server/router imports this adapter. Even explicit
 * fixture mode is confined to one HTTPS loopback origin; activation requires a
 * later code/release gate, not an environment flag or a successful ceremony.
 * Evidence is supplied by a trusted ingress/test harness, never parsed from the
 * form. There are intentionally no logger, cache, event or raw-error callbacks. */
export class LinkBrowser {
  constructor(private readonly deps: { ceremony: LinkCeremony; origin: string; mode?: "local-fixture" }) {}

  private response(status: number, body: LinkConsentView | null = null, extra: Record<string, string> = {}): Response {
    return new Response(body ? JSON.stringify(body) : null, {
      status,
      headers: { ...headers, ...(body ? { "Content-Type": "application/json" } : {}), ...extra },
    });
  }
  private redirect(): Response {
    return this.response(303, null, { Location: `${this.deps.origin}${PATH}` });
  }
  private async view(value: string, evidence: AccessEvidence): Promise<Response> {
    const bound = session(value);
    if (!bound) return this.response(200, { stage: "start", csrf: csrf(value, "begin") });
    let result = await this.deps.ceremony.inspect(bound, evidence);
    if (result.status === "already_claimed") {
      result = await this.deps.ceremony.read(bound, evidence);
      if (result.status === "expired") return this.response(200, { stage: "result-expired" });
    }
    if (result.status !== "context")
      return this.response(
        result.status === "not_found" || result.status === "invalid" ? 403 : 200,
        terminal(result, value),
      );
    const i = result.intent;
    const revision = String(i.revision);
    return this.response(200, {
      stage: i.state,
      revision: i.revision,
      expiresAt: i.expiresAt,
      access: {
        issuer: i.owner.identity.issuer,
        tenant: null,
        subject: i.owner.identity.subject,
        audience: i.owner.audience,
      },
      slack: i.slack
        ? { issuer: i.slack.identity.issuer, tenant: i.slack.identity.tenant, subject: i.slack.identity.subject }
        : null,
      csrf: csrf(value, "commit", revision),
      cancelCsrf: csrf(value, "cancel", revision),
      ...(i.state === "exchanging" ? { interruptCsrf: csrf(value, "interrupt", revision) } : {}),
    });
  }
  async handle(request: Request, evidence: AccessEvidence): Promise<Response> {
    let callback = false;
    try {
      const origin = new URL(this.deps.origin);
      const url = new URL(request.url);
      if (
        this.deps.mode !== "local-fixture" ||
        origin.protocol !== "https:" ||
        !["localhost", "127.0.0.1", "[::1]"].includes(origin.hostname) ||
        origin.origin !== this.deps.origin ||
        url.origin !== origin.origin
      )
        return this.response(404);
      callback = url.pathname === `${PATH}/callback`;
      const value = cookieValue(request);
      const bound = session(value);
      if (callback) {
        if (bound)
          await this.deps.ceremony.callback({
            session: bound,
            evidence,
            method: request.method,
            callbackUri: `${url.origin}${url.pathname}`,
            query: url.searchParams,
          });
        // No response body, provider error, raw query, or callback URL is rendered.
        return this.redirect();
      }
      if (url.search || url.hash) return this.response(400);
      if (request.method === "GET" && url.pathname === PATH) {
        if (value) return await this.view(value, evidence);
        const fresh = `seed:${randomBytes(32).toString("base64url")}`;
        return this.response(200, { stage: "start", csrf: csrf(fresh, "begin") }, { "Set-Cookie": setCookie(fresh) });
      }
      const action = url.pathname.slice(PATH.length + 1);
      if (
        !url.pathname.startsWith(`${PATH}/`) ||
        !["begin", "commit", "cancel", "interrupt", "restart"].includes(action)
      )
        return this.response(404);
      if (request.method !== "POST") return this.response(405);
      if (
        !value ||
        request.headers.get("origin") !== origin.origin ||
        request.headers.get("sec-fetch-site") !== "same-origin" ||
        request.headers.get("content-type") !== "application/x-www-form-urlencoded"
      )
        return this.response(403);
      const text = await request.text();
      if (text.length > 1024) return this.response(400);
      const form = new URLSearchParams(text);
      const revision = form.get("revision") ?? "";
      if (!equalToken(form.get("csrf"), csrf(value, action, revision))) return this.response(403);
      const fields =
        action === "begin" || action === "restart"
          ? ["csrf"]
          : action === "commit"
            ? ["csrf", "revision", "consent"]
            : ["csrf", "revision"];
      if (
        [...form.keys()].length !== fields.length ||
        fields.some((f) => form.getAll(f).length !== 1) ||
        [...form.keys()].some((f) => !fields.includes(f))
      )
        return this.response(400);
      if (action === "begin") {
        // An already-bound browser cannot silently replace its current intent.
        // Initiation rate/outstanding-intent limits remain a deployment gate.
        if (bound) return this.response(409);
        const result = await this.deps.ceremony.begin(evidence);
        return result.status === "started"
          ? this.response(303, null, {
              Location: result.authorizationUrl,
              "Set-Cookie": setCookie(`${result.session.id}.${result.session.browser}`),
            })
          : this.response(403);
      }
      if (action === "restart") {
        if (!bound) return this.response(409);
        const result = await this.deps.ceremony.inspect(bound, evidence);
        if (result.status === "not_found" || result.status === "invalid") return this.response(403);
        if (result.status !== "cancelled" && result.status !== "expired" && result.status !== "failed")
          return this.response(409);
        const fresh = `seed:${randomBytes(32).toString("base64url")}`;
        return this.response(303, null, {
          Location: `${this.deps.origin}${PATH}`,
          "Set-Cookie": setCookie(fresh),
        });
      }
      if (!bound || !/^[1-9]\d*$/.test(revision) || !Number.isSafeInteger(Number(revision))) return this.response(400);
      if (action === "commit" && form.get("consent") !== "yes") return this.response(400);
      const result =
        action === "commit"
          ? await this.deps.ceremony.commit(bound, evidence, Number(revision), true)
          : action === "cancel"
            ? await this.deps.ceremony.cancel(bound, evidence, Number(revision))
            : await this.deps.ceremony.interrupt(bound, evidence);
      if (
        result.status === "committed" ||
        (action === "cancel" && result.status === "cancelled") ||
        (action === "interrupt" && result.status === "failed")
      )
        return this.redirect();
      return this.response(
        result.status === "invalid" || result.status === "not_found" ? 403 : 409,
        terminal(result, value),
      );
    } catch {
      // Never let an exception carrying a JWT/code/query reach the outer logger.
      return callback ? this.redirect() : this.response(503, { stage: "unavailable" });
    }
  }
}
