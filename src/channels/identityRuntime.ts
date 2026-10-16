import { authorize } from "../core/authz/authorize.js";
import type { IdentityNotice } from "../core/identity/linkContract.js";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Actor } from "../core/authz/types.js";
import type { PersonDirectory } from "../core/identity/contract.js";
import type { AccessEvidence, AccessProofProvider, SlackProofProvider } from "../core/identity/humanProof.js";
import { LinkCeremony } from "../core/identity/linkCeremony.js";
import { HOSTED_MCP_PROBE_TIMEOUT_MS } from "../core/budgets.js";
import { LinkBrowser, identityNoticeCsrf, type LinkConsentView } from "./linkBrowser.js";
import { AccessHumanProofAdapter } from "./linkProofAccess.js";
import { SlackOidcProofAdapter } from "./linkProofSlack.js";
import { httpJwksFetcher, type AccessConfig } from "./accessAuth.js";
import type { BrowserIdentityLinkConfig, IdentitySeed } from "./identitySeed.js";
import { wantsSeed, type PageSender } from "./webShell.js";
import { MAX_BODY_BYTES, readBody } from "./http.js";

export const IDENTITY_PATH = "/settings/identities";
const PRIVACY_HEADERS = {
  "cache-control": "no-store",
  "referrer-policy": "no-referrer",
  "content-security-policy": "default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
} as const;
export interface IdentityRuntimeContext {
  actor: Actor;
  evidence: AccessEvidence;
}
export interface IdentityRuntimeOptions {
  config?: BrowserIdentityLinkConfig;
  organization?: string;
  deliverNotice?: (notice: IdentityNotice) => Promise<boolean>;
  directory?: PersonDirectory;
  access?: AccessConfig;
  publicBaseUrl?: string;
  now: () => number;
  page: PageSender;
  readSecret: (name: string) => string | undefined;
  authorize?: (actor: Actor) => boolean | Promise<boolean>;
  fetch?: typeof fetch;
  /** Trusted test/host proof implementations; a request can never select one. */
  providers?: { access: AccessProofProvider; slack: SlackProofProvider };
  onChanged?: () => void;
}
export function isIdentityPath(path: string): boolean {
  return path === IDENTITY_PATH || path.startsWith(`${IDENTITY_PATH}/`);
}

/** Opt-in transport over the existing proof and atomic consent ceremony. */
export function createIdentityRuntime(options: IdentityRuntimeOptions) {
  const config = options.config;
  let unavailable: string | undefined;
  let origin = "";
  let browser: LinkBrowser | undefined;
  let access: AccessProofProvider | undefined;
  let ceremony: LinkCeremony | undefined;
  if (!config) unavailable = "This installation has not configured account verification.";
  else if (!options.organization) unavailable = "Account verification requires a fixed organization.";
  else if (!options.directory) unavailable = "The account verification directory is unavailable.";
  else if (!options.access) unavailable = "Account verification requires ACCESS_TEAM_DOMAIN and ACCESS_AUD.";
  else {
    try {
      const base = new URL(options.publicBaseUrl ?? "");
      if (
        base.protocol !== "https:" ||
        base.username ||
        base.password ||
        base.search ||
        base.hash ||
        !["", "/"].includes(base.pathname)
      )
        throw new Error("invalid public origin");
      origin = base.origin;
      const clientSecret = options.readSecret(config.slackClientSecretEnv);
      if (!clientSecret) unavailable = `Account verification requires ${config.slackClientSecretEnv}.`;
      else {
        access =
          options.providers?.access ??
          new AccessHumanProofAdapter(options.access, { now: options.now, fetchJwks: httpJwksFetcher });
        const policy = {
          tenant: config.slackTeamId,
          audience: config.slackClientId,
          callbackUri: `${origin}${IDENTITY_PATH}/callback`,
        };
        const slack =
          options.providers?.slack ??
          new SlackOidcProofAdapter(
            {
              audience: policy.audience,
              callbackUri: policy.callbackUri,
              teams: [policy.tenant],
              clientSecret: () => clientSecret,
            },
            {
              now: options.now,
              fetch: (url, init) =>
                (options.fetch ?? fetch)(url, {
                  ...init,
                  signal: init.signal ?? AbortSignal.timeout(HOSTED_MCP_PROBE_TIMEOUT_MS),
                }),
            },
          );
        ceremony = new LinkCeremony(
          { directory: options.directory, access, slack, now: options.now, organization: options.organization },
          policy,
        );
        browser = new LinkBrowser({ ceremony, origin, mode: "production", path: IDENTITY_PATH });
      }
    } catch {
      unavailable = "Account verification requires a valid HTTPS PUBLIC_BASE_URL.";
    }
  }
  // Signed account reads and acknowledgments do not depend on Slack's OIDC
  // secret. Absence of the second provider still closes all binding changes.
  if (!browser && options.organization && options.directory && options.access) {
    try {
      const base = new URL(options.publicBaseUrl ?? "");
      if (
        base.protocol !== "https:" ||
        base.username ||
        base.password ||
        base.search ||
        base.hash ||
        !["", "/"].includes(base.pathname)
      )
        throw new Error("invalid public origin");
      origin = base.origin;
      access =
        options.providers?.access ??
        new AccessHumanProofAdapter(options.access, { now: options.now, fetchJwks: httpJwksFetcher });
      ceremony = new LinkCeremony({
        directory: options.directory,
        access,
        now: options.now,
        organization: options.organization,
      });
      browser = new LinkBrowser({ ceremony, origin, mode: "production", path: IDENTITY_PATH });
    } catch {
      /* The original named unavailable reason remains; there is no proof fallback. */
    }
  }
  async function retryNotices() {
    if (
      !options.organization ||
      !options.directory?.pendingNotices ||
      !options.directory.markNoticeDelivered ||
      !options.directory.markNoticeAttempted ||
      !options.deliverNotice
    )
      return { status: "unavailable" as const, delivered: 0 };
    try {
      const pending = await options.directory.pendingNotices(options.organization, 20);
      if (pending.status !== "notices") return { status: "unavailable" as const, delivered: 0 };
      let delivered = 0;
      for (const notice of pending.notices) {
        try {
          if ((await options.directory.markNoticeAttempted(options.organization, notice.id)).status !== "attempted")
            continue;
          if (
            (await options.deliverNotice(notice)) &&
            (await options.directory.markNoticeDelivered(options.organization, notice.id)).status === "delivered"
          )
            delivered++;
        } catch {
          /* The stable addressed row stays pending across replacement. */
        }
      }
      return { status: "ok" as const, delivered };
    } catch {
      return { status: "unavailable" as const, delivered: 0 };
    }
  }
  async function handle(req: IncomingMessage, res: ServerResponse, context?: IdentityRuntimeContext) {
    const url = new URL(req.url ?? "/", origin || "http://localhost");
    const callback = url.pathname === `${IDENTITY_PATH}/callback`;
    const page = (seed: IdentitySeed, status = 200) => {
      if (
        status === 200 &&
        seed.canWrite &&
        !seed.unavailable &&
        seed.view !== null &&
        seed.view.stage !== "unavailable" &&
        seed.view.stage !== "result-expired" &&
        !wantsSeed(req) &&
        req.method === "GET" &&
        url.pathname === IDENTITY_PATH &&
        !url.search &&
        !url.hash &&
        String(req.headers.accept ?? "").includes("text/html")
      )
        // Local form posts need their real Origin. Cross-origin Slack navigation
        // still receives no referrer, and callback responses remain no-referrer.
        res.setHeader("referrer-policy", "same-origin");
      options.page(req, res, status, context?.actor, "Identities", seed);
    };
    const reject = (status: number) => {
      if (callback || (req.method === "POST" && String(req.headers.accept ?? "").includes("text/html"))) {
        res.writeHead(303, { location: IDENTITY_PATH, "cache-control": "no-store", "referrer-policy": "no-referrer" });
        res.end();
      } else {
        res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
        res.end(JSON.stringify({ status: "unavailable" }));
      }
    };
    if (!context || context.actor.kind !== "user") {
      reject(404);
      return;
    }
    if (!browser || !access || !ceremony) {
      if (url.pathname === IDENTITY_PATH && req.method === "GET")
        page({ page: "identities", view: null, canWrite: false, unavailable });
      else reject(503);
      return;
    }
    const proof = await access.verify(context.evidence);
    const canRead =
      !!proof &&
      proof.expiresAt > options.now() &&
      context.actor.id === `access:${proof.identity.subject}` &&
      !!options.organization &&
      authorize(context.actor, "organization:read", { type: "organization", id: options.organization }).allow;
    const canAcknowledge = canRead && !context.actor.viewingAs && ((await options.authorize?.(context.actor)) ?? false);
    const canWrite = canAcknowledge && !unavailable;
    const acknowledgment = url.pathname === `${IDENTITY_PATH}/acknowledge`;
    if ((!canAcknowledge || (!canWrite && !acknowledgment)) && (req.method !== "GET" || callback)) {
      reject(403);
      return;
    }
    if (!canRead || !proof) {
      page(
        {
          page: "identities",
          view: null,
          canWrite: false,
          unavailable: "Account verification requires a current signed-in browser account.",
        },
        403,
      );
      return;
    }
    let input: string | undefined;
    if (req.method !== "GET") {
      const body = await readBody(req, Math.min(MAX_BODY_BYTES, 1024));
      if (!body.ok) {
        reject(400);
        return;
      }
      input = body.body;
    }
    const headers = new Headers();
    for (const [name, value] of Object.entries(req.headers)) if (typeof value === "string") headers.set(name, value);
    const output = await browser.handle(
      new Request(url, { method: req.method ?? "GET", headers, ...(input !== undefined ? { body: input } : {}) }),
      context.evidence,
      async (identity) => {
        const targetId =
          identity.issuer === "https://slack.com" ? `slack:${identity.subject}` : `access:${identity.subject}`;
        return (
          !context.actor.viewingAs &&
          authorize(context.actor, "identity:write", { type: "config-scope", kind: "user", id: targetId }).allow
        );
      },
      { kind: "access", id: context.actor.id, actor: context.actor },
    );
    const cookie = output.headers.get("set-cookie");
    if (cookie) res.setHeader("set-cookie", cookie);
    res.setHeader("referrer-policy", "no-referrer");
    if (
      url.pathname === IDENTITY_PATH &&
      req.method === "GET" &&
      output.headers.get("content-type")?.startsWith("application/json")
    ) {
      const view = (await output.json()) as LinkConsentView;
      const account = await ceremony.accounts(context.evidence);
      const notices = canAcknowledge ? await ceremony.notices(context.evidence) : undefined;
      // The outbox commits with the binding. Failed delivery remains durable;
      // provider callbacks must deduplicate the stable notice ID.
      if (canAcknowledge && options.organization) await retryNotices();
      else if (canAcknowledge && notices?.status === "notices" && options.deliverNotice)
        for (const notice of notices.notices
          .filter((row) => row.identity.issuer === "https://slack.com")
          .slice(0, 10)) {
          try {
            if (await options.deliverNotice(notice)) await ceremony.delivered(context.evidence, notice.id);
          } catch {
            /* Retry on the next verified visit; do not mark a failed send delivered. */
          }
        }
      const pending = canAcknowledge ? await ceremony.notices(context.evidence) : undefined;
      const noticeRequest = new Request(url, {
        headers: { cookie: cookie ? cookie.split(";")[0] : (req.headers.cookie ?? "") },
      });
      const browserNotices =
        pending?.status === "notices"
          ? pending.notices
              .filter((row) => JSON.stringify(row.identity) === JSON.stringify(proof.identity))
              .map((row) => ({
                id: row.id,
                outcome: row.outcome,
                operation: row.operation,
                at: row.at,
                csrf: identityNoticeCsrf(noticeRequest, row.id) ?? "",
              }))
          : [];
      page(
        {
          page: "identities",
          view: unavailable ? null : view,
          canWrite,
          canAcknowledge,
          ...(unavailable ? { unavailable } : {}),
          notices: browserNotices,
          ...(account.status === "accounts" ? { accounts: account.accounts } : {}),
          ...(pending?.status === "notices" ? { pendingNotices: pending.notices.length } : {}),
        },
        output.status,
      );
      return;
    }
    if (["/commit", "/cancel", "/interrupt"].some((action) => url.pathname.endsWith(action)) && output.status === 303)
      options.onChanged?.();
    if (req.method === "POST" && output.status !== 303 && String(req.headers.accept ?? "").includes("text/html")) {
      res.writeHead(303, { location: IDENTITY_PATH, "cache-control": "no-store", "referrer-policy": "no-referrer" });
      res.end();
      return;
    }
    res.writeHead(output.status, Object.fromEntries(output.headers));
    res.end(await output.text());
  }
  const handler = (req: IncomingMessage, res: ServerResponse, context?: IdentityRuntimeContext): boolean => {
    const url = new URL(req.url ?? "/", origin || "http://localhost");
    if (!isIdentityPath(url.pathname)) return false;
    // Set these before any proof, body read or asynchronous provider call.
    // Pages may replace the CSP with the explicit local/Slack form policy.
    for (const [name, value] of Object.entries(PRIVACY_HEADERS)) res.setHeader(name, value);
    void handle(req, res, context).catch(() => {
      if (res.headersSent) {
        res.end();
        return;
      }
      if (url.pathname === `${IDENTITY_PATH}/callback`) {
        res.writeHead(303, { location: IDENTITY_PATH, "cache-control": "no-store", "referrer-policy": "no-referrer" });
        res.end();
        return;
      }
      res.writeHead(503, {
        "content-type": "application/json; charset=utf-8",
        "cache-control": "no-store",
        "referrer-policy": "no-referrer",
      });
      res.end(JSON.stringify({ status: "unavailable" }));
    });
    return true;
  };
  return Object.assign(handler, {
    unavailable,
    retryNotices,
    callbackUri: origin ? `${origin}${IDENTITY_PATH}/callback` : undefined,
  });
}
