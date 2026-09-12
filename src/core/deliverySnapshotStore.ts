import { REPO_SLUG, type DeliveryRange, type PullRequestFacts } from "./delivery.js";
import { errorSuffix } from "./workerError.js";

// Where a repository's delivery snapshot lives (docs/reference/specs/delivery.md item 10):
// the merged pull requests' facts over the snapshot window, as GitHub gave
// them, and when they were read. Two implementations of one seam (AGENTS.md
// invariant 2):
//
// - `WorkerDeliverySnapshotStore` — the production choice — an HTTPS client
//   to the `DeliveryDO` on the state Worker (deploy/cloudflare-memory/, one
//   SQLite Durable Object, the same MEMORY_TOKEN bearer as memory, run history
//   and the schedule store), so a bot restart keeps the snapshot (invariant 6)
//   and the first request after one is served, not computed.
// - `InMemoryDeliverySnapshotStore` — tests, and the process without a state
//   Worker: the snapshot lives as long as the process does.
//
// Node-free on purpose: the state Worker imports `isDeliverySnapshot` by
// relative path so the bot and the Worker validate ONE shape.
//
// Route contract (JSON in/out, bearer = the Worker's MEMORY_TOKEN):
//   POST /delivery/get {repo}      → {snapshot: DeliverySnapshot | null}
//   POST /delivery/put {snapshot}  → {ok: true, prs}

/** One repository's facts as a source assembled them, and when. */
export interface DeliverySnapshot {
  /** `owner/name`. */
  repo: string;
  /** ISO 8601 — when the read from GitHub began. */
  snapshotAt: string;
  /** The window the facts were read for: Monday-start weeks ending on the snapshot day. */
  range: DeliveryRange;
  /** Every pull request merged inside the window that the read reached. */
  prs: PullRequestFacts[];
  /** The listing stopped at its page cap before the window's start — the newest pull requests only. */
  truncated: boolean;
  /** ISO 8601 — every pull request merged at or after this instant is in `prs`: the window's
   *  start on a complete read, the oldest update the capped listing reached otherwise. */
  completeFrom: string;
}

const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;
const isInstant = (v: unknown): v is string => typeof v === "string" && Number.isFinite(Date.parse(v));

/** The fields the arithmetic reads, present and of the right kind; the arrays' rows are the source's. */
export function isPullRequestFacts(v: unknown): v is PullRequestFacts {
  if (typeof v !== "object" || v === null) return false;
  const p = v as Record<string, unknown>;
  return (
    typeof p.number === "number" &&
    Number.isFinite(p.number) &&
    typeof p.title === "string" &&
    typeof p.author === "string" &&
    isInstant(p.createdAt) &&
    isInstant(p.mergedAt) &&
    (p.firstHeadSha === undefined || typeof p.firstHeadSha === "string") &&
    Array.isArray(p.ci) &&
    Array.isArray(p.reviews) &&
    Array.isArray(p.pushes) &&
    (p.issue === undefined || (typeof p.issue === "object" && p.issue !== null))
  );
}

export function isDeliverySnapshot(v: unknown): v is DeliverySnapshot {
  if (typeof v !== "object" || v === null) return false;
  const s = v as Record<string, unknown>;
  if (typeof s.repo !== "string" || !REPO_SLUG.test(s.repo)) return false;
  if (!isInstant(s.snapshotAt) || !isInstant(s.completeFrom)) return false;
  if (typeof s.truncated !== "boolean") return false;
  const range = s.range as Record<string, unknown> | null | undefined;
  if (
    typeof range !== "object" ||
    range === null ||
    typeof range.since !== "string" ||
    !ISO_DAY.test(range.since) ||
    typeof range.until !== "string" ||
    !ISO_DAY.test(range.until) ||
    typeof range.weeks !== "number" ||
    !Number.isFinite(range.weeks)
  )
    return false;
  return Array.isArray(s.prs) && s.prs.every(isPullRequestFacts);
}

export interface DeliverySnapshotStore {
  /** The repository's stored snapshot, or undefined when none was ever stored. Throws on failure. */
  get(repo: string): Promise<DeliverySnapshot | undefined>;
  /** Replace the repository's snapshot. Throws on failure; callers warn, never crash. */
  put(snapshot: DeliverySnapshot): Promise<void>;
}

export class InMemoryDeliverySnapshotStore implements DeliverySnapshotStore {
  private readonly byRepo = new Map<string, DeliverySnapshot>();

  async get(repo: string): Promise<DeliverySnapshot | undefined> {
    const s = this.byRepo.get(repo);
    return s ? structuredClone(s) : undefined;
  }

  async put(snapshot: DeliverySnapshot): Promise<void> {
    this.byRepo.set(snapshot.repo, structuredClone(snapshot));
  }
}

/** Per-request ceiling: a snapshot of a busy repository is a few MB each way. */
export const SNAPSHOT_WORKER_TIMEOUT_MS = 30_000;

export interface WorkerDeliverySnapshotStoreOptions {
  /** Base URL of the state Worker. */
  baseUrl: string;
  /** Bearer secret (MEMORY_TOKEN on the Worker). */
  token: string;
  /** Injectable for tests; defaults to global fetch. */
  fetch?: typeof fetch;
}

export class WorkerDeliverySnapshotStore implements DeliverySnapshotStore {
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly opts: WorkerDeliverySnapshotStoreOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/+$/, "");
    this.fetchImpl = opts.fetch ?? fetch;
  }

  async get(repo: string): Promise<DeliverySnapshot | undefined> {
    const res = await this.post("/delivery/get", { repo });
    if (!res.ok) throw new Error(`state Worker /delivery/get HTTP ${res.status}${await errorSuffix(res)}`);
    const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (data.snapshot === null || data.snapshot === undefined) return undefined;
    if (!isDeliverySnapshot(data.snapshot))
      throw new Error(`state Worker /delivery/get: the answer for ${repo} is not a delivery snapshot`);
    return data.snapshot;
  }

  async put(snapshot: DeliverySnapshot): Promise<void> {
    const res = await this.post("/delivery/put", { snapshot });
    if (!res.ok) throw new Error(`state Worker /delivery/put HTTP ${res.status}${await errorSuffix(res)}`);
  }

  private post(path: string, body: unknown): Promise<Response> {
    return this.fetchImpl(`${this.baseUrl}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${this.opts.token}` },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(SNAPSHOT_WORKER_TIMEOUT_MS),
    });
  }
}

/** A `{ baseUrl, tokenEnv? }` reference to the state Worker, as every `*.worker` config block spells it. */
export interface StateWorkerRef {
  baseUrl: string;
  /** Env var holding the bearer; default MEMORY_TOKEN. */
  tokenEnv?: string;
}

/** The config blocks that may name the state Worker — one Worker, referenced from each capability that uses it. */
export interface StateWorkerBlocks {
  runtimeOverrides?: { worker?: StateWorkerRef };
  runHistory?: { worker?: StateWorkerRef };
  schedules?: { worker?: StateWorkerRef };
  memory?: { worker?: StateWorkerRef };
}

const DEFAULT_TOKEN_ENV = "MEMORY_TOKEN";

/** The slice of the process's `Secrets` the builder reads (src/secrets.ts; named
 *  structurally so this module stays free of the bot's Node-only imports for the Worker). */
export interface SecretReader {
  named(name: string): { reveal(): string } | undefined;
}

/** Process-startup store selection (src/index.ts, the CLI): the Worker store
 *  behind whichever `*.worker` block names the state Worker — the snapshot is
 *  a cache, so it earns no block of its own — else the in-memory store with a
 *  warning naming what a restart then costs. Pure w.r.t. the environment. */
export function buildDeliverySnapshotStore(
  config: StateWorkerBlocks,
  secrets: SecretReader,
  warn: (message: string) => void,
): DeliverySnapshotStore {
  const worker = [config.runtimeOverrides, config.runHistory, config.schedules, config.memory].find(
    (block) => block?.worker?.baseUrl,
  )?.worker;
  if (!worker) {
    warn(
      "delivery snapshots are kept in memory — a restart loses them and the first request after one reads GitHub live. Name the state Worker (runHistory.worker, runtimeOverrides.worker, schedules.worker or memory.worker) to keep them on it.",
    );
    return new InMemoryDeliverySnapshotStore();
  }
  const tokenEnv = worker.tokenEnv ?? DEFAULT_TOKEN_ENV;
  const token = secrets.named(tokenEnv);
  if (!token) {
    warn(
      `the state Worker is configured but ${tokenEnv} is unset — delivery snapshots are kept in memory and a restart loses them. Set ${tokenEnv} to the state Worker's bearer.`,
    );
    return new InMemoryDeliverySnapshotStore();
  }
  return new WorkerDeliverySnapshotStore({ baseUrl: worker.baseUrl, token: token.reveal() });
}
