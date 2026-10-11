import type { IncomingMessage, ServerResponse } from "node:http";
import type { Actor } from "../core/authz/types.js";
import type { PersonDirectory } from "../core/identity/contract.js";
import type { AccessEvidence, AccessProofProvider, SlackProofProvider } from "../core/identity/humanProof.js";
import { LinkCeremony } from "../core/identity/linkCeremony.js";
import { HOSTED_MCP_PROBE_TIMEOUT_MS } from "../core/budgets.js";
import { LinkBrowser, type LinkConsentView } from "./linkBrowser.js";
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
  if (!config) unavailable = "This installation has not configured account verification.";
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
        const ceremony = new LinkCeremony({ directory: options.directory, access, slack, now: options.now }, policy);
        browser = new LinkBrowser({ ceremony, origin, mode: "production", path: IDENTITY_PATH });
      }
    } catch {
      unavailable = "Account verification requires a valid HTTPS PUBLIC_BASE_URL.";
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
    if (!browser || !access) {
      if (url.pathname === IDENTITY_PATH && req.method === "GET")
        page({ page: "identities", view: null, canWrite: false, unavailable });
      else reject(503);
      return;
    }
    const proof = await access.verify(context.evidence);
    const canWrite =
      !!proof &&
      context.actor.id === `access:${proof.identity.subject}` &&
      !context.actor.viewingAs &&
      ((await options.authorize?.(context.actor)) ?? false);
    if (!canWrite && (req.method !== "GET" || callback)) {
      reject(403);
      return;
    }
    if (!proof || context.actor.id !== `access:${proof.identity.subject}`) {
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
      page({ page: "identities", view, canWrite }, output.status);
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
    callbackUri: origin ? `${origin}${IDENTITY_PATH}/callback` : undefined,
  });
}
