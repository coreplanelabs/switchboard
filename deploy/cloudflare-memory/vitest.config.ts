import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";
import { MemoryDiagnosticsReporter } from "./testDiagnosticsReporter.ts";

// Tests run INSIDE workerd against the real Durable Object + SQLite (FTS5
// included) — the same runtime as production, so what passes here is what
// runs. The bearer secret is a test binding; production uses `wrangler secret`.
export default defineConfig({
  plugins: [
    cloudflareTest({
      // The test topology keeps every real SQLite Durable Object but omits the
      // optional cross-script service and Workflow bindings. Coordinator and
      // bot-delivery tests install synchronous doubles on their live object,
      // so no engine promise can escape one test and trip workerd's hang
      // detector during an unrelated later request.
      wrangler: { configPath: "./wrangler.test.jsonc" },
      miniflare: { bindings: { MEMORY_TOKEN: "test-token" } },
    }),
  ],
  test: {
    reporters: ["default", new MemoryDiagnosticsReporter()],
    // A new SQLite Durable Object can take seconds to start on Linux, and a
    // case may make several requests. Leave room for that cold start; the
    // diagnostic artifact names completed and pending requests if a case
    // actually stalls. Console interception remains off so cross-DO logs
    // cannot strand a teardown RPC.
    testTimeout: 15_000,
    disableConsoleIntercept: true,
    setupFiles: ["./testSetup.ts"],
    // The shrink case performs 500 SQLite deletes. Concurrent files can queue
    // unrelated Durable Object requests behind it, so keep files serial.
    fileParallelism: false,
    include: [
      "backgroundTasks.test.ts",
      "worker.test.ts",
      "schedules.test.ts",
      "runs.test.ts",
      "config.test.ts",
      "runLedger.test.ts",
      "inventory.test.ts",
      "harnessLaunch.test.ts",
      "runTranscript.test.ts",
      "sessionLog.test.ts",
      "sessionUnification.test.ts",
      "delivery.test.ts",
      "costs.test.ts",
    ],
  },
});
