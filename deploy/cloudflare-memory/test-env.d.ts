import type { Env as WorkerEnv } from "./worker.ts";

declare module "cloudflare:test" {
  // Typed `env` in tests = the Worker's own bindings (MEMORY namespace + secret).
  interface ProvidedEnv extends WorkerEnv {}
}

declare global {
  namespace Cloudflare {
    // This version of @cloudflare/vitest-pool-workers types `env` as
    // `Cloudflare.Env` (the wrangler-typegen convention), not ProvidedEnv —
    // extend it too so tests see the Worker's own bindings.
    interface Env extends WorkerEnv {}
  }
}
