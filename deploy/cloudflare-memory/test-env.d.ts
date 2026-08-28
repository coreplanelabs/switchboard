import type { Env } from "./worker.ts";

declare module "cloudflare:test" {
  // Typed `env` in tests = the Worker's own bindings (MEMORY namespace + secret).
  interface ProvidedEnv extends Env {}
}
