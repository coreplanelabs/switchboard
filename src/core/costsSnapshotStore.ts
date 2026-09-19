import type { BillerInvoices, CloudflareUsage, DateRange, LlmCostRow } from "./costs.js";
import { isRunUsageReport, type RunUsageReport } from "./runUsage.js";
import {
  DEFAULT_STATE_WORKER_TOKEN_ENV,
  STATE_WORKER_BLOCK_NAMES,
  stateWorkerOf,
  type SecretReader,
  type StateWorkerBlocks,
} from "./stateWorkerRef.js";
import { errorSuffix } from "./workerError.js";

// Where the costs snapshot lives (docs/reference/specs/costs.md item 6): the
// billing sources' answers over the page's widest range — Cloudflare's usage
// rows, Anthropic's daily cost rows, the run history's per-user usage — as the
// sources gave them, and when they were read. ONE snapshot per installation:
// the Cloudflare read is account-wide and the LLM rows carry every workspace,
// so every configured group's report is arithmetic over the same document.
// Two implementations of one seam (AGENTS.md invariant 2):
//
// - `WorkerCostsSnapshotStore` — the production choice — an HTTPS client to
//   the `CostsSnapshotDO` on the state Worker (deploy/cloudflare-memory/, one
//   SQLite Durable Object, the same MEMORY_TOKEN bearer as memory, run history
//   and the delivery snapshot), so a bot restart keeps the snapshot
//   (invariant 6) and the first request after one is served, not computed.
// - `InMemoryCostsSnapshotStore` — tests, and the process without a state
//   Worker: the snapshot lives as long as the process does.
//
// Node-free on purpose: the state Worker imports `isCostsSnapshot` by
// relative path so the bot and the Worker validate ONE shape.
//
// Route contract (JSON in/out, bearer = the Worker's MEMORY_TOKEN):
//   POST /costs/snapshot/get {}          → {snapshot: CostsSnapshot | null}
//   POST /costs/snapshot/put {snapshot}  → {ok: true}          replace the snapshot whole

/** The billing sources' answers over the snapshot window, and when they were read. */
export interface CostsSnapshot {
  /** ISO 8601 — when the read began. */
  takenAt: string;
  /** Who asked for it: `schedule` for the refresh loop, else the caller's label. */
  takenBy: string;
  /** How long the read took, both sources and the run history together. */
  durationMs: number;
  /** The window the rows were read for: `MAX_DAYS` UTC days ending on the take day. */
  range: DateRange;
  /** Every meter Cloudflare bills on, account-wide, as `CloudflareUsageSource` answered. */
  usage: CloudflareUsage;
  /** Anthropic's daily cost rows (the open days estimated); null when no LLM source is configured. */
  llm: LlmCostRow[] | null;
  /** The run history's per-user usage over the window; null with run history off. */
  runUsage: RunUsageReport | null;
  /** Each biller's invoice days over the window (item 4d); null when no invoice
   *  source is configured, absent on a snapshot taken before the field existed. */
  invoices?: BillerInvoices[] | null;
}

const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;
const isInstant = (v: unknown): v is string => typeof v === "string" && Number.isFinite(Date.parse(v));
const isFiniteNumber = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

/** The datasets every `CloudflareUsage` carries — the guard checks each is rows with a day. */
const USAGE_DATASETS = [
  "containers",
  "durableObjectRequests",
  "durableObjectDays",
  "durableObjectStorage",
  "workers",
  "r2Storage",
  "r2Operations",
  "workflows",
] as const;

function isDatedRows(v: unknown): boolean {
  return (
    Array.isArray(v) &&
    v.every((row) => typeof row === "object" && row !== null && ISO_DAY.test(String((row as { date?: unknown }).date)))
  );
}

function isDateRange(v: unknown): v is DateRange {
  if (typeof v !== "object" || v === null) return false;
  const r = v as Record<string, unknown>;
  return (
    typeof r.from === "string" &&
    ISO_DAY.test(r.from) &&
    typeof r.to === "string" &&
    ISO_DAY.test(r.to) &&
    isFiniteNumber(r.days) &&
    typeof r.partialLastDay === "boolean"
  );
}

function isLlmRows(v: unknown): v is LlmCostRow[] {
  return (
    Array.isArray(v) &&
    v.every((row) => {
      if (typeof row !== "object" || row === null) return false;
      const r = row as Record<string, unknown>;
      return (
        typeof r.date === "string" &&
        ISO_DAY.test(r.date) &&
        (r.workspaceId === null || typeof r.workspaceId === "string") &&
        isFiniteNumber(r.amountUsd)
      );
    })
  );
}

function isInvoices(v: unknown): v is BillerInvoices[] {
  return (
    Array.isArray(v) &&
    v.every((entry) => {
      if (typeof entry !== "object" || entry === null) return false;
      const e = entry as Record<string, unknown>;
      if (typeof e.biller !== "string" || !e.biller) return false;
      return (
        Array.isArray(e.days) &&
        e.days.every((row) => {
          if (typeof row !== "object" || row === null) return false;
          const r = row as Record<string, unknown>;
          if (typeof r.date !== "string" || !ISO_DAY.test(r.date) || !isFiniteNumber(r.amountUsd)) return false;
          if (r.byokUsd !== undefined && !isFiniteNumber(r.byokUsd)) return false;
          return r.estimated === undefined || typeof r.estimated === "boolean";
        })
      );
    })
  );
}

/** The fields the arithmetic reads, present and of the right kind; the rows are the sources'. */
export function isCostsSnapshot(v: unknown): v is CostsSnapshot {
  if (typeof v !== "object" || v === null) return false;
  const s = v as Record<string, unknown>;
  if (!isInstant(s.takenAt) || typeof s.takenBy !== "string") return false;
  if (!isFiniteNumber(s.durationMs) || s.durationMs < 0) return false;
  if (!isDateRange(s.range)) return false;
  const usage = s.usage as Record<string, unknown> | null | undefined;
  if (typeof usage !== "object" || usage === null) return false;
  if (!USAGE_DATASETS.every((name) => isDatedRows(usage[name]))) return false;
  if (s.llm !== null && !isLlmRows(s.llm)) return false;
  if (s.invoices !== undefined && s.invoices !== null && !isInvoices(s.invoices)) return false;
  return s.runUsage === null || isRunUsageReport(s.runUsage);
}

export interface CostsSnapshotStore {
  /** The stored snapshot, or undefined when none was ever stored. Throws on failure. */
  get(): Promise<CostsSnapshot | undefined>;
  /** Replace the snapshot whole. Throws on failure; callers warn, never crash. */
  put(snapshot: CostsSnapshot): Promise<void>;
}

export class InMemoryCostsSnapshotStore implements CostsSnapshotStore {
  private stored: CostsSnapshot | undefined;

  async get(): Promise<CostsSnapshot | undefined> {
    return this.stored ? structuredClone(this.stored) : undefined;
  }

  async put(snapshot: CostsSnapshot): Promise<void> {
    this.stored = structuredClone(snapshot);
  }
}

/** Per-request ceiling: a ninety-day snapshot is a few hundred KB each way. */
export const COSTS_SNAPSHOT_WORKER_TIMEOUT_MS = 30_000;

export interface WorkerCostsSnapshotStoreOptions {
  /** Base URL of the state Worker. */
  baseUrl: string;
  /** Bearer secret (MEMORY_TOKEN on the Worker). */
  token: string;
  /** Injectable for tests; defaults to global fetch. */
  fetch?: typeof fetch;
}

export class WorkerCostsSnapshotStore implements CostsSnapshotStore {
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly opts: WorkerCostsSnapshotStoreOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/+$/, "");
    this.fetchImpl = opts.fetch ?? fetch;
  }

  async get(): Promise<CostsSnapshot | undefined> {
    const res = await this.post("/costs/snapshot/get", {});
    if (!res.ok) throw new Error(`state Worker /costs/snapshot/get HTTP ${res.status}${await errorSuffix(res)}`);
    const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (data.snapshot === null || data.snapshot === undefined) return undefined;
    if (!isCostsSnapshot(data.snapshot))
      throw new Error("state Worker /costs/snapshot/get: the answer is not a costs snapshot");
    return data.snapshot;
  }

  async put(snapshot: CostsSnapshot): Promise<void> {
    const res = await this.post("/costs/snapshot/put", { snapshot });
    if (!res.ok) throw new Error(`state Worker /costs/snapshot/put HTTP ${res.status}${await errorSuffix(res)}`);
  }

  private post(path: string, body: unknown): Promise<Response> {
    return this.fetchImpl(`${this.baseUrl}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${this.opts.token}` },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(COSTS_SNAPSHOT_WORKER_TIMEOUT_MS),
    });
  }
}

/** Process-startup store selection (src/index.ts): the Worker store behind
 *  whichever `*.worker` block names the state Worker — the snapshot is a cache,
 *  so it earns no block of its own — else the in-memory store with a warning
 *  naming what a restart then costs. Pure w.r.t. the environment. */
export function buildCostsSnapshotStore(
  config: StateWorkerBlocks,
  secrets: SecretReader,
  warn: (message: string) => void,
): CostsSnapshotStore {
  const worker = stateWorkerOf(config);
  if (!worker) {
    warn(
      `the costs snapshot is kept in memory — a restart loses it and the costs page has nothing to show until the next one is taken. Name the state Worker (${STATE_WORKER_BLOCK_NAMES}) to keep it there.`,
    );
    return new InMemoryCostsSnapshotStore();
  }
  const tokenEnv = worker.tokenEnv ?? DEFAULT_STATE_WORKER_TOKEN_ENV;
  const token = secrets.named(tokenEnv);
  if (!token) {
    warn(
      `the state Worker is configured but ${tokenEnv} is unset — the costs snapshot is kept in memory and a restart loses it. Set ${tokenEnv} to the state Worker's bearer.`,
    );
    return new InMemoryCostsSnapshotStore();
  }
  return new WorkerCostsSnapshotStore({ baseUrl: worker.baseUrl, token: token.reveal() });
}
