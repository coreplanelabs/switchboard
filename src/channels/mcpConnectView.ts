import type { IncomingMessage, ServerResponse } from "node:http";
import { refusalMessage } from "../mcp/connect.js";
import { nonceOfState } from "../mcp/oauth.js";
import { MCP_TOKEN_MAX_CHARS, type McpServerView } from "../mcp/registry.js";
import type { McpService } from "../mcp/service.js";
import type { AccessIdentity } from "./accessAuth.js";
import { FORM_PAGE_CSP, WEB_HTML_HEADERS } from "./webShell.js";

// The connect page (features/mcp-tools.md items 15 + 18): GET /mcp/connect/<nonce>
// shows a one-field token form for a bearer server, or a "continue to <host>"
// button for an OAuth one; POST stores the pasted token (bearer) or starts the
// authorization and redirects the browser (OAuth, `action=start`); GET
// /mcp/oauth/callback is where the authorization server sends the browser
// back. All of it sits behind the same Cloudflare Access gate as /runs*
// (index.ts passes the verified identity — the callback too, so the person
// who returns from the authorization server is the person who started), and
// the registry service decides everything: whether this identity may
// open/start/complete the ticket, whether the token/state is acceptable,
// whether the server accepts the credential. The pages are plain HTML with no
// script (the shell's CSP forbids inline JS anyway) — a form POST and a 303
// need none. The paths are distinct from POST /mcp (the MCP ingress), which
// matches the bare path only.

export const MCP_CONNECT_PREFIX = "/mcp/connect/";
export const MCP_OAUTH_CALLBACK_PATH = "/mcp/oauth/callback";
const NONCE_RE = /^[A-Za-z0-9_-]{16,128}$/;
/** Sized so any token `planComplete` will judge — up to MCP_TOKEN_MAX_CHARS,
 *  every char URL-encoded to 3 bytes — reaches the friendly `bad_token` /
 *  accept path; only a body no token could fill gets the bare 413. */
const MAX_FORM_BYTES = MCP_TOKEN_MAX_CHARS * 3 + 1024;
/** An OAuth `state`/`code` is short; anything longer is not ours. */
const MAX_OAUTH_PARAM = 1024;

export function parseConnectRoute(pathname: string): { nonce: string } | undefined {
  if (!pathname.startsWith(MCP_CONNECT_PREFIX)) return undefined;
  const nonce = pathname.slice(MCP_CONNECT_PREFIX.length);
  return NONCE_RE.test(nonce) ? { nonce } : undefined;
}

/** Both the connect page and the OAuth callback ride the Access gate in index.ts. */
export function isConnectPath(pathname: string): boolean {
  return pathname.startsWith(MCP_CONNECT_PREFIX) || pathname === MCP_OAUTH_CALLBACK_PATH;
}

export interface ConnectViewDeps {
  registry: () => McpService | undefined;
  /** `PUBLIC_BASE_URL`'s origin for the same-origin check on POST; undefined → the Host header. */
  publicOrigin?: string;
}

/** Returns true when the request was for this view (handled), false to fall through. */
export function createMcpConnectViewHandler(
  deps: ConnectViewDeps,
): (req: IncomingMessage, res: ServerResponse, identity: AccessIdentity) => boolean {
  return (req, res, identity) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (!isConnectPath(url.pathname)) return false;
    const svc = deps.registry();
    if (!svc) {
      page(
        res,
        503,
        "MCP registry not configured",
        "<p>The MCP server registry is not configured on this deployment.</p>",
      );
      return true;
    }
    const method = (req.method ?? "GET").toUpperCase();
    if (url.pathname === MCP_OAUTH_CALLBACK_PATH) {
      if (method !== "GET") return methodNotAllowed(res, "GET");
      callback(svc, url.searchParams, identity, res);
      return true;
    }
    const route = parseConnectRoute(url.pathname);
    if (!route) {
      page(res, 404, "Not found", "<p>Not a valid connect link.</p>");
      return true;
    }
    if (method === "GET") {
      svc
        .openTicket(route.nonce, identity)
        .then(({ decision, server }) => {
          if (!decision.ok)
            return page(
              res,
              statusFor(decision.refusal.kind),
              "Connect link unavailable",
              `<p>${esc(refusalMessage(decision.refusal))}</p>`,
            );
          if (!server) return page(res, 404, "Server missing", "<p>The server this link was for no longer exists.</p>");
          return page(res, 200, `Connect ${server.name}`, entryForm(server, route.nonce));
        })
        .catch((err) => failure(res, err));
      return true;
    }
    if (method === "POST") {
      if (!sameOrigin(req, deps.publicOrigin)) {
        page(res, 403, "Forbidden", "<p>Cross-site form posts are refused.</p>");
        return true;
      }
      readForm(req)
        .then(async (fields) => {
          if (!fields) return page(res, 413, "Too large", "<p>The form was too large.</p>");
          if (fields.get("action") === "start") return start(svc, route.nonce, identity, res);
          return complete(svc, route.nonce, identity, fields.get("token") ?? "", res);
        })
        .catch((err) => failure(res, err));
      return true;
    }
    return methodNotAllowed(res, "GET, POST");
  };
}

/** Bearer: the pasted token. */
async function complete(
  svc: McpService,
  nonce: string,
  identity: AccessIdentity,
  token: string,
  res: ServerResponse,
): Promise<void> {
  const { decision, verified, toolCount, warning, server } = await svc.completeTicket(nonce, identity, token);
  if (!decision.ok) {
    const message = refusalMessage(decision.refusal);
    // A bad token keeps the form up for a retry; a ticket refusal ends it.
    if (decision.refusal.kind === "bad_token" && server)
      return page(res, 400, "Token not accepted", `<p class="err">${esc(message)}</p>${entryForm(server, nonce)}`);
    return page(
      res,
      statusFor(decision.refusal.kind),
      "Connect link unavailable",
      `<p class="err">${esc(message)}</p>`,
    );
  }
  if (verified === false) {
    return page(
      res,
      400,
      "Token rejected by the server",
      `<p class="err">${esc(warning ?? "the server rejected the token")}</p><p>Nothing was stored. Check the token and try again.</p>${server ? entryForm(server, nonce) : ""}`,
    );
  }
  return connected(res, server, toolCount, warning);
}

/** OAuth: the button — discover, register, redirect (303) to the authorization server. */
async function start(svc: McpService, nonce: string, identity: AccessIdentity, res: ServerResponse): Promise<void> {
  const result = await svc.startOAuth(nonce, identity);
  if (!result.ok) {
    const message = refusalMessage(result.refusal);
    if (result.refusal.kind === "oauth_failed" && result.server)
      return page(
        res,
        502,
        "Sign-in could not start",
        `<p class="err">${esc(message)}</p><p>Nothing was stored.</p>${entryForm(result.server, nonce)}`,
      );
    return page(res, statusFor(result.refusal.kind), "Connect link unavailable", `<p class="err">${esc(message)}</p>`);
  }
  // Not a 303: Chrome checks a redirect that follows a form post against
  // `form-action`, and the authorization server is another origin. A page
  // that forwards itself (meta refresh — outside CSP's form-action and
  // script-src) with the same link visible is the cross-origin hop the
  // policy allows, and it needs no script.
  const host = hostOf(result.redirectUrl);
  page(
    res,
    200,
    `Continue to ${host}`,
    `<p>Sending you to <strong>${esc(host)}</strong> to sign in. If nothing happens, <a href="${esc(result.redirectUrl)}">continue to ${esc(host)}</a>.</p>`,
    `<meta http-equiv="refresh" content="0;url=${esc(result.redirectUrl)}">`,
  );
}

/** OAuth: the browser is back. The service checks who/when/state and exchanges the code. */
function callback(svc: McpService, params: URLSearchParams, identity: AccessIdentity, res: ServerResponse): void {
  const short = (k: string) => {
    const v = params.get(k);
    return v && v.length <= MAX_OAUTH_PARAM ? v : undefined;
  };
  const state = short("state");
  if (!state || !nonceOfState(state)) {
    page(
      res,
      400,
      "Not a sign-in return",
      "<p>This page is where an MCP server's sign-in returns to; it carries nothing to finish.</p>",
    );
    return;
  }
  svc
    .completeOAuth(identity, {
      state,
      code: short("code"),
      error: short("error"),
      errorDescription: short("error_description"),
    })
    .then((result) => {
      if (!result.ok) {
        const refusal = result.refusal ?? { kind: "not_found" as const };
        const message = refusalMessage(refusal);
        const retry =
          result.server && refusal.kind === "oauth_failed"
            ? `<p>Nothing was stored. Open the connect link again to retry.</p>`
            : "";
        return page(
          res,
          refusal.kind === "oauth_failed" ? 502 : statusFor(refusal.kind),
          "Sign-in did not complete",
          `<p class="err">${esc(message)}</p>${retry}`,
        );
      }
      return connected(res, result.server, result.toolCount, result.warning);
    })
    .catch((err) => failure(res, err));
}

function connected(
  res: ServerResponse,
  server: McpServerView | undefined,
  toolCount: number | undefined,
  warning: string | undefined,
): void {
  const tools =
    typeof toolCount === "number"
      ? `<p>The server answered with <strong>${toolCount}</strong> tool${toolCount === 1 ? "" : "s"}.</p>`
      : "";
  const warn = warning ? `<p class="warn">${esc(warning)}</p>` : "";
  page(
    res,
    200,
    `Connected ${server?.name ?? ""}`,
    `<p>✅ <strong>${esc(server?.name ?? "server")}</strong> is connected. Your runs can use its tools now.</p>${tools}${warn}<p>You can close this tab.</p>`,
  );
}

function methodNotAllowed(res: ServerResponse, allow: string): boolean {
  res.writeHead(405, { allow, "content-type": "text/plain; charset=utf-8" });
  res.end("method not allowed");
  return true;
}

function statusFor(kind: string): number {
  switch (kind) {
    case "not_found":
      return 404;
    case "wrong_identity":
      return 403;
    case "expired":
    case "used":
    case "cancelled":
      return 410;
    default:
      return 400;
  }
}

function sameOrigin(req: IncomingMessage, publicOrigin: string | undefined): boolean {
  const site = String(req.headers["sec-fetch-site"] ?? "");
  if (site && site !== "same-origin" && site !== "none") return false;
  const origin = req.headers.origin;
  if (typeof origin !== "string" || !origin) return true; // same-origin form posts may omit it; Sec-Fetch-Site covered it above
  const expected = publicOrigin ?? `https://${String(req.headers.host ?? "")}`;
  try {
    return (
      new URL(origin).origin === new URL(expected).origin || new URL(origin).host === String(req.headers.host ?? "")
    );
  } catch {
    return false;
  }
}

/** Past MAX_FORM_BYTES the body is discarded, not parsed — but still read to its
 *  end (up to a hard ceiling) so the 413 reaches the client: destroying the
 *  socket with unread bytes on it turns the answer into a connection reset. */
const DRAIN_CEILING_BYTES = 1024 * 1024;

function readForm(req: IncomingMessage): Promise<URLSearchParams | undefined> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    let overflow = false;
    req.on("data", (c: Buffer) => {
      total += c.length;
      if (total > DRAIN_CEILING_BYTES) {
        resolve(undefined);
        req.destroy();
        return;
      }
      if (overflow) return;
      if (total > MAX_FORM_BYTES) {
        overflow = true;
        chunks.length = 0;
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => resolve(overflow ? undefined : new URLSearchParams(Buffer.concat(chunks).toString("utf8"))));
    req.on("error", reject);
  });
}

/** The page's one interactive element: a token field (bearer) or a sign-in button (oauth). */
function entryForm(server: McpServerView, nonce: string): string {
  if (server.auth === "oauth") {
    const host = hostOf(server.url);
    return (
      `<p>Connect <strong>${esc(server.name)}</strong> (<code>${esc(server.url)}</code>) by signing in with ${esc(host)}. ` +
      `You will be sent to its sign-in page and back here; the resulting credential is encrypted and stored for your runs only — it never appears in Slack, logs, or run records.</p>` +
      `<form method="post" action="${MCP_CONNECT_PREFIX}${esc(nonce)}"><input type="hidden" name="action" value="start">` +
      `<button type="submit">Continue to ${esc(host)}</button></form>`
    );
  }
  return (
    `<p>Paste the API token for <strong>${esc(server.name)}</strong> (<code>${esc(server.url)}</code>). ` +
    `It is encrypted and stored for your runs only; it never appears in Slack, logs, or run records.</p>` +
    `<form method="post" action="${MCP_CONNECT_PREFIX}${esc(nonce)}">` +
    `<label for="token">Token</label><input id="token" name="token" type="password" autocomplete="off" required maxlength="8192">` +
    `<button type="submit">Connect</button></form>`
  );
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return "the server";
  }
}

/** The shared page headers with `form-action 'self'`: this is the one HTML
 *  surface that posts a form, and the shell's `form-action 'none'` blocked it
 *  (live, 2026-09-04). Every other directive is unchanged — no script runs. */
const CONNECT_HTML_HEADERS: Record<string, string> = { ...WEB_HTML_HEADERS, "content-security-policy": FORM_PAGE_CSP };

function page(res: ServerResponse, status: number, title: string, body: string, head = ""): void {
  const html =
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">${head}<title>${esc(title)} · Switchboard</title>` +
    `<style>body{font:15px system-ui,sans-serif;max-width:40rem;margin:4rem auto;padding:0 1rem;color:#222}code{background:#f3f3f3;padding:.1em .3em;border-radius:3px}label{display:block;margin:1rem 0 .3rem;font-weight:600}input{width:100%;padding:.6rem;font-size:1rem;border:1px solid #bbb;border-radius:4px}button{margin-top:1rem;padding:.6rem 1.2rem;font-size:1rem;border-radius:4px;border:0;background:#1f6feb;color:#fff}.err{color:#b00020}.warn{color:#8a6d00}</style>` +
    `</head><body><h1>${esc(title)}</h1>${body}</body></html>`;
  res.writeHead(status, CONNECT_HTML_HEADERS);
  res.end(html);
}

function failure(res: ServerResponse, err: unknown): void {
  console.error(`[mcp-connect] ${err instanceof Error ? err.message : String(err)}`);
  page(res, 503, "Registry unavailable", "<p>The MCP registry could not be reached. Try again in a moment.</p>");
}

function esc(s: string): string {
  return s.replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] as string,
  );
}
