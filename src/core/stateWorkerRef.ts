// The one state Worker (deploy/cloudflare-memory/), as the config names it: any
// `*.worker` block may carry its base URL and the env var holding its bearer,
// and a capability that keeps a cache there (a delivery snapshot, a costs
// snapshot) reads whichever block names it — a cache earns no block of its own.
//
// Node-free on purpose: the snapshot stores that import this are shared with
// the Worker by relative path.

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

/** The env var holding the state Worker's bearer when a block names none. */
export const DEFAULT_STATE_WORKER_TOKEN_ENV = "MEMORY_TOKEN";

/** The slice of the process's `Secrets` a store builder reads (src/secrets.ts; named
 *  structurally so the builders stay free of the bot's Node-only imports for the Worker). */
export interface SecretReader {
  named(name: string): { reveal(): string } | undefined;
}

/** The first `*.worker` block that names the state Worker, in the order the blocks are listed above. */
export function stateWorkerOf(config: StateWorkerBlocks): StateWorkerRef | undefined {
  return [config.runtimeOverrides, config.runHistory, config.schedules, config.memory].find(
    (block) => block?.worker?.baseUrl,
  )?.worker;
}

/** The names a `*.worker` block may carry the state Worker under, for a warning that says where to put one. */
export const STATE_WORKER_BLOCK_NAMES = "runHistory.worker, runtimeOverrides.worker, schedules.worker or memory.worker";
