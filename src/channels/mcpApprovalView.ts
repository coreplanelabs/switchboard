import type { Actor } from "../core/authz/types.js";
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
import type { Confirmation, ConfirmationSource } from "../core/confirmations.js";
import { SingleShotIO } from "./singleShotDispatch.js";
import { readBody } from "./http.js";
import { callerIdFor, originAllowed } from "./commandHttp.js";
import { FORM_PAGE_CSP, WEB_HTML_HEADERS } from "./webShell.js";
import { renderMcpApprovalPage, type ApprovalOffer } from "./mcpApprovalPage.js";
import { defaultRunRegistry } from "../core/runRegistry.js";
import { privateWorkerRun, runResource } from "../core/runsService.js";

export interface McpApprovalViewOptions extends McpOptions {
  /** The dashboard's built stylesheet includes its fonts and theme tokens. */
  stylesheets?: readonly string[];
  /** Trusted host lookup of the exact original source under current authority. */
  resolveApprovalSource?(identity: AccessIdentity, row: Confirmation): Promise<ConfirmationSource | undefined>;
}

/** Optional display context reads only the process's cache, never run storage. */
function cachedRunContext(core: CoreDeps, row: Confirmation, actor: Actor): ApprovalOffer["run"] {
  if (row.kind !== "run" || (row.command !== "runs.stop" && row.command !== "runs.kill")) return;
  if (!authorize(actor, "runs:read", { type: "command", id: "runs.get" }).allow) return;
  const runId = row.input.args?.[0];
  if (typeof runId !== "string") return;
  const registry = core.runRegistry ?? defaultRunRegistry;
  const run = registry.getById(runId);
  if (!run || privateWorkerRun(run) || !authorize(actor, "runs:read", runResource(run)).allow) return;
  if (!run.label && !run.repo && !run.agent) return;
  let pr: number | undefined;
  for (const event of registry.snapshotById(runId)?.events ?? [])
    if (event.type === "run_meta") pr = event.repo === run.repo ? event.pr : undefined;
  return { label: run.label, repo: run.repo, agent: run.agent, pr };
}

/** The existing dashboard verifier proves the browser; the core owns every execution. */
export function createMcpApprovalView(core: CoreDeps, options: McpApprovalViewOptions) {
  return (req: IncomingMessage, res: ServerResponse, identity: AccessIdentity, viewer?: Actor): boolean => {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (url.pathname !== MCP_APPROVAL_PATH) return false;
    const page = (status: number, text: string, offer?: ApprovalOffer) => {
      res.writeHead(status, {
        ...WEB_HTML_HEADERS,
        "content-security-policy": FORM_PAGE_CSP,
        "referrer-policy": "same-origin",
      });
      res.end(renderMcpApprovalPage(text, options.stylesheets ?? [], offer));
    };
    if (viewer?.viewingAs && (req.method ?? "GET").toUpperCase() !== "GET") {
      page(403, "Leave Person view before confirming an action.");
      return true;
    }
    void (async () => {
      const store = core.confirmations;
      const id = url.searchParams.get("id");
      if (
        isServiceToken(identity) ||
        (!identity.email && !options.resolveApprovalSource) ||
        !identity.sub ||
        !id ||
        !/^[a-zA-Z0-9_-]{8,128}$/.test(id) ||
        !store?.get
      )
        return page(404, "This offer is unavailable; nothing ran.");
      const row = await store.get(id);
      const connection = row?.message.approvalConnection;
      const originalSource =
        row && options.resolveApprovalSource ? await options.resolveApprovalSource(identity, row) : undefined;
      const sourceActorId = row?.message.postedBy ?? row?.message.authenticatedAs ?? row?.message.userId;
      if (
        row &&
        ((options.resolveApprovalSource && !originalSource) ||
          (row.originalOrganization && !originalSource) ||
          (originalSource && originalSource.actor.id !== sourceActorId))
      )
        return page(404, "This offer is unavailable; nothing ran.");
      const userId = originalSource
        ? row?.message.userId
        : row?.message.userId.startsWith("access:")
          ? `access:${identity.sub}`
          : identity.email
            ? (await options.personByEmail?.(identity.email))?.id
            : undefined;
      if (!row || !userId || userId !== row.message.userId) return page(404, "This offer is unavailable; nothing ran.");
      const connectionValid = async () => {
        if (!connection) return true;
        if (connection.credentialId.startsWith("access:")) {
          const browserId = callerIdFor(identity);
          return (
            connection.mode === undefined &&
            connection.credentialId === browserId &&
            row.message.authenticatedAs === browserId
          );
        }
        const credential = await connectionIdentity(connection.id, options);
        const requester = credential && (await mcpRequester(credential, options));
        return (
          !!credential &&
          `mcp:${credential.subject}` === connection.credentialId &&
          requester?.userId === userId &&
          (!credential.subject.startsWith("personal:") || credential.subject === `personal:${identity.sub}`)
        );
      };
      if (!(await connectionValid()))
        return page(403, "The connection or its verified identity was revoked; nothing ran.");
      if (
        !connection &&
        row.message.authenticatedAs !== `access:${identity.sub}` &&
        !(
          row.message.authenticatedAs === undefined &&
          row.message.userId === `access:${identity.sub}` &&
          row.message.channelId === `access:${identity.sub}`
        )
      )
        return page(404, "This offer belongs to another connection; nothing ran.");
      let actor = originalSource?.actor ?? chatActorOf(core.config, row.message);
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
        return page(200, "", {
          action: `${MCP_APPROVAL_PATH}?id=${encodeURIComponent(id)}`,
          line,
          risk,
          expiresAt: row.expiresAt,
          run: cachedRunContext(core, row, actor),
        });
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
      if (options.resolveApprovalSource) {
        const current = await options.resolveApprovalSource(identity, row);
        if (!current || current.actor.id !== sourceActorId) return page(403, "The saved source changed; nothing ran.");
        actor = current.actor;
      } else actor = chatActorOf(core.config, row.message);
      if (!(await connectionValid()))
        return page(403, "The connection or its verified identity was revoked; nothing ran.");
      if (row.kind === "run") {
        const def = options.commands?.get(row.command);
        const caller = { kind: connection ? ("mcp" as const) : ("access" as const), id: actor.id, actor };
        if (!def || !authorize(actor, def.action, resourceOf(def, row.input, caller)).allow)
          return page(403, "Permission for this action was revoked; nothing ran.");
      }

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
