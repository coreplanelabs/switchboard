// `POST /admin/restart/authorize` — the bot's half of the Worker's
// `POST /admin/restart` (deploy/cloudflare/worker.ts, docs/reference/specs/slack-channel.md
// item 8). The Worker holds the token map, so it can tell WHO a bearer is, but
// what that identity may do lives in the bot's config (`grants`, authorization.md
// item 9) — the Worker has no config store. So before it stops the container it
// asks the bot: does this subject's `http:<subject>` actor hold `deploy:write`? The
// Worker names the subject it authenticated in `RESTART_SUBJECT_HEADER` (only it
// can — it strips the header from everything it proxies), and the bot decides the
// grant for that subject without re-authenticating the bearer against its own,
// possibly older, token map (a rotation puts the new map in the Worker's env first
// and in the container's only after this very restart). Without the header the
// route falls back to the bearer, the same whole check `/admin/crash` runs.
// Nothing here stops or changes anything.

import type { IncomingMessage, ServerResponse } from "node:http";
import { authorizeRestart, authorizeRestartSubject, RESTART_SUBJECT_HEADER } from "../deploy/restart.js";
import type { GrantsLookup } from "../core/authz/actor.js";
import type { Secret } from "../secrets.js";

export interface AdminRestartAuthorizeDeps {
  /** Grants by actor id (`ConfigStore.grantsFor`): the bearer's `http:<subject>` must hold `deploy:write`. */
  grantsFor: GrantsLookup;
  /** The `SWITCHBOARD_INGRESS_TOKENS` secret as the process sees it. */
  tokens: Secret | undefined;
  log?: (line: string) => void;
}

/** 200 `{ ok: true, subject }` when the subject (the Worker's header, else the bearer) may
 *  restart; else 401 / 403 / 503 with the reason — never the token. POST only. */
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
  const named = req.headers[RESTART_SUBJECT_HEADER];
  const subject = Array.isArray(named) ? named[0] : named;
  const auth =
    subject !== undefined
      ? authorizeRestartSubject(subject, deps.grantsFor)
      : authorizeRestart(req.headers.authorization, deps.tokens?.reveal(), deps.grantsFor);
  if (!auth.ok) {
    (deps.log ?? console.warn)(`[admin/restart/authorize] ${auth.status} — ${auth.reason}`);
    json(auth.status, { ok: false, error: auth.reason });
    return;
  }
  json(200, { ok: true, subject: auth.subject });
}
