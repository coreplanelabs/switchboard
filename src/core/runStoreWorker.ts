import { errorSuffix } from "./workerError.js";
import { tracedFetch } from "./trace/tracedFetch.js";
import type { Span, TraceOptions } from "./trace/types.js";
import {
  isRunListItem,
  isRunRecord,
  normalizeStored,
  RUN_ID_PATTERN,
  type RetentionPolicy,
  type RunListItem,
  type RunListOptions,
  type RunRecord,
  type StoredRunEvent,
} from "./runRecord.js";
import type { PutResult, RunEventsOptions, RunEventsPage, RunStore } from "./runStore.js";

// The DURABLE RunStore (docs/decisions/0006-runs-have-two-lives.md): an HTTPS client to the RunHistoryDO on the
// state Worker (deploy/cloudflare-memory/ — one SQLite Durable Object per store
// key), so run history survives bot restarts and redeploys (AGENTS.md
// invariant 6). Mirrors WorkerMemoryStore: the core sees the RunStore
// interface, the fetch client lives at this boundary. Route contract (JSON
// in/out, bearer = the Worker's MEMORY_TOKEN, string body — the runtime
// derives the numeric Content-Length the Worker's size fence needs from it,
// exactly as the memory/friction/schedule clients do; a hand-set header was
// the one difference between this client and those three, and the only one
// whose fetches failed from the production container):
//   POST /runs/put    {storeKey, record, policy?, policyUpdatedAt?} → {ok, retained, stored, rewritten}
//   POST /runs/get    {storeKey, id}                                → {record: RunRecord | null}
//   POST /runs/summary {storeKey, id}                               → {summary: RunListItem | null}
//   POST /runs/list   {storeKey, limit?, before?, beforeId?, sinceMs?, agent?, channel?}
//                                                                   → {items: RunListItem[], nextBefore?: {finishedAt, id}}
//   POST /runs/events {storeKey, id, afterSeq?, limit?}             → {events: StoredRunEvent[] | null, nextAfterSeq?}
//                                                                     (`events: null` = unknown or hidden run)
//   POST /runs/delete {storeKey, id}                                → {ok: true, deleted: boolean}
// Only `put` carries a policy: the DO owns the effective policy and a
// read can never widen it. Failure classes tell the caller what to do: a 404
// means the ROUTE is missing (Worker not yet deployed with v3 — do not retry),
// 5xx/408/429/network are transient (bounded retries), any other 4xx is
// permanent (log and count).

/** Per-request ceiling: `put` runs after the reply is sent and reads answer a
 *  command — neither may hang the process. */
export const RUN_STORE_TIMEOUT_MS = 10_000;
/** Env var holding the state Worker bearer when `runHistory.worker.tokenEnv` is unset. */
export const DEFAULT_RUN_STORE_TOKEN_ENV = "MEMORY_TOKEN";
/** The one store key (Durable Object name) the bot uses. */
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

/** An error's message followed by its `cause` chain — Node's fetch reports every
 *  network failure as a bare "fetch failed" and keeps the reason (ECONNRESET,
 *  UND_ERR_*, a TLS error) in `cause`; a warn line without it is useless. */
export function describeError(err: unknown, depth = 0): string {
  if (!(err instanceof Error)) return String(err);
  const code = (err as Error & { code?: unknown }).code;
  const head = typeof code === "string" && !err.message.includes(code) ? `${err.message} [${code}]` : err.message;
  const cause = (err as Error & { cause?: unknown }).cause;
  return cause !== undefined && depth < 4 ? `${head} (cause: ${describeError(cause, depth + 1)})` : head;
}

export interface WorkerRunStoreOptions {
  /** Base URL of the state Worker (e.g. https://switchboard-memory.example.com). */
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

/** The Worker's routes, as a span names them. */
type RunStoreRoute = "/runs/put" | "/runs/get" | "/runs/summary" | "/runs/list" | "/runs/events" | "/runs/delete";

export class WorkerRunStore implements RunStore {
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly opts: WorkerRunStoreOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/+$/, "");
    this.fetchImpl = opts.fetch ?? fetch;
  }

  async put(record: RunRecord, trace?: TraceOptions): Promise<PutResult> {
    if (!RUN_ID_PATTERN.test(record.id))
      throw new PermanentStoreError(`run store: refusing to put malformed id ${JSON.stringify(record.id)}`);
    const body: Record<string, unknown> = { storeKey: this.opts.storeKey, record };
    if (this.opts.policy) {
      body.policy = this.opts.policy;
      if (this.opts.policyUpdatedAt !== undefined) body.policyUpdatedAt = this.opts.policyUpdatedAt;
    }
    const data = await this.post("/runs/put", body, trace?.span);
    if (
      data.ok !== true ||
      typeof data.retained !== "number" ||
      typeof data.stored !== "boolean" ||
      typeof data.rewritten !== "boolean"
    ) {
      throw new PermanentStoreError("run store /runs/put returned a malformed result");
    }
    return { ok: true, retained: data.retained, stored: data.stored, rewritten: data.rewritten };
  }

  async get(id: string): Promise<RunRecord | null> {
    if (!RUN_ID_PATTERN.test(id)) return null;
    const data = await this.post("/runs/get", { storeKey: this.opts.storeKey, id });
    if (data.record === null || data.record === undefined) return null;
    if (!isRunRecord(data.record) || data.record.id !== id)
      throw new PermanentStoreError("run store /runs/get returned a malformed record");
    return normalizeStored(data.record);
  }

  async getSummary(id: string): Promise<RunListItem | null> {
    if (!RUN_ID_PATTERN.test(id)) return null;
    const data = await this.post("/runs/summary", { storeKey: this.opts.storeKey, id });
    if (data.summary === null || data.summary === undefined) return null;
    if (!isRunListItem(data.summary) || data.summary.id !== id)
      throw new PermanentStoreError("run store /runs/summary returned a malformed summary");
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
      (e): e is StoredRunEvent =>
        typeof e === "object" &&
        e !== null &&
        typeof (e as StoredRunEvent).type === "string" &&
        typeof (e as StoredRunEvent).seq === "number",
    );
    const out: RunEventsPage = { events };
    if (typeof data.nextAfterSeq === "number") out.nextAfterSeq = data.nextAfterSeq;
    return out;
  }

  async delete(id: string): Promise<void> {
    if (!RUN_ID_PATTERN.test(id)) return;
    await this.post("/runs/delete", { storeKey: this.opts.storeKey, id });
  }

  /** POST a JSON body and classify the outcome. The body is a STRING; the
   *  runtime sets its numeric Content-Length (never hand-set — see header). */
  private async post(path: RunStoreRoute, payload: unknown, span?: Span): Promise<Record<string, unknown>> {
    const body = JSON.stringify(payload);
    let res: Response;
    try {
      // One `http.client` span under `span` when the caller has one (the
      // history writer's; docs/reference/specs/tracing.md item 24), the route being the
      // path literal; the plain fetch otherwise.
      res = await tracedFetch(
        span,
        `${this.baseUrl}${path}`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${this.opts.token}`,
          },
          body,
          signal: AbortSignal.timeout(RUN_STORE_TIMEOUT_MS),
        },
        { route: path, fetchImpl: this.fetchImpl },
      );
    } catch (err) {
      throw new TransientStoreError(`run store ${path}: ${describeError(err)}`);
    }
    if (!res.ok) {
      const message = `run store ${path} HTTP ${res.status}${await errorSuffix(res)}`;
      if (res.status === 404) throw new RouteMissingError(message);
      if (res.status >= 500 || res.status === 408 || res.status === 429) throw new TransientStoreError(message);
      throw new PermanentStoreError(message);
    }
    const data = (await res.json().catch(() => null)) as unknown;
    if (typeof data !== "object" || data === null)
      throw new PermanentStoreError(`run store ${path} returned a non-JSON body`);
    return data as Record<string, unknown>;
  }
}

/** Drop undefined fields so the wire body carries only what was asked. */
function compact<T extends object>(o: T): Partial<T> {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as Partial<T>;
}
