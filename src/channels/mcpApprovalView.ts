import type { IncomingMessage, ServerResponse } from "node:http";
import { systemClock } from "../core/trace/clock.js";
import { authorize } from "../core/authz/authorize.js";
import { chatActorOf } from "../core/authz/actor.js";
import { resourceOf } from "../core/commandRegistry.js";
import { chatInvocation } from "../core/commandSurface.js";
import { dispatchClick, type CoreDeps } from "../core/dispatcher.js";
import { isServiceToken, type AccessIdentity } from "./accessAuth.js";
import { connectionIdentity, mcpRequester, MCP_APPROVAL_PATH } from "./mcpApproval.js";
import type { McpOptions } from "./mcp.js";
import { SingleShotIO } from "./singleShotDispatch.js";
import { readBody } from "./http.js";
import { originAllowed } from "./commandHttp.js";
import { FORM_PAGE_CSP, WEB_HTML_HEADERS } from "./webShell.js";
import { escapeHtml } from "./liveView/html.js";

/** The existing dashboard verifier proves the browser; the core owns every execution. */
export function createMcpApprovalView(core: CoreDeps, options: McpOptions) {
  return (req: IncomingMessage, res: ServerResponse, identity: AccessIdentity): boolean => {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (url.pathname !== MCP_APPROVAL_PATH) return false;
    const page = (status: number, text: string, form = "") => {
      res.writeHead(status, {
        ...WEB_HTML_HEADERS,
        "content-security-policy": FORM_PAGE_CSP,
        "referrer-policy": "no-referrer",
      });
      res.end(
        `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Approve action · Switchboard</title><body><h1>Approve action</h1><pre>${escapeHtml(text)}</pre>${form}</body></html>`,
      );
    };
    void (async () => {
      const store = core.confirmations;
      const id = url.searchParams.get("id");
      if (
        isServiceToken(identity) ||
        !identity.email ||
        !identity.sub ||
        !id ||
        !/^[a-zA-Z0-9_-]{8,128}$/.test(id) ||
        !store?.get
      )
        return page(404, "This offer is unavailable; nothing ran.");
      const row = await store.get(id);
      const connection = row?.message.approvalConnection;
      const userId = row?.message.userId.startsWith("access:")
        ? `access:${identity.sub}`
        : (await options.personByEmail?.(identity.email))?.id;
      if (!row || !userId || userId !== row.message.userId) return page(404, "This offer is unavailable; nothing ran.");
      if (connection) {
        const credential = await connectionIdentity(connection.id, options);
        const requester = credential && (await mcpRequester(credential, options));
        if (
          !credential ||
          `mcp:${credential.subject}` !== connection.credentialId ||
          requester?.userId !== userId ||
          (credential.subject.startsWith("personal:") && credential.subject !== `personal:${identity.sub}`)
        )
          return page(403, "The connection or its verified identity was revoked; nothing ran.");
      } else if (
        row.message.authenticatedAs !== `access:${identity.sub}` &&
        !(
          row.message.authenticatedAs === undefined &&
          row.message.userId === `access:${identity.sub}` &&
          row.message.channelId === `access:${identity.sub}`
        )
      )
        return page(404, "This offer belongs to another connection; nothing ran.");
      const actor = chatActorOf(core.config, row.message);
      let line: string;
      let risk: string;
      if (row.kind === "run") {
        const def = options.commands?.get(row.command);
        if (!def) return page(403, "This action is no longer available; nothing ran.");
        const caller = { kind: connection ? ("mcp" as const) : ("access" as const), id: actor.id, actor };
        if (!authorize(actor, def.action, resourceOf(def, row.input, caller)).allow)
          return page(403, "Permission for this action was revoked; nothing ran.");
        line = chatInvocation(def, row.input);
        risk = [row.risk, ...(row.originRepo ? [`Repository: ${row.originRepo}`] : [])].filter(Boolean).join("\n");
      } else {
        line = row.line;
        risk = row.evidence;
      }
      if (row.expiresAt <= (core.clock?.() ?? systemClock())) return page(410, "This offer expired; nothing ran.");
      if (req.method === "GET")
        return page(
          200,
          `${line}\n${risk}\nExpires: ${new Date(row.expiresAt).toISOString()}`,
          `<form method="post" action="${MCP_APPROVAL_PATH}?id=${encodeURIComponent(id)}"><button name="action" value="approve">Confirm saved action</button><button name="action" value="cancel">Cancel</button></form>`,
        );
      if (req.method !== "POST") return page(405, "Use GET or POST.");
      if (!req.headers.origin || !originAllowed(req, { publicBaseUrl: options.publicBaseUrl }))
        return page(403, "This form must be submitted from Switchboard.");
      const contentType = req.headers["content-type"];
      if (typeof contentType !== "string" || contentType.split(";")[0].trim() !== "application/x-www-form-urlencoded")
        return page(415, "Expected a form submission.");
      const body = await readBody(req, 4096);
      if (!body.ok) return page(413, "Form too large.");
      const form = new URLSearchParams(body.body);
      if ([...form.keys()].some((key) => key !== "action") || form.getAll("action").length !== 1)
        return page(400, "Only the saved action can be confirmed.");
      const action = form.get("action");
      if (action !== "approve" && action !== "cancel") return page(400, "Unknown action.");
      if (connection) {
        if (action === "cancel") {
          const cancelled = await store.cancel(id, [userId], connection.id);
          return page(
            cancelled.ok ? 200 : 409,
            cancelled.ok ? "Cancelled; nothing ran." : "This offer is already used; nothing ran.",
          );
        }
        if (!store.approve) return page(503, "Approval is unavailable; nothing ran.");
        const approved = await store.approve(id, [userId], connection.id);
        return page(
          approved.ok ? 200 : 409,
          approved.ok
            ? "Approved. Return to your MCP client to complete the saved action once."
            : "This offer is expired or already used; nothing ran.",
        );
      }
      const io = new SingleShotIO([], row.message.threadKey);
      await dispatchClick(core, { kind: action === "approve" ? "confirm" : "cancel", id, actor, io });
      return page(200, io.collected());
    })().catch(() => page(503, "Approval is unavailable; nothing ran."));
    return true;
  };
}
