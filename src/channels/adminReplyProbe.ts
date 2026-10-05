import type { IncomingMessage, ServerResponse } from "node:http";
import type { GrantsLookup } from "../core/authz/actor.js";
import { authorizeIngressBearer } from "../deploy/restart.js";
import type { Secret } from "../secrets.js";
import { readBody } from "./http.js";

export const REPLY_PROBE_PATH = "/admin/reply-probe";
export interface ReplyProbeRequest {
  model: string;
  message: string;
}
export interface AdminReplyProbeDeps {
  tokens: Secret | undefined;
  grantsFor: GrantsLookup;
  probe: (request: ReplyProbeRequest, subject: string) => Promise<Record<string, unknown>>;
}

export async function handleAdminReplyProbe(
  req: IncomingMessage,
  res: ServerResponse,
  deps: AdminReplyProbeDeps,
): Promise<void> {
  const json = (status: number, body: Record<string, unknown>) => {
    if (res.destroyed || res.writableEnded) return;
    res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
    res.end(JSON.stringify(body));
  };
  if (req.method !== "POST") {
    json(405, { ok: false, error: "POST required" });
    req.destroy();
    return;
  }
  const auth = authorizeIngressBearer(
    req.headers.authorization,
    deps.tokens?.reveal(),
    deps.grantsFor,
    "deploy:write",
    "reply probe",
  );
  if (!auth.ok) {
    json(auth.status, { ok: false, error: auth.reason });
    req.destroy();
    return;
  }
  let read: Awaited<ReturnType<typeof readBody>>;
  try {
    read = await readBody(req, 4096);
  } catch {
    if (!req.destroyed) json(400, { ok: false, error: "request body was interrupted" });
    return;
  }
  if (!read.ok) {
    json(413, { ok: false, error: "request body too large" });
    return;
  }
  let input: unknown;
  try {
    input = JSON.parse(read.body);
  } catch {
    json(400, { ok: false, error: "JSON required" });
    return;
  }
  const data = input as Partial<ReplyProbeRequest> | null;
  if (
    !data ||
    typeof data !== "object" ||
    Array.isArray(data) ||
    Object.keys(data).some((key) => key !== "model" && key !== "message") ||
    typeof data.model !== "string" ||
    !/^typesafe\/jev-[a-zA-Z0-9.-]+$/.test(data.model) ||
    typeof data.message !== "string" ||
    data.message.trim().length === 0
  ) {
    json(400, { ok: false, error: "model must name typesafe/jev-… and message must be nonempty" });
    return;
  }
  try {
    json(200, { ok: true, ...(await deps.probe(data as ReplyProbeRequest, auth.subject)) });
  } catch {
    json(503, { ok: false, error: "reply probe unavailable; no live decision was changed" });
  }
}
