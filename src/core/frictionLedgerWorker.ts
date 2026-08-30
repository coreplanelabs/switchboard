import { join } from "node:path";
import { FileFrictionLedger, type FrictionLedger, type LedgerReadOptions } from "./frictionLedger.js";
import { isFrictionRunRecord, type FrictionRunRecord } from "./frictionProposals.js";
import type { SelfImprovementConfig } from "./selfImprovement.js";

// The DURABLE FrictionLedger (Area 7b / #84 follow-up): an HTTPS client to the
// FrictionDO hosted on the state Worker (deploy/cloudflare-memory/ — one
// SQLite-backed Durable Object per ledger key), so the ledger survives bot
// restarts and redeploys (AGENTS.md invariant 6). Mirrors WorkerMemoryStore:
// the core sees the FrictionLedger interface, the fetch client lives at this
// boundary, durable state lives OFF the bot host. Route contract (JSON in/out,
// bearer = the Worker's MEMORY_TOKEN):
//   POST /friction/record {ledgerKey, record: FrictionRunRecord} → {ok:true}
//   POST /friction/recent {ledgerKey, limit?, sinceMs?}          → {records: FrictionRunRecord[]}

/** Per-request ceiling: `record` is fire-and-forget after a run and `recent`
 *  answers a chat command — neither may hang the process. */
export const FRICTION_WORKER_TIMEOUT_MS = 10_000;
/** Env var holding the state Worker bearer when `selfImprovement.worker.tokenEnv` is unset. */
export const DEFAULT_FRICTION_TOKEN_ENV = "MEMORY_TOKEN";
/** Ledger file name under the data dir when no Worker is configured. */
export const FRICTION_LEDGER_FILE = "friction.jsonl";

export interface WorkerFrictionLedgerOptions {
  /** Base URL of the state Worker (e.g. https://switchboard-memory.coreplanelabs.dev). */
  baseUrl: string;
  /** Bearer secret (MEMORY_TOKEN on the Worker). */
  token: string;
  /** Which ledger on the Worker — the Durable Object name (`friction:<repo>`). */
  ledgerKey: string;
  /** Injectable for tests; defaults to global fetch. */
  fetch?: typeof fetch;
}

export class WorkerFrictionLedger implements FrictionLedger {
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly opts: WorkerFrictionLedgerOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/+$/, "");
    this.fetchImpl = opts.fetch ?? fetch;
  }

  /** Throws on any failure: the dispatcher's caller logs a `[friction]` warning
   *  and the run is unaffected. */
  async record(rec: FrictionRunRecord): Promise<void> {
    const res = await this.post("/friction/record", { ledgerKey: this.opts.ledgerKey, record: rec });
    if (!res.ok) throw new Error(`friction worker /record HTTP ${res.status}${await errorSuffix(res)}`);
  }

  /** Throws on any failure: the friction commands turn it into a ⚠️ reply. */
  async recent(opts: LedgerReadOptions = {}): Promise<FrictionRunRecord[]> {
    const res = await this.post("/friction/recent", { ledgerKey: this.opts.ledgerKey, ...opts });
    if (!res.ok) throw new Error(`friction worker /recent HTTP ${res.status}${await errorSuffix(res)}`);
    const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (!Array.isArray(data.records)) throw new Error("friction worker /recent returned no records array");
    return data.records
      .filter(isFrictionRunRecord)
      .sort((a, b) => a.finishedAt - b.finishedAt || a.runId.localeCompare(b.runId));
  }

  private post(path: string, body: unknown): Promise<Response> {
    return this.fetchImpl(`${this.baseUrl}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${this.opts.token}` },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(FRICTION_WORKER_TIMEOUT_MS),
    });
  }
}

/** `: <error>` from a JSON `{error}` body, or empty — shared by every state-Worker client. */
export async function errorSuffix(res: Response): Promise<string> {
  const text = await res.text().catch(() => "");
  try {
    const parsed = JSON.parse(text) as { error?: unknown };
    return parsed?.error ? `: ${String(parsed.error)}` : "";
  } catch {
    return "";
  }
}

/**
 * Process-startup ledger selection (src/index.ts). Runs are ALWAYS recorded —
 * the ledger exists whether or not `selfImprovement` is configured:
 * - `selfImprovement.worker` configured and its bearer present → the durable
 *   `WorkerFrictionLedger`, keyed `friction:<repo>` (or `friction:default`).
 * - otherwise → the JSONL `FileFrictionLedger` under `dataDir`, with a warning:
 *   on an ephemeral-disk deploy (Cloudflare Containers) a redeploy starts it over.
 * Pure w.r.t. the environment (`env` is passed in), so it is unit-testable.
 */
export function buildFrictionLedger(
  cfg: SelfImprovementConfig | undefined,
  env: Record<string, string | undefined>,
  deps: { dataDir: string; warn: (message: string) => void },
): FrictionLedger {
  const filePath = cfg?.ledgerPath ?? join(deps.dataDir, FRICTION_LEDGER_FILE);
  const worker = cfg?.worker;
  if (!worker?.baseUrl) {
    deps.warn(
      `friction ledger at ${filePath} on the host disk — lost with the instance on ephemeral-disk deploys. ` +
        "Configure selfImprovement.worker.baseUrl (+ its bearer) for a durable ledger.",
    );
    return new FileFrictionLedger(filePath, { max: cfg?.ledgerMax });
  }
  const tokenEnv = worker.tokenEnv ?? DEFAULT_FRICTION_TOKEN_ENV;
  const token = env[tokenEnv]?.trim();
  if (!token) {
    deps.warn(
      `selfImprovement.worker is configured but ${tokenEnv} is unset — using the host-disk ledger at ${filePath}. ` +
        `Set ${tokenEnv} to the state Worker's bearer for a durable ledger.`,
    );
    return new FileFrictionLedger(filePath, { max: cfg?.ledgerMax });
  }
  return new WorkerFrictionLedger({ baseUrl: worker.baseUrl, token, ledgerKey: `friction:${cfg?.repo ?? "default"}` });
}
