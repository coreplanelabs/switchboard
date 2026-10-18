import { PermanentStoreError, RouteMissingError, TransientStoreError, UncertainStoreError } from "./storeFailure.js";
export { PermanentStoreError, RouteMissingError, TransientStoreError, UncertainStoreError } from "./storeFailure.js";
import { readStoreResponse, prepareStorageRequest, type StoreOperationKind } from "./storeResponse.js";
import { errorSuffix } from "./workerError.js";
import { storageTransport } from "./storageTransport.js";
import type { StorageFailureNotice } from "./storageFailureDiagnostic.js";
import type { StorageOperation, StorageOperationBody } from "./storageRequestContext.js";
import type { Span, TraceOptions } from "./trace/types.js";
import {
  isRunListItem,
  clampListLimit,
  matchesRecoveryEvidence,
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
import { pointOf } from "./runMetrics.js";
import type { ModelPriceTable } from "./modelPricing.js";
import { isRunUsageRows, reportOfUsageRows, type RunUsageQuery, type RunUsageReport } from "./runUsage.js";
import { RUN_STORE_TIMEOUT_MS } from "./runStoreConstants.js";
export { RUN_STORE_KEY, RUN_STORE_TIMEOUT_MS } from "./runStoreConstants.js";

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
//   POST /runs/put    {storeKey, record, policy?, policyUpdatedAt?, point?} → {ok, retained, stored, rewritten}
//   POST /runs/shutdown {storeKey, record}                           → {ok, confirmed}
//   POST /runs/get    {storeKey, id}                                → {record: RunRecord | null}
//   POST /runs/summary {storeKey, id}                               → {summary: RunListItem | null}
//   POST /runs/list   {storeKey, limit?, before?, beforeId?, sinceMs?, agent?, channel?, threadKey?, parentRunId?, pr?}
//                                                                   → {items: RunListItem[], nextBefore?: {finishedAt, id}}
//   POST /runs/events {storeKey, id, afterSeq?, limit?}             → {events: StoredRunEvent[] | null, nextAfterSeq?}
//                                                                     (`events: null` = unknown or hidden run)
//   POST /runs/delete {storeKey, id}                                → {ok: true, deleted: boolean}
// Only `put` carries a policy: the DO owns the effective policy and a
// read can never widen it. Failure classes tell the caller what to do: a 404
// means the ROUTE is missing (Worker not yet deployed with v3 — do not retry),
// 5xx/408/429/network are transient (bounded retries), any other 4xx is
// permanent (log and count).

/** Env var holding the state Worker bearer when `runHistory.worker.tokenEnv` is unset. */
export const DEFAULT_RUN_STORE_TOKEN_ENV = "MEMORY_TOKEN";

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

/** The /healthz `features` entry the state Worker carries when its deploy bound the dataset
 *  (`featuresOf` in deploy/cloudflare-memory/worker.ts): `runMetrics:<dataset>`. */
const RUN_METRICS_FEATURE_PREFIX = "runMetrics:";

/** Pure: the one `[runs]` boot warning when the bot's configured `metrics.dataset` and the
 *  dataset the state Worker's /healthz `features` names disagree — the two differ, or only one
 *  side names one — and `undefined` when both agree or both are absent
 *  (docs/reference/specs/run-metrics.md item 6). Advisory: neither side refuses to start. */
export function metricsDatasetWarning(
  configured: string | undefined,
  features: readonly unknown[],
): string | undefined {
  const entry = features.find((f): f is string => typeof f === "string" && f.startsWith(RUN_METRICS_FEATURE_PREFIX));
  const bound = entry?.slice(RUN_METRICS_FEATURE_PREFIX.length);
  if (configured === bound) return undefined;
  if (bound === undefined)
    return `[runs] metrics dataset mismatch: this bot's config names metrics.dataset "${configured}" but the state Worker has no RUN_METRICS binding — no point is written until the deployment profile names the dataset and the state Worker redeploys`;
  if (configured === undefined)
    return `[runs] metrics dataset mismatch: the state Worker binds RUN_METRICS to "${bound}" but this bot's config names no metrics.dataset — points are written, and the reader stays off until the config names the same dataset`;
  return `[runs] metrics dataset mismatch: this bot's config names metrics.dataset "${configured}" but the state Worker binds "${bound}" — the reader would query a dataset the points do not land in`;
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
  /** The price table every point's dollars are computed through (`pointOf`,
   *  docs/reference/specs/run-metrics.md) — the same table `RunsService`
   *  prices with. Absent: the list prices alone. */
  prices?: ModelPriceTable;
  /** Injectable for tests; defaults to global fetch. */
  fetch?: typeof fetch;
  onFailure?: (notice: StorageFailureNotice) => void;
}

/** The Worker's routes, as a span names them. */
type RunStoreRoute =
  | "/runs/put"
  | "/runs/shutdown"
  | "/runs/get"
  | "/runs/summary"
  | "/runs/list"
  | "/runs/events"
  | "/runs/delete"
  | "/runs/deleted"
  | "/runs/usage";

export class WorkerRunStore implements RunStore {
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly opts: WorkerRunStoreOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/+$/, "");
    this.fetchImpl = opts.fetch ?? fetch;
  }

  abandoned(): void {
    // a store keeps nothing in flight per record (run-history item 54): nothing to settle
  }
  async put(record: RunRecord, trace?: TraceOptions): Promise<PutResult> {
    if (!RUN_ID_PATTERN.test(record.id))
      throw new PermanentStoreError(`run store: refusing to put malformed id ${JSON.stringify(record.id)}`);
    const body: { record: RunRecord } & Record<string, unknown> = { storeKey: this.opts.storeKey, record };
    // The record's metrics point rides beside it (run-metrics.md): computed for
    // every final record, absent for a provisional one — the object decides
    // whether the row turned final and whether to write it.
    const point = pointOf(record, this.opts.prices);
    if (point !== undefined) body.point = point;
    if (this.opts.policy) {
      body.policy = this.opts.policy;
      if (this.opts.policyUpdatedAt !== undefined) body.policyUpdatedAt = this.opts.policyUpdatedAt;
    }
    return await this.post(
      "/runs/put",
      body,
      trace?.span,
      "write",
      (value) =>
        value.ok === true &&
        Number.isSafeInteger(value.retained) &&
        Number(value.retained) >= 0 &&
        typeof value.stored === "boolean" &&
        typeof value.rewritten === "boolean",
      async (data): Promise<PutResult> => {
        if (
          data.ok !== true ||
          typeof data.retained !== "number" ||
          typeof data.stored !== "boolean" ||
          typeof data.rewritten !== "boolean"
        ) {
          throw new PermanentStoreError("run store /runs/put returned a malformed result");
        }
        return { ok: true, retained: data.retained, stored: data.stored, rewritten: data.rewritten };
      },
    );
  }

  async confirmRuntimeShutdown(original: RunRecord, trace?: TraceOptions): Promise<boolean> {
    return await this.post(
      "/runs/shutdown",
      { storeKey: this.opts.storeKey, record: original },
      trace?.span,
      "write",
      (value) => value.ok === true && typeof value.confirmed === "boolean",
      async (result): Promise<boolean> => {
        return result.confirmed === true;
      },
    );
  }

  async get(id: string): Promise<RunRecord | null> {
    if (!RUN_ID_PATTERN.test(id)) return null;
    return await this.read(
      "/runs/get",
      { storeKey: this.opts.storeKey, id },
      async (data): Promise<RunRecord | null> => {
        if (data.record === null || data.record === undefined) return null;
        if (!isRunRecord(data.record) || data.record.id !== id)
          throw new PermanentStoreError("run store /runs/get returned a malformed record");
        return normalizeStored(data.record);
      },
    );
  }

  async getSummary(id: string): Promise<RunListItem | null> {
    if (!RUN_ID_PATTERN.test(id)) return null;
    return await this.read(
      "/runs/summary",
      { storeKey: this.opts.storeKey, id },
      async (data): Promise<RunListItem | null> => {
        if (data.summary === null || data.summary === undefined) return null;
        if (!isRunListItem(data.summary) || data.summary.id !== id)
          throw new PermanentStoreError("run store /runs/summary returned a malformed summary");
        return normalizeStored(data.summary);
      },
    );
  }

  async list(opts: RunListOptions): Promise<RunListItem[]> {
    return await this.read(
      "/runs/list",
      { storeKey: this.opts.storeKey, ...compact(opts) },
      async (data): Promise<RunListItem[]> => {
        if (!Array.isArray(data.items)) throw new PermanentStoreError("run store /runs/list returned no items array");
        if (
          opts.recoveryEvidence !== undefined &&
          (data.evidenceComplete !== true ||
            data.nextBefore !== undefined ||
            data.items.length >= clampListLimit(opts.limit) ||
            data.items.some((item) => !isRunListItem(item) || !matchesRecoveryEvidence(item, opts.recoveryEvidence!)) ||
            new Set(data.items.map((item) => (item as RunListItem).id)).size !== data.items.length)
        )
          throw new PermanentStoreError("run store /runs/list recovery evidence incomplete");
        return data.items.filter(isRunListItem).map(normalizeStored);
      },
    );
  }

  async events(id: string, opts: RunEventsOptions): Promise<RunEventsPage | null> {
    if (!RUN_ID_PATTERN.test(id)) return null;
    return await this.read(
      "/runs/events",
      { storeKey: this.opts.storeKey, id, ...compact(opts) },
      async (data): Promise<RunEventsPage | null> => {
        if (data.events === null) return null;
        if (!Array.isArray(data.events))
          throw new PermanentStoreError("run store /runs/events returned no events array");
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
      },
    );
  }

  async deleted(ids: readonly string[]): Promise<string[]> {
    if (ids.length === 0) return [];
    return await this.read("/runs/deleted", { storeKey: this.opts.storeKey, ids }, async (data): Promise<string[]> => {
      if (!Array.isArray(data.ids) || data.ids.some((id) => typeof id !== "string" || !ids.includes(id)))
        throw new PermanentStoreError("run store /runs/deleted returned a malformed result");
      return data.ids as string[];
    });
  }

  async delete(id: string, opts?: { destructive: true }): Promise<void> {
    if (!RUN_ID_PATTERN.test(id)) return;
    return await this.post(
      "/runs/delete",
      {
        storeKey: this.opts.storeKey,
        id,
        ...(opts?.destructive ? { destructive: true } : {}),
      },
      undefined,
      "write",
      undefined,
      async (result): Promise<void> => {
        if (opts?.destructive && result.destructive !== true)
          throw new PermanentStoreError("The history service did not confirm the Kill deletion fence.");
      },
    );
  }

  /** One row per run from the Worker, folded into the cells here: the arithmetic
   *  is the bot's, the Worker only reads its rows and the parents outside them. */
  async usage(query: RunUsageQuery): Promise<RunUsageReport> {
    return await this.read(
      "/runs/usage",
      {
        storeKey: this.opts.storeKey,
        sinceMs: query.sinceMs,
        untilMs: query.untilMs,
      },
      async (data): Promise<RunUsageReport> => {
        if (!isRunUsageRows(data)) throw new PermanentStoreError("run store /runs/usage returned malformed usage rows");
        return reportOfUsageRows(data);
      },
    );
  }

  private read<O extends RunStoreRoute, T>(
    path: O,
    payload: StorageOperationBody<O>,
    receive: (data: Record<string, unknown>) => Promise<T>,
  ) {
    return this.post(path, payload, undefined, "read", undefined, receive);
  }

  /** POST a JSON body and classify the outcome. The body is a STRING; the
   *  runtime sets its numeric Content-Length (never hand-set — see header). */
  private async post<O extends StorageOperation, T>(
    path: O,
    payload: StorageOperationBody<NoInfer<O>>,
    span: Span | undefined,
    kind: StoreOperationKind,
    acknowledgement: ((data: Record<string, unknown>) => boolean) | undefined,
    receive: (data: Record<string, unknown>) => Promise<T>,
  ): Promise<T> {
    const request = await prepareStorageRequest(path, payload);
    return storageTransport(
      request,
      {
        url: `${this.baseUrl}${path}`,
        headers: { "content-type": "application/json", authorization: `Bearer ${this.opts.token}` },
        signal: AbortSignal.timeout(RUN_STORE_TIMEOUT_MS),
        timeoutMs: RUN_STORE_TIMEOUT_MS,
        fetch: this.fetchImpl,
        span,
        kind,
        onFailure: this.opts.onFailure,
        transportError: (err) =>
          kind === "write"
            ? new UncertainStoreError(`run store ${path}: transport outcome unknown`, request, { cause: err })
            : new TransientStoreError(`run store ${path}: ${describeError(err)}`),
      },
      async (res) => {
        if (!res.ok) {
          const message = `run store ${path} HTTP ${res.status}${await errorSuffix(res)}`;
          if (res.status === 404) throw new RouteMissingError(message);
          if (res.status >= 500 || res.status === 408 || res.status === 429) {
            if (kind === "write") throw new UncertainStoreError(message, request);
            throw new TransientStoreError(message);
          }
          throw new PermanentStoreError(message);
        }
        const data = await readStoreResponse(res, kind, request);
        if (acknowledgement && !acknowledgement(data))
          throw new UncertainStoreError(`run store ${path}: invalid acknowledgement`, request);
        return receive(data);
      },
    );
  }
}

/** Drop undefined fields so the wire body carries only what was asked. */
function compact<T extends object>(o: T): Partial<T> {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as Partial<T>;
}
