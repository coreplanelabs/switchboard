// `POST /admin/model-proxy/bearer` (docs/reference/specs/model-proxy.md): an
// operator's bearer for a run still live, so the model proxy can be probed and
// receipted against a real run — the load harness through the proxy, a curl —
// before any harness in a container consumes it. The bearer minted here is one
// more secret on the run's own entry: it spends the run's turns, is pinned to
// the run's model and dies when the run ends. Authorized like `deploy restart`
// and `/admin/crash`: an ingress bearer whose `http:<subject>` holds
// `deploy:write` — the operator who may stop the bot may mint a probe for one
// of its runs. The shim forwards `/admin/*` to the container untouched and the
// Access gate does not cover it, so that bearer is the whole door. The minted
// bearer is written to the response once and never to a log.

import type { IncomingMessage, ServerResponse } from "node:http";
import type { GrantsLookup } from "../core/authz/actor.js";
import type { RunBearerStore } from "../core/modelProxy/runBearers.js";
import { RUN_ID_PATTERN } from "../core/runRecord.js";
import { authorizeIngressBearer } from "../deploy/restart.js";
import type { Secret } from "../secrets.js";
import { readBody } from "./http.js";
import { PROXY_PATHS } from "./modelProxy.js";

export const MODEL_PROXY_BEARER_PATH = "/admin/model-proxy/bearer";
/** The grant the operator's bearer must carry — the restart's and the crash's. */
export const MODEL_PROXY_BEARER_SCOPE = "deploy:write";
/** `{ "runId": "…" }` and nothing more fits well inside this. */
const MAX_BODY_BYTES = 4096;

export interface AdminModelProxyDeps {
  /** Grants by actor id (`ConfigStore.grantsFor`): the bearer's `http:<subject>` must hold `deploy:write`. */
  grantsFor: GrantsLookup;
  /** The `SWITCHBOARD_INGRESS_TOKENS` secret as the process sees it. */
  tokens: Secret | undefined;
  bearers: RunBearerStore;
  log?: (line: string) => void;
}

export function handleAdminModelProxyBearer(
  req: IncomingMessage,
  res: ServerResponse,
  deps: AdminModelProxyDeps,
): void {
  const log = deps.log ?? ((line: string) => console.log(line));
  const json = (status: number, body: Record<string, unknown>) => {
    res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
    res.end(JSON.stringify(body));
  };
  void (async () => {
    if (req.method !== "POST") {
      json(405, { ok: false, error: `method not allowed: POST ${MODEL_PROXY_BEARER_PATH}` });
      req.destroy();
      return;
    }
    const auth = authorizeIngressBearer(
      req.headers.authorization,
      deps.tokens?.reveal(),
      deps.grantsFor,
      MODEL_PROXY_BEARER_SCOPE,
      "model proxy bearer",
    );
    if (!auth.ok) {
      log(`[admin/model-proxy] ${auth.status} — ${auth.reason}`);
      json(auth.status, { ok: false, error: auth.reason });
      req.destroy();
      return;
    }
    const read = await readBody(req, MAX_BODY_BYTES);
    if (!read.ok) {
      json(413, { ok: false, error: "request body too large" });
      return;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(read.body);
    } catch {
      json(400, { ok: false, error: "the body is not JSON" });
      return;
    }
    const runId =
      typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>).runId
        : undefined;
    if (typeof runId !== "string" || !RUN_ID_PATTERN.test(runId)) {
      json(400, { ok: false, error: "`runId` is required: a run id" });
      return;
    }
    const facts = deps.bearers.grantOf(runId);
    if (!facts) {
      json(404, { ok: false, error: "unknown_run" });
      return;
    }
    const issued = deps.bearers.issue(runId);
    if (!issued) {
      json(409, { ok: false, error: "run_ended", runId });
      return;
    }
    log(
      `[admin/model-proxy] ${auth.subject} → bearer for ${runId} (expires ${new Date(issued.expiresAt).toISOString()})`,
    );
    json(201, {
      ok: true,
      runId,
      bearer: issued.token,
      expiresAt: issued.expiresAt,
      model: facts.modelRef,
      path: PROXY_PATHS[facts.providerType],
      turns: { used: facts.turns, max: facts.maxTurns },
    });
  })();
}
