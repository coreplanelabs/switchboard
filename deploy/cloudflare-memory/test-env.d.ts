import type { Env as WorkerEnv } from "./worker.ts";

declare module "cloudflare:test" {
  // Typed `env` in tests = the Worker's own bindings (MEMORY namespace + secret).
  // eslint-disable-next-line @typescript-eslint/no-empty-object-type -- augmentation by inheritance is the intended shape
  interface ProvidedEnv extends WorkerEnv {}
}

declare global {
  namespace Cloudflare {
    // This version of @cloudflare/vitest-pool-workers types `env` as
    // `Cloudflare.Env` (the wrangler-typegen convention), not ProvidedEnv —
    // extend it too so tests see the Worker's own bindings.
    // eslint-disable-next-line @typescript-eslint/no-empty-object-type -- augmentation by inheritance is the intended shape
    interface Env extends WorkerEnv {}
  }
}
