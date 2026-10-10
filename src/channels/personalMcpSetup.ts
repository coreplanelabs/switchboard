import type { IncomingMessage, ServerResponse } from "node:http";
import type { AccessIdentity } from "./accessAuth.js";
import { hasAction } from "../core/authz/authorize.js";
import type { GrantsLookup } from "../core/authz/actor.js";
import { PERSONAL_TOKEN_DIGEST, personalSubject } from "../core/personalToken.js";
import type { PersonLookup } from "./requester.js";
import type { PersonalTokenStore } from "../mcp/personalTokens.js";
import { readBody } from "./http.js";
import { FORM_PAGE_CSP, WEB_HTML_HEADERS } from "./webShell.js";
import { systemClock } from "../core/trace/clock.js";

export const PERSONAL_MCP_SETUP_PATH = "/settings/connect";
const HEADERS = { ...WEB_HTML_HEADERS, "content-security-policy": FORM_PAGE_CSP, "referrer-policy": "no-referrer" };

export function createPersonalMcpSetupHandler(deps: {
  store: PersonalTokenStore;
  grantsFor: GrantsLookup;
  publicOrigin?: string;
  personByEmail?: PersonLookup;
}): (req: IncomingMessage, res: ServerResponse, identity: AccessIdentity) => boolean {
  return (req, res, identity) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (url.pathname !== PERSONAL_MCP_SETUP_PATH) return false;
    void handle(req, res, identity, deps, url).catch(() =>
      page(
        res,
        503,
        "Connection unavailable",
        "<p>The token store is unavailable. Connection could not be completed.</p>",
      ),
    );
    return true;
  };
}

async function handle(
  req: IncomingMessage,
  res: ServerResponse,
  identity: AccessIdentity,
  deps: { store: PersonalTokenStore; grantsFor: GrantsLookup; publicOrigin?: string; personByEmail?: PersonLookup },
  url: URL,
): Promise<void> {
  if (!identity.sub || !identity.email)
    return page(res, 403, "Connection unavailable", "<p>Sign in with a named account to connect.</p>");
  const subject = personalSubject(identity.sub);
  const grants = deps.grantsFor(`mcp:${subject}`);
  if (!hasAction(grants.actions, "dispatch") || !hasAction(grants.actions, "runs:read"))
    return page(
      res,
      403,
      "MCP access not enabled",
      "<p>This deployment has not enabled personal MCP access. Ask its operator to configure the personal MCP grant.</p>",
    );

  if (req.method === "GET") {
    const challenge = url.searchParams.get("challenge");
    if (challenge !== null && !PERSONAL_TOKEN_DIGEST.test(challenge))
      return page(res, 400, "Invalid connection", "<p>The connection link is malformed.</p>");
    const tokens = await deps.store.list(subject);
    const pending = challenge
      ? `<p>Compare this code with your terminal: <strong><code>${challenge.slice(0, 8).toUpperCase()}</code></strong>. Approve only when they match.</p>` +
        `<form method="post" action="${PERSONAL_MCP_SETUP_PATH}"><input type="hidden" name="action" value="approve"><input type="hidden" name="challenge" value="${challenge}"><button type="submit">Approve this device</button></form>`
      : "<p>Run <code>npx -y @coreplane/switchboard connect your-switchboard.example</code> on your computer. Sign in here and approve the matching code.</p>";
    const devices = tokens.length
      ? `<h2>Connected devices</h2>${tokens.map((token) => `<form method="post" action="${PERSONAL_MCP_SETUP_PATH}"><input type="hidden" name="action" value="revoke"><input type="hidden" name="challenge" value="${token.digest}"><span>Connected ${new Date(token.createdAt).toLocaleString()} · ${token.digest.slice(0, 8)}</span> <button type="submit">Revoke</button></form>`).join("")}`
      : "";
    return page(res, 200, "Connect to Switchboard", pending + devices);
  }
  if (req.method !== "POST") return page(res, 405, "Method not allowed", "<p>Use GET or POST.</p>");
  const origin = req.headers.origin;
  const site = req.headers["sec-fetch-site"];
  let expectedOrigin = deps.publicOrigin;
  if (!expectedOrigin && typeof req.headers.host === "string") expectedOrigin = `http://${req.headers.host}`;
  let originMatches = false;
  try {
    originMatches = typeof origin === "string" && new URL(origin).origin === new URL(expectedOrigin ?? "").origin;
  } catch {
    /* malformed origin is refused */
  }
  if (!originMatches || (site && site !== "same-origin" && site !== "none"))
    return page(res, 403, "Forbidden", "<p>This form must be submitted from Switchboard.</p>");
  const contentType = req.headers["content-type"];
  if (typeof contentType !== "string" || !contentType.startsWith("application/x-www-form-urlencoded"))
    return page(res, 415, "Invalid form", "<p>Expected a form submission.</p>");
  const body = await readBody(req, 4096);
  if (!body.ok) return page(res, 413, "Form too large", "<p>The form was too large.</p>");
  const form = new URLSearchParams(body.body);
  const challenge = form.get("challenge");
  if (!challenge || !PERSONAL_TOKEN_DIGEST.test(challenge))
    return page(res, 400, "Invalid connection", "<p>The connection code is malformed.</p>");
  if (form.get("action") === "approve") {
    // A signed-in person approves a digest; the CLI alone has the random bearer.
    const prior = await deps.store.get(challenge);
    if (prior && prior.subject !== subject)
      return page(res, 409, "Connection already used", "<p>Start a new connection from your terminal.</p>");
    const person = await deps.personByEmail?.(identity.email);
    const userId = person?.id ?? `access:${identity.sub}`;
    await deps.store.put({ digest: challenge, subject, email: identity.email, userId, createdAt: systemClock() });
    return page(
      res,
      200,
      "Device approved",
      "<p>Return to your terminal. Switchboard will finish the connection and verify your access.</p>",
    );
  }
  if (form.get("action") === "revoke") {
    await deps.store.delete(challenge, subject);
    res.writeHead(303, { location: PERSONAL_MCP_SETUP_PATH, "cache-control": "no-store" });
    res.end();
    return;
  }
  return page(res, 400, "Invalid form", "<p>Unknown action.</p>");
}

function page(res: ServerResponse, status: number, title: string, body: string): void {
  res.writeHead(status, HEADERS);
  res.end(
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title} · Switchboard</title><style>body{font:16px system-ui;max-width:40rem;margin:4rem auto;padding:0 1rem}code{background:#eee;padding:.15rem .3rem}form{margin:1rem 0}button{padding:.6rem 1rem}</style></head><body><h1>${title}</h1>${body}</body></html>`,
  );
}
