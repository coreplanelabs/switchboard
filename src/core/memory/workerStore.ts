import type { MemoryCandidate, MemoryQuery, MemoryRecord, MemoryStore } from "./types.js";
import { tracedFetch } from "../trace/tracedFetch.js";
import type { Span, TraceOptions } from "../trace/types.js";

// The durable MemoryStore: an HTTPS client to the Memory Worker
// (deploy/cloudflare-memory/ — one SQLite-backed Durable Object per scopeKey,
// FTS5 candidate match, ranking + write plan from the shared engine.ts). This
// mirrors ResidentExecutor's remote-plane-over-HTTPS pattern: the core sees the
// MemoryStore interface, the fetch client lives at this boundary, and durable
// state lives OFF the bot host (AGENTS.md invariant 6 — a bot restart loses
// nothing). Route contracts (JSON in/out, bearer MEMORY_TOKEN):
//   POST /retrieve {scopeKey, query, limit} → {records: MemoryRecord[]}
//   POST /write    {scopeKey, records: MemoryCandidate[], cap?} → {ok, inserted, deduped, superseded, evicted}
//   POST /list     {scopeKey, limit, query?} → {records: MemoryRecord[]}  (human controls)
//   POST /forget   {scopeKey, id} → {ok, forgotten: boolean}

/** Per-request ceiling. Retrieval sits on the critical path of every model
 *  turn, so a hung Worker must degrade to "no memory" quickly, never stall the
 *  reply. */
export const MEMORY_WORKER_TIMEOUT_MS = 5_000;

/** Belt-and-suspenders clamp on the retrieve `query`. The Worker rejects a
 *  query over its MAX_QUERY_CHARS (4000) cap with a 400, which degrades
 *  retrieval to "no memory". Clamping just under that cap here means no caller
 *  can ever overrun it, whatever it passes. Retrieval only tokenizes the query
 *  for an FTS prefilter, so the tail we drop is not needed. */
const MAX_RETRIEVE_QUERY_CHARS = 3900;

export interface WorkerMemoryStoreOptions {
  /** Base URL of the Memory Worker (e.g. https://switchboard-memory.example.com). */
  baseUrl: string;
  /** Bearer secret (MEMORY_TOKEN on the Worker). */
  token: string;
  /** Per-scope cap on active records, sent on every /write; absent →
   *  the Worker's own default. */
  cap?: number;
  /** Injectable for tests; defaults to global fetch. */
  fetch?: typeof fetch;
  /** Receives one line per degraded retrieval (default: console.warn). */
  onWarn?: (message: string) => void;
}

/** The Worker's routes, as a span names them. */
type MemoryRoute = "/retrieve" | "/write" | "/list" | "/forget";

export class WorkerMemoryStore implements MemoryStore {
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly warn: (m: string) => void;

  constructor(private readonly opts: WorkerMemoryStoreOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/+$/, "");
    this.fetchImpl = opts.fetch ?? fetch;
    this.warn = opts.onWarn ?? ((m) => console.warn(`[memory] ${m}`));
  }

  /** Memory is advisory context: any failure here (HTTP error, bad body,
   *  transport, timeout) degrades to "nothing remembered" with a warning — it
   *  must never fail or delay the run beyond the timeout. */
  async retrieve(q: MemoryQuery, trace?: TraceOptions): Promise<MemoryRecord[]> {
    // Clamp the query under the Worker's cap so no caller can 400 this retrieve
    // into a "no memory" degrade (see MAX_RETRIEVE_QUERY_CHARS).
    const query = q.query.length > MAX_RETRIEVE_QUERY_CHARS ? q.query.slice(0, MAX_RETRIEVE_QUERY_CHARS) : q.query;
    let res: Response;
    try {
      res = await this.post("/retrieve", { ...q, query }, trace?.span);
    } catch (err) {
      this.warn(
        `worker /retrieve failed (${err instanceof Error ? err.message : String(err)}); continuing without memory`,
      );
      return [];
    }
    const data = await parseBody(res);
    if (!res.ok) {
      this.warn(
        `worker /retrieve HTTP ${res.status}${data.error ? ` (${String(data.error)})` : ""}; continuing without memory`,
      );
      return [];
    }
    if (!Array.isArray(data.records)) {
      this.warn("worker /retrieve returned no records array; continuing without memory");
      return [];
    }
    return data.records.filter(isMemoryRecord);
  }

  /** Writes come from the background reflection pass, which catches and warns;
   *  so a failure here is thrown with enough detail to diagnose. */
  async write(scopeKey: string, records: MemoryCandidate[]): Promise<void> {
    if (records.length === 0) return;
    const res = await this.post("/write", {
      scopeKey,
      records,
      ...(this.opts.cap !== undefined ? { cap: this.opts.cap } : {}),
    });
    if (!res.ok) {
      const data = await parseBody(res);
      throw new Error(`memory worker /write HTTP ${res.status}${data.error ? `: ${String(data.error)}` : ""}`);
    }
  }

  /** Human command: failures THROW — a person asked to see the list, so
   *  an empty reply on error would be a lie; the command layer renders ⚠️. */
  async list(scopeKey: string, limit: number, query?: string): Promise<MemoryRecord[]> {
    const res = await this.post("/list", { scopeKey, limit, ...(query !== undefined ? { query } : {}) });
    const data = await parseBody(res);
    if (!res.ok)
      throw new Error(`memory worker /list HTTP ${res.status}${data.error ? `: ${String(data.error)}` : ""}`);
    return Array.isArray(data.records) ? data.records.filter(isMemoryRecord) : [];
  }

  /** Human command: resolves the Worker's `forgotten` flag; throws on a non-2xx. */
  async forget(scopeKey: string, id: string): Promise<boolean> {
    const res = await this.post("/forget", { scopeKey, id });
    const data = await parseBody(res);
    if (!res.ok)
      throw new Error(`memory worker /forget HTTP ${res.status}${data.error ? `: ${String(data.error)}` : ""}`);
    return data.forgotten === true;
  }

  /** One `http.client` span under `span` when the caller has one (the
   *  dispatcher's `dispatch.memory_read`; docs/reference/specs/tracing.md item 24), the
   *  route being the path literal; the plain fetch otherwise. */
  private post(path: MemoryRoute, body: unknown, span?: Span): Promise<Response> {
    return tracedFetch(
      span,
      `${this.baseUrl}${path}`,
      {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${this.opts.token}` },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(MEMORY_WORKER_TIMEOUT_MS),
      },
      { route: path, fetchImpl: this.fetchImpl },
    );
  }
}

/** Tolerant body parse (same shape as the resident client): a non-JSON body —
 *  an edge error page — reads as {} and the caller falls back to the status. */
async function parseBody(res: Response): Promise<Record<string, unknown>> {
  const text = await res.text();
  try {
    const parsed: unknown = JSON.parse(text.trim() || "{}");
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

/** Structural check on a record coming back over the wire — the Worker is
 *  trusted but a mangled row must not become injected context. */
function isMemoryRecord(v: unknown): v is MemoryRecord {
  if (typeof v !== "object" || v === null) return false;
  const r = v as Record<string, unknown>;
  return (
    typeof r.id === "string" &&
    typeof r.scopeKey === "string" &&
    (r.kind === "fact" || r.kind === "summary") &&
    typeof r.text === "string" &&
    Array.isArray(r.keywords) &&
    typeof r.sourceThreadKey === "string" &&
    typeof r.createdAt === "number" &&
    typeof r.useCount === "number" &&
    (r.status === "active" || r.status === "superseded" || r.status === "forgotten" || r.status === "evicted")
  );
}
