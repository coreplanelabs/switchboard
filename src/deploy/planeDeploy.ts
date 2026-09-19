// The pending-deploy window (record 0064, "The queue"): the deploy runner
// tells the plane a deploy is in flight, so an ask that arrives mid-roll
// queues on `deploy_settled` instead of racing the roll, and is admitted the
// moment the runner says the deploy landed (`POST /plane/deploy`, the state
// Worker's route — deploy/cloudflare-memory/worker.ts). `landed` is posted
// whether the run succeeded or not: a failed deploy is settled too, and a
// window nobody lifts would queue every later ask until the next deploy.
// Best-effort both ways — a state Worker without the route, a missing bearer
// or an unreachable Worker is one line and the deploy proceeds; the plane is
// an observer of the deploy, never a gate on it.

import { STATE_WORKER_TOKEN_ENV } from "../configDocument.js";
import { RUN_STORE_KEY } from "../core/runStoreWorker.js";

export interface PlaneDeployDeps {
  /** The profile's state Worker; absent → nothing is posted. */
  stateWorkerUrl: string | undefined;
  /** Where the bearer lives (`MEMORY_TOKEN`); absent → one line, nothing posted. */
  env: Record<string, string | undefined>;
  log: (line: string) => void;
  /** Injectable transport (tests); default global fetch with a 20 s bound. */
  fetchFn?: (url: string, init: RequestInit) => Promise<Response>;
}

/** One `/plane/deploy` post: `pending` opens the window, `landed` lifts it.
 *  Never throws — the answer (or the reason nothing was sent) is one line. */
export async function postPlaneDeploy(
  deps: PlaneDeployDeps,
  phase: "pending" | "landed",
  version: string,
): Promise<void> {
  if (!deps.stateWorkerUrl) return;
  const token = deps.env[STATE_WORKER_TOKEN_ENV];
  if (!token) {
    deps.log(
      `[deploy:all] plane: ${phase} not posted — ${STATE_WORKER_TOKEN_ENV} is not set (asks are not queued on this deploy)`,
    );
    return;
  }
  const url = `${deps.stateWorkerUrl.replace(/\/+$/, "")}/plane/deploy`;
  const doFetch =
    deps.fetchFn ?? ((u: string, init: RequestInit) => fetch(u, { ...init, signal: AbortSignal.timeout(20_000) }));
  try {
    const res = await doFetch(url, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ storeKey: RUN_STORE_KEY, phase, version }),
    });
    const body = (await res.json().catch(() => ({}))) as { admitted?: number };
    deps.log(
      res.ok
        ? `[deploy:all] plane: deploy ${phase} posted${phase === "landed" ? ` — ${body.admitted ?? 0} queued ask(s) admitted` : ""}`
        : `[deploy:all] plane: deploy ${phase} not recorded (${res.status}) — an older state Worker has no /plane/deploy; asks are not queued on this deploy`,
    );
  } catch (err) {
    deps.log(
      `[deploy:all] plane: deploy ${phase} not recorded (${err instanceof Error ? err.message : String(err)}) — asks are not queued on this deploy`,
    );
  }
}
