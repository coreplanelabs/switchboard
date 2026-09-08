import type { MemoryConfig, MemoryStore } from "./types.js";
import { DEFAULT_SCOPE_CAP } from "./engine.js";
import { InMemoryMemoryStore } from "./stores.js";
import { WorkerMemoryStore } from "./workerStore.js";

/** Env var holding the Memory Worker bearer when `memory.worker.tokenEnv` is unset. */
export const DEFAULT_MEMORY_TOKEN_ENV = "MEMORY_TOKEN";

/**
 * Process-startup store selection (src/index.ts). Exactly ONE instance is
 * built and shared by every channel, so what the reflection pass writes after
 * a run is what the next run reads.
 *
 * - memory disabled (default) → `undefined`; the dispatcher then selects a
 *   `NullMemoryStore` per request (zero behavior change).
 * - `memory.worker` configured and its bearer present → the durable
 *   `WorkerMemoryStore` (AGENTS.md invariant 6: survives restarts).
 * - otherwise → an in-process `InMemoryMemoryStore` with a startup warning: a
 *   restart loses it, so this is a dev/test configuration, never prod.
 *
 * Pure w.r.t. the environment: `env` is passed in, so it is unit-testable.
 */
/** Largest cap the Memory Worker accepts on `/write` (mirrors its MAX_SCOPE_CAP). */
export const MAX_SCOPE_CAP = 10_000;

/** `memory.maxRecordsPerScope` → the cap every store gets: an integer in
 *  [1, MAX_SCOPE_CAP], else a warning and DEFAULT_SCOPE_CAP. */
export function resolveScopeCap(configured: number | undefined, warn: (message: string) => void): number {
  if (configured === undefined) return DEFAULT_SCOPE_CAP;
  if (Number.isInteger(configured) && configured >= 1 && configured <= MAX_SCOPE_CAP) return configured;
  warn(
    `memory.maxRecordsPerScope must be an integer between 1 and ${MAX_SCOPE_CAP} (got ${String(configured)}) — using the default ${DEFAULT_SCOPE_CAP}.`,
  );
  return DEFAULT_SCOPE_CAP;
}

export function buildMemoryStore(
  cfg: MemoryConfig | undefined,
  env: Record<string, string | undefined>,
  warn: (message: string) => void,
): MemoryStore | undefined {
  if (!cfg?.enabled) return undefined;
  // Per-scope cap: the same value reaches every store so the in-process
  // fallback and the durable Worker enforce one limit. Validated here, once:
  // 0 would evict everything on each write and >MAX would make the Worker 400
  // every write — either is a config typo, so warn and use the default.
  const cap = resolveScopeCap(cfg.maxRecordsPerScope, warn);
  const worker = cfg.worker;
  if (!worker?.baseUrl) {
    warn(
      "memory is enabled with no memory.worker configured — using an IN-PROCESS store that a restart loses. " +
        "Configure memory.worker.baseUrl (+ its bearer) for durable memory.",
    );
    return new InMemoryMemoryStore([], { cap });
  }
  const tokenEnv = worker.tokenEnv ?? DEFAULT_MEMORY_TOKEN_ENV;
  const token = env[tokenEnv]?.trim();
  if (!token) {
    warn(
      `memory.worker is configured but ${tokenEnv} is unset — using an IN-PROCESS store that a restart loses. ` +
        `Set ${tokenEnv} to the Memory Worker's bearer for durable memory.`,
    );
    return new InMemoryMemoryStore([], { cap });
  }
  return new WorkerMemoryStore({ baseUrl: worker.baseUrl, token, cap });
}
