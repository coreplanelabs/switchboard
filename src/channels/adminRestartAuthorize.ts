// `POST /admin/restart/authorize` — the bot's half of the Worker's
// `POST /admin/restart` (deploy/cloudflare/worker.ts, features/slack-channel.md
// item 8). The Worker holds the token map, so it can tell WHO a bearer is, but
// what that identity may do lives in the bot's config (`grants`, authorization.md
// item 9) — the Worker has no config store. So before it stops the container it
// asks the bot: does the bearer's `http:<subject>` actor hold `deploy:write`? The
// answer is `authorizeRestart`'s, the same check `/admin/crash` runs; nothing here
// stops or changes anything.

import type { IncomingMessage, ServerResponse } from "node:http";
import { authorizeRestart } from "../deploy/restart.js";
import type { GrantsLookup } from "../core/authz/actor.js";

export interface AdminRestartAuthorizeDeps {
  /** Grants by actor id (`ConfigStore.grantsFor`): the bearer's `http:<subject>` must hold `deploy:write`. */
  grantsFor: GrantsLookup;
  /** `SWITCHBOARD_INGRESS_TOKENS` as the process sees it. */
  tokens: string | undefined;
  log?: (line: string) => void;
}

/** 200 `{ ok: true, subject }` when the bearer may restart; else `authorizeRestart`'s
 *  401 / 403 / 503 with its reason — never the token. POST only. */
export function handleAdminRestartAuthorize(
  req: IncomingMessage,
  res: ServerResponse,
  deps: AdminRestartAuthorizeDeps,
): void {
  const json = (status: number, body: Record<string, unknown>) => {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  };
  if (req.method !== "POST") {
    json(405, { ok: false, error: "method not allowed: POST /admin/restart/authorize" });
    return;
  }
  const auth = authorizeRestart(req.headers.authorization, deps.tokens, deps.grantsFor);
  if (!auth.ok) {
    (deps.log ?? console.warn)(`[admin/restart/authorize] ${auth.status} — ${auth.reason}`);
    json(auth.status, { ok: false, error: auth.reason });
    return;
  }
  json(200, { ok: true, subject: auth.subject });
}
