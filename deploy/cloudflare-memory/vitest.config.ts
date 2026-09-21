import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

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
    // Fail a request that really hangs under its own Vitest case before
    // workerd's later hang detector can cancel a neighbouring case. Keep
    // console writes out of Vitest's cross-DO RPC queue so teardown cannot
    // strand an `onUserConsoleLog` call after the cases have settled.
    testTimeout: 5_000,
    disableConsoleIntercept: true,
    setupFiles: ["./testSetup.ts"],
    // One workerd runs every file: in parallel, the shrink test's 500-row
    // delete loop (~17 s of DO work) queues the other files' requests past
    // vitest's 5 s default and fails tests the change never touched. Serial
    // files trade some wall time (23 s measured serial, against a 26 s wall
    // holding 63 s of contended work) for a deterministic suite — contention,
    // not correctness, was the only failure shape.
    fileParallelism: false,
    include: [
      "worker.test.ts",
      "schedules.test.ts",
      "runs.test.ts",
      "config.test.ts",
      "runLedger.test.ts",
      "runTranscript.test.ts",
      "sessionLog.test.ts",
      "delivery.test.ts",
      "costs.test.ts",
    ],
  },
});
