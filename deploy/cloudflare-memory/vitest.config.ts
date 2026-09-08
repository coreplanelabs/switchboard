import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

// Tests run INSIDE workerd against the real Durable Object + SQLite (FTS5
// included) — the same runtime as production, so what passes here is what
// runs. The bearer secret is a test binding; production uses `wrangler secret`.
export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.jsonc" },
      miniflare: { bindings: { MEMORY_TOKEN: "test-token" } },
    }),
  ],
  test: {
    include: [
      "worker.test.ts",
      "schedules.test.ts",
      "runs.test.ts",
      "config.test.ts",
      "runLedger.test.ts",
      "runTranscript.test.ts",
    ],
  },
});
