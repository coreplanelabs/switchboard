import { defineConfig } from "vitest/config";

// The bot suite is `src/**/*.test.ts` (AGENTS.md). Companion Workers under
// deploy/ carry their own vitest config (they run inside workerd via
// @cloudflare/vitest-pool-workers) and are excluded here — the root runner
// must not try to resolve `cloudflare:test`.
export default defineConfig({
  test: { include: ["src/**/*.test.ts"] },
});
