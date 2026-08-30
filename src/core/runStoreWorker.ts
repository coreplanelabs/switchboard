import { errorSuffix } from "./frictionLedgerWorker.js";
import {
  isRunListItem,
  isRunRecord,
  normalizeStored,
  RUN_ID_PATTERN,
  utf8ByteLength,
  type RetentionPolicy,
  type RunListItem,
  type RunListOptions,
  type RunRecord,
  type StoredRunEvent,
} from "./runRecord.js";
import type { PutResult, RunEventsOptions, RunEventsPage, RunStore } from "./runStore.js";

// The DURABLE RunStore (#157, U2): an HTTPS client to the RunHistoryDO on the
// state Worker (deploy/cloudflare-memory/ — one SQLite Durable Object per store
// key), so run history survives bot restarts and redeploys (AGENTS.md
// invariant 6). Mirrors WorkerFrictionLedger: the core sees the RunStore
// interface, the fetch client lives at this boundary. Route contract (JSON
// in/out, bearer = the Worker's MEMORY_TOKEN, string body with a numeric
// Content-Length — the Worker's size fence needs it):
//   POST /runs/put    {storeKey, record, policy?, policyUpdatedAt?} → {ok, retained, stored, rewritten}
//   POST /runs/get    {storeKey, id}                                → {record: RunRecord | null}
//   POST /runs/summary {storeKey, id}                               → {summary: RunListItem | null}
//   POST /runs/list   {storeKey, limit?, before?, beforeId?, sinceMs?, agent?, channel?}
//                                                                   → {items: RunListItem[], nextBefore?: {finishedAt, id}}
//   POST /runs/events {storeKey, id, afterSeq?, limit?}             → {events: StoredRunEvent[] | null, nextAfterSeq?}
//                                                                     (`events: null` = unknown or hidden run)
//   POST /runs/delete {storeKey, id}                                → {ok: true, deleted: boolean}
// Only `put` carries a policy (KTD5): the DO owns the effective policy and a
// read can never widen it. Failure classes tell the caller what to do: a 404
// means the ROUTE is missing (Worker not yet deployed with v3 — do not retry),
// 5xx/408/429/network are transient (bounded retries), any other 4xx is
// permanent (log and count).

/** Per-request ceiling: `put` runs after the reply is sent and reads answer a
 *  command — neither may hang the process. */
export const RUN_STORE_TIMEOUT_MS = 10_000;
/** Env var holding the state Worker bearer when `runHistory.worker.tokenEnv` is unset. */
export const DEFAULT_RUN_STORE_TOKEN_ENV = "MEMORY_TOKEN";
/** The one store key (Durable Object name) the bot uses (KTD3). */
export const RUN_STORE_KEY = "runs:default";

/** The `/runs/*` route answered 404: the Worker does not have this route yet. Never retried. */
export class RouteMissingError extends Error {
  readonly name = "RouteMissingError";
}
/** Network failure, timeout, 408, 429, or 5xx: retry with backoff. */
export class TransientStoreError extends Error {
  readonly name = "TransientStoreError";
}
/** Any other non-2xx, or a malformed response body: log and count, never retry. */
export class PermanentStoreError extends Error {
  readonly name = "PermanentStoreError";
}

export interface WorkerRunStoreOptions {
  /** Base URL of the state Worker (e.g. https://switchboard-memory.coreplanelabs.dev). */
  baseUrl: string;
  /** Bearer secret (MEMORY_TOKEN on the Worker). */
  token: string;
  /** Which store on the Worker — the Durable Object name. */
  storeKey: string;
  /** Proposed retention policy, sent with every `put`; the DO keeps the newest proposal. */
  policy?: RetentionPolicy;
  /** When the proposal was made (epoch ms) — the bot's config load time. */
  policyUpdatedAt?: number;
  /** Injectable for tests; defaults to global fetch. */
  fetch?: typeof fetch;
}

export class WorkerRunStore implements RunStore {
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly opts: WorkerRunStoreOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/+$/, "");
    this.fetchImpl = opts.fetch ?? fetch;
  }

  async put(record: RunRecord): Promise<PutResult> {
    if (!RUN_ID_PATTERN.test(record.id)) throw new PermanentStoreError(`run store: refusing to put malformed id ${JSON.stringify(record.id)}`);
    const body: Record<string, unknown> = { storeKey: this.opts.storeKey, record };
    if (this.opts.policy) {
      body.policy = this.opts.policy;
      if (this.opts.policyUpdatedAt !== undefined) body.policyUpdatedAt = this.opts.policyUpdatedAt;
    }
    const data = await this.post("/runs/put", body);
    if (data.ok !== true || typeof data.retained !== "number" || typeof data.stored !== "boolean" || typeof data.rewritten !== "boolean") {
      throw new PermanentStoreError("run store /runs/put returned a malformed result");
    }
    return { ok: true, retained: data.retained, stored: data.stored, rewritten: data.rewritten };
  }

  async get(id: string): Promise<RunRecord | null> {
    if (!RUN_ID_PATTERN.test(id)) return null;
    const data = await this.post("/runs/get", { storeKey: this.opts.storeKey, id });
    if (data.record === null || data.record === undefined) return null;
    if (!isRunRecord(data.record) || data.record.id !== id) throw new PermanentStoreError("run store /runs/get returned a malformed record");
    return normalizeStored(data.record);
  }

  async getSummary(id: string): Promise<RunListItem | null> {
    if (!RUN_ID_PATTERN.test(id)) return null;
    const data = await this.post("/runs/summary", { storeKey: this.opts.storeKey, id });
    if (data.summary === null || data.summary === undefined) return null;
    if (!isRunListItem(data.summary) || data.summary.id !== id) throw new PermanentStoreError("run store /runs/summary returned a malformed summary");
    return normalizeStored(data.summary);
  }

  async list(opts: RunListOptions): Promise<RunListItem[]> {
    const data = await this.post("/runs/list", { storeKey: this.opts.storeKey, ...compact(opts) });
    if (!Array.isArray(data.items)) throw new PermanentStoreError("run store /runs/list returned no items array");
    return data.items.filter(isRunListItem).map(normalizeStored);
  }

  async events(id: string, opts: RunEventsOptions): Promise<RunEventsPage | null> {
    if (!RUN_ID_PATTERN.test(id)) return null;
    const data = await this.post("/runs/events", { storeKey: this.opts.storeKey, id, ...compact(opts) });
    if (data.events === null) return null; // the DO's not-found: no such run, or hidden by retention
    if (!Array.isArray(data.events)) throw new PermanentStoreError("run store /runs/events returned no events array");
    const events = data.events.filter(
      (e): e is StoredRunEvent => typeof e === "object" && e !== null && typeof (e as StoredRunEvent).type === "string" && typeof (e as StoredRunEvent).seq === "number",
    );
    const out: RunEventsPage = { events };
    if (typeof data.nextAfterSeq === "number") out.nextAfterSeq = data.nextAfterSeq;
    return out;
  }

  async delete(id: string): Promise<void> {
    if (!RUN_ID_PATTERN.test(id)) return;
    await this.post("/runs/delete", { storeKey: this.opts.storeKey, id });
  }

  /** POST a JSON body and classify the outcome. The body is a STRING with an
   *  explicit numeric Content-Length measured in UTF-8 bytes. */
  private async post(path: string, payload: unknown): Promise<Record<string, unknown>> {
    const body = JSON.stringify(payload);
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.baseUrl}${path}`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "content-length": String(utf8ByteLength(body)),
          authorization: `Bearer ${this.opts.token}`,
        },
        body,
        signal: AbortSignal.timeout(RUN_STORE_TIMEOUT_MS),
      });
    } catch (err) {
      throw new TransientStoreError(`run store ${path}: ${err instanceof Error ? err.message : String(err)}`);
    }
    if (!res.ok) {
      const message = `run store ${path} HTTP ${res.status}${await errorSuffix(res)}`;
      if (res.status === 404) throw new RouteMissingError(message);
      if (res.status >= 500 || res.status === 408 || res.status === 429) throw new TransientStoreError(message);
      throw new PermanentStoreError(message);
    }
    const data = (await res.json().catch(() => null)) as unknown;
    if (typeof data !== "object" || data === null) throw new PermanentStoreError(`run store ${path} returned a non-JSON body`);
    return data as Record<string, unknown>;
  }
}

/** Drop undefined fields so the wire body carries only what was asked. */
function compact<T extends object>(o: T): Partial<T> {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as Partial<T>;
}
