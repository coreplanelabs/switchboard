import type { Secrets } from "../secrets.js";
import type { RunHistoryConfig } from "./runStore.js";
import { DEFAULT_RUN_STORE_TOKEN_ENV, RUN_STORE_KEY, RUN_STORE_TIMEOUT_MS } from "./runStoreWorker.js";
import {
  isPrivateWorkerEvent,
  type PrivateWorkerEvent,
  type PrivateWorkerEventInput,
  type PrivateWorkerLog,
} from "./privateWorkerLog.js";

/** The same state Worker and store key as the coordinator's durable units. */
export class WorkerPrivateWorkerLog implements PrivateWorkerLog {
  constructor(private readonly opts: { baseUrl: string; token: string; storeKey: string; fetch?: typeof fetch }) {}

  private async post(path: string, body: Record<string, unknown>): Promise<unknown> {
    const res = await (this.opts.fetch ?? fetch)(`${this.opts.baseUrl.replace(/\/+$/, "")}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${this.opts.token}` },
      body: JSON.stringify({ storeKey: this.opts.storeKey, ...body }),
      signal: AbortSignal.timeout(RUN_STORE_TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`private worker log ${path}: HTTP ${res.status}`);
    return res.json();
  }

  async append(threadKey: string, event: PrivateWorkerEventInput): Promise<PrivateWorkerEvent> {
    const answer = (await this.post("/runs/private-worker/append", { threadKey, event })) as { event?: unknown };
    if (!isPrivateWorkerEvent(answer?.event)) throw new Error("private worker log append: invalid answer");
    return answer.event;
  }

  async list(threadKey: string): Promise<PrivateWorkerEvent[]> {
    const answer = (await this.post("/runs/private-worker/list", { threadKey })) as { events?: unknown };
    if (!Array.isArray(answer?.events) || !answer.events.every(isPrivateWorkerEvent))
      throw new Error("private worker log list: invalid answer");
    return answer.events;
  }
}

/** No local or memory fallback for production worker conversations. */
export function buildPrivateWorkerLog(
  cfg: RunHistoryConfig | undefined,
  secrets: Secrets,
): PrivateWorkerLog | undefined {
  if (!cfg || cfg.store === "file" || !cfg.worker?.baseUrl) return undefined;
  const token = secrets.named(cfg.worker.tokenEnv ?? DEFAULT_RUN_STORE_TOKEN_ENV);
  if (!token) return undefined;
  return new WorkerPrivateWorkerLog({ baseUrl: cfg.worker.baseUrl, token: token.reveal(), storeKey: RUN_STORE_KEY });
}
