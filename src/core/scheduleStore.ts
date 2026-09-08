import { isScheduleFiring, type ScheduleFiring } from "./schedules.js";
import { errorSuffix } from "./workerError.js";

// Where scheduled firings are recorded (#244). The Worker shim writes one
// `ScheduleFiring` per cron firing; the bot's /runs "Scheduled" panel reads the
// newest per schedule. Two implementations of one seam (AGENTS.md invariant 2):
//
// - `WorkerScheduleStore` — the production choice — an HTTPS client to the
//   `ScheduleDO` on the state Worker (deploy/cloudflare-memory/, one SQLite
//   Durable Object, the same MEMORY_TOKEN bearer as memory and the friction
//   ledger), so the record survives bot restarts and redeploys (invariant 6).
//   The shim POSTs the same two routes directly (it holds MEMORY_TOKEN too).
// - `InMemoryScheduleStore` — tests.
//
// Route contract (JSON in/out, bearer = the Worker's MEMORY_TOKEN):
//   POST /schedules/record {firing: ScheduleFiring} → {ok:true, retained}
//   POST /schedules/latest {}                       → {firings: ScheduleFiring[]} (newest per schedule)

export interface ScheduleStore {
  /** Append one firing. Throws on failure; callers log, never crash. */
  record(firing: ScheduleFiring): Promise<void>;
  /** The newest firing of every schedule that has ever fired. Throws on failure. */
  latest(): Promise<ScheduleFiring[]>;
}

/** The store of a process without a firing store (a Null Object, routing-and-
 *  config item 13): a firing is dropped, and nothing has ever fired. */
export class NullScheduleStore implements ScheduleStore {
  async record(_firing: ScheduleFiring): Promise<void> {
    // no store to record on
  }
  async latest(): Promise<ScheduleFiring[]> {
    return [];
  }
}

export class InMemoryScheduleStore implements ScheduleStore {
  private readonly firings = new Map<string, ScheduleFiring[]>();

  async record(firing: ScheduleFiring): Promise<void> {
    const list = this.firings.get(firing.schedule) ?? [];
    list.push({ ...firing });
    list.sort((a, b) => a.firedAt - b.firedAt);
    this.firings.set(firing.schedule, list);
  }

  async latest(): Promise<ScheduleFiring[]> {
    return [...this.firings.values()].map((list) => ({ ...list[list.length - 1] }));
  }

  /** Every firing of one schedule, oldest first (tests / inspection). */
  all(schedule: string): ScheduleFiring[] {
    return (this.firings.get(schedule) ?? []).map((f) => ({ ...f }));
  }
}

/** Per-request ceiling: `latest` renders a dashboard panel — it may not hang the page. */
export const SCHEDULE_WORKER_TIMEOUT_MS = 10_000;
/** Env var holding the state Worker bearer when `schedules.worker.tokenEnv` is unset. */
export const DEFAULT_SCHEDULE_TOKEN_ENV = "MEMORY_TOKEN";

export interface WorkerScheduleStoreOptions {
  /** Base URL of the state Worker (e.g. https://switchboard-memory.coreplanelabs.dev). */
  baseUrl: string;
  /** Bearer secret (MEMORY_TOKEN on the Worker). */
  token: string;
  /** Injectable for tests; defaults to global fetch. */
  fetch?: typeof fetch;
}

export class WorkerScheduleStore implements ScheduleStore {
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly opts: WorkerScheduleStoreOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/+$/, "");
    this.fetchImpl = opts.fetch ?? fetch;
  }

  async record(firing: ScheduleFiring): Promise<void> {
    const res = await this.post("/schedules/record", { firing });
    if (!res.ok) throw new Error(`schedule worker /record HTTP ${res.status}${await errorSuffix(res)}`);
  }

  async latest(): Promise<ScheduleFiring[]> {
    const res = await this.post("/schedules/latest", {});
    if (!res.ok) throw new Error(`schedule worker /latest HTTP ${res.status}${await errorSuffix(res)}`);
    const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (!Array.isArray(data.firings)) throw new Error("schedule worker /latest returned no firings array");
    return data.firings.filter(isScheduleFiring);
  }

  private post(path: string, body: unknown): Promise<Response> {
    return this.fetchImpl(`${this.baseUrl}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${this.opts.token}` },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(SCHEDULE_WORKER_TIMEOUT_MS),
    });
  }
}

/** `schedules:` config block (config.yaml). Only the durable store is
 *  configurable — there is no host-disk fallback because the WRITER is the
 *  Worker shim, which has no disk; without the Worker the panel simply reports
 *  that firing history is unavailable. */
export interface SchedulesConfig {
  worker?: {
    baseUrl: string;
    /** Env var holding the bearer; default MEMORY_TOKEN. */
    tokenEnv?: string;
  };
}

/** Process-startup store selection (src/index.ts): the Worker store when
 *  `schedules.worker.baseUrl` and its bearer are present, else undefined with a
 *  warning naming exactly what is missing. Pure w.r.t. the environment. */
export function buildScheduleStore(
  cfg: SchedulesConfig | undefined,
  env: Record<string, string | undefined>,
  warn: (message: string) => void,
): ScheduleStore | undefined {
  const worker = cfg?.worker;
  if (!worker?.baseUrl) {
    warn(
      "no schedule firing store — the /runs Scheduled panel will show schedules without their firing history. Configure schedules.worker.baseUrl (+ its bearer).",
    );
    return undefined;
  }
  const tokenEnv = worker.tokenEnv ?? DEFAULT_SCHEDULE_TOKEN_ENV;
  const token = env[tokenEnv]?.trim();
  if (!token) {
    warn(
      `schedules.worker is configured but ${tokenEnv} is unset — firing history unavailable. Set ${tokenEnv} to the state Worker's bearer.`,
    );
    return undefined;
  }
  return new WorkerScheduleStore({ baseUrl: worker.baseUrl, token });
}
