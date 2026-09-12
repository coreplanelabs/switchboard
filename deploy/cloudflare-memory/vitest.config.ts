import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

// Tests run INSIDE workerd against the real Durable Object + SQLite (FTS5
// included) — the same runtime as production, so what passes here is what
// runs. The bearer secret is a test binding; production uses `wrangler secret`.
export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.jsonc" },
      miniflare: {
        bindings: { MEMORY_TOKEN: "test-token" },
        // The bot Worker this Worker binds across scripts (wrangler.template.jsonc
        // `workflows`): in production the bot shim's `ShipCoordinator`; in the
        // pool a stub under the bot's script name, so the binding resolves in
        // process and the runtime starts. The tests never run an instance —
        // `runLedger.test.ts` doubles the binding on the live object.
        workers: [
          {
            name: "switchboard",
            modules: true,
            script:
              'import { WorkflowEntrypoint } from "cloudflare:workers";\n' +
              "export class ShipCoordinator extends WorkflowEntrypoint { async run() { return { stub: true }; } }\n" +
              'export default { fetch() { return new Response("bot stub"); } };\n',
            workflows: { SHIP_COORDINATOR: { name: "switchboard-ship-coordinator", className: "ShipCoordinator" } },
          },
        ],
      },
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
      "delivery.test.ts",
    ],
  },
});
