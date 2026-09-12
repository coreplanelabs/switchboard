// The parent ship records (docs/reference/specs/run-history.md item 49): one
// seam, two implementations (docs/decisions/0001-seams-with-two-implementations.md).
// A coordinator instance's record — the requester, channel, thread, repository
// and branch every child of the instance acts as — is written by the bot at
// the instance's creation and read by the coordinator's spawn route, so no
// step ever takes an actor from its caller. It must outlive the bot process
// (the coordinator exists to survive bot deaths), so production is the state
// Worker's `coordinator_instances` table behind an HTTPS client; tests and a
// process without a Worker-backed run history get the in-memory double or the
// null store, which knows no instance and refuses every write by name.

import type { Secrets } from "../../secrets.js";
import type { RunHistoryConfig } from "../runStore.js";
import { DEFAULT_RUN_STORE_TOKEN_ENV, RUN_STORE_KEY, RUN_STORE_TIMEOUT_MS } from "../runStoreWorker.js";
import { isCoordinatorInstance, type CoordinatorInstance } from "./contract.js";

/** `exists`: a different record already holds the id (an identical put is
 *  idempotent); `unavailable`: no durable store in this process. */
export type PutInstanceResult = { ok: true } | { ok: false; reason: "exists" | "unavailable" };

export interface CoordinatorInstanceStore {
  put(instance: CoordinatorInstance): Promise<PutInstanceResult>;
  get(id: string): Promise<CoordinatorInstance | null>;
}

export class InMemoryCoordinatorInstanceStore implements CoordinatorInstanceStore {
  private readonly rows = new Map<string, string>();
  async put(instance: CoordinatorInstance): Promise<PutInstanceResult> {
    const text = JSON.stringify(instance);
    const existing = this.rows.get(instance.id);
    if (existing !== undefined && existing !== text) return { ok: false, reason: "exists" };
    this.rows.set(instance.id, text);
    return { ok: true };
  }
  async get(id: string): Promise<CoordinatorInstance | null> {
    const text = this.rows.get(id);
    return text === undefined ? null : (JSON.parse(text) as CoordinatorInstance);
  }
}

/** The store of a process without a durable state Worker: no instance exists
 *  and none can be written, so every coordinator route answers by name. */
export class NullCoordinatorInstanceStore implements CoordinatorInstanceStore {
  async put(_instance: CoordinatorInstance): Promise<PutInstanceResult> {
    return { ok: false, reason: "unavailable" };
  }
  async get(_id: string): Promise<CoordinatorInstance | null> {
    return null;
  }
}

export interface WorkerCoordinatorInstanceStoreOptions {
  baseUrl: string;
  /** The state Worker's bearer (MEMORY_TOKEN). */
  token: string;
  /** The run-history object the records live beside (`runs:default`). */
  storeKey: string;
  fetch?: typeof fetch;
}

/** The state Worker's `coordinator_instances` table over
 *  `POST /runs/coordinator/put|get` — the same bearer, store key and timeout as
 *  the run store's client. An answer this client cannot read is thrown, never
 *  read as "no instance": a spawn on a guess would be a spawn nobody asked for. */
export class WorkerCoordinatorInstanceStore implements CoordinatorInstanceStore {
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly opts: WorkerCoordinatorInstanceStoreOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/+$/, "");
    this.fetchImpl = opts.fetch ?? fetch;
  }

  private async post(path: string, body: Record<string, unknown>): Promise<{ status: number; data: unknown }> {
    const res = await this.fetchImpl(`${this.baseUrl}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${this.opts.token}` },
      body: JSON.stringify({ storeKey: this.opts.storeKey, ...body }),
      signal: AbortSignal.timeout(RUN_STORE_TIMEOUT_MS),
    });
    if (!res.ok && res.status !== 409) throw new Error(`coordinator store ${path}: HTTP ${res.status}`);
    let data: unknown;
    try {
      data = await res.json();
    } catch {
      throw new Error(`coordinator store ${path}: non-JSON body (HTTP ${res.status})`);
    }
    return { status: res.status, data };
  }

  async put(instance: CoordinatorInstance): Promise<PutInstanceResult> {
    const r = await this.post("/runs/coordinator/put", { instance });
    const d = r.data as { ok?: unknown; reason?: unknown };
    if (r.status === 409 && d.reason === "exists") return { ok: false, reason: "exists" };
    if (d.ok === true) return { ok: true };
    throw new Error(`coordinator store /runs/coordinator/put: unexpected answer (HTTP ${r.status})`);
  }

  async get(id: string): Promise<CoordinatorInstance | null> {
    const r = await this.post("/runs/coordinator/get", { id });
    const d = r.data as { instance?: unknown };
    if (d.instance === null) return null;
    if (!isCoordinatorInstance(d.instance))
      throw new Error("coordinator store /runs/coordinator/get: the answer is not a coordinator instance");
    return d.instance;
  }
}

/** The store a process runs with: the Worker's for a Worker-backed run history
 *  with its bearer set (the same config and secret the run store reads), the
 *  null store otherwise — no history, a file store, a missing bearer. */
export function buildCoordinatorInstanceStore(
  cfg: RunHistoryConfig | undefined,
  secrets: Secrets,
  deps: { fetch?: typeof fetch } = {},
): CoordinatorInstanceStore {
  if (!cfg || cfg.store === "file") return new NullCoordinatorInstanceStore();
  const worker = cfg.worker;
  if (!worker?.baseUrl) return new NullCoordinatorInstanceStore();
  const token = secrets.named(worker.tokenEnv ?? DEFAULT_RUN_STORE_TOKEN_ENV);
  if (!token) return new NullCoordinatorInstanceStore(); // buildRunStore already warned
  return new WorkerCoordinatorInstanceStore({
    baseUrl: worker.baseUrl,
    token: token.reveal(),
    storeKey: RUN_STORE_KEY,
    ...(deps.fetch ? { fetch: deps.fetch } : {}),
  });
}
