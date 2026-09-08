// `POST /admin/crash` — kill injection for the durable-runs receipts
// (features/run-history.md item 36, plan D12): the bot process exits hard —
// no drain, no handoff, no finish writes, the platform restarts the container
// — so the "run survives kill -9" criterion is reproducible from the harness,
// without a shell on the container. A hard exit, not a self-SIGKILL: the bot
// is PID 1 in its container and the kernel drops a SIGKILL that init sends
// itself (seen live 2026-09-08: the 202 came back, the run finished 49 s later
// on the same generation). For the runs the two are the same event.
//
// Same authorization as `deploy restart` (`src/deploy/restart.ts`): a
// SWITCHBOARD_INGRESS_TOKENS bearer whose identity carries `deploy:write`. The
// Worker shim forwards the path to the container like any other; the response
// (202, this generation) leaves before the exit.

import type { IncomingMessage, ServerResponse } from "node:http";
import { authorizeRestart } from "../deploy/restart.js";
import type { GrantsLookup } from "../core/authz/actor.js";

export interface AdminCrashDeps {
  /** Grants by actor id (`ConfigStore.grantsFor`): the bearer's `http:<subject>` must hold `deploy:write`. */
  grantsFor: GrantsLookup;
  /** `SWITCHBOARD_INGRESS_TOKENS` as the process sees it. */
  tokens: string | undefined;
  /** This process's run-ledger generation, echoed so the caller can tell the
   *  next generation from this one on `/healthz`. */
  generation: string | undefined;
  /** Injectable exit (tests); default `process.exit(137)` — the code a SIGKILL would have produced. */
  kill?: () => void;
  /** Injectable defer (tests); default `setTimeout(fn, 50)` — the response must
   *  leave the socket before the process dies. */
  defer?: (fn: () => void) => void;
  log?: (line: string) => void;
}

export function handleAdminCrash(req: IncomingMessage, res: ServerResponse, deps: AdminCrashDeps): void {
  const json = (status: number, body: Record<string, unknown>) => {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  };
  if (req.method !== "POST") {
    json(405, { ok: false, error: "method not allowed: POST /admin/crash" });
    return;
  }
  const auth = authorizeRestart(req.headers.authorization, deps.tokens, deps.grantsFor);
  if (!auth.ok) {
    (deps.log ?? console.warn)(`[admin/crash] ${auth.status} — ${auth.reason}`);
    json(auth.status, { ok: false, error: auth.reason });
    return;
  }
  (deps.log ?? console.log)(`[admin/crash] ${auth.subject} → hard exit 137 (generation ${deps.generation ?? "none"})`);
  json(202, { ok: true, generation: deps.generation ?? null, pid: process.pid });
  const kill = deps.kill ?? (() => process.exit(137));
  (deps.defer ?? ((fn) => setTimeout(fn, 50)))(kill);
}
