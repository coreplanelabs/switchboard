import { defineConfig } from "vitest/config";

// Plain-Node tests only (no workerd): the deploy preflight's pure decision
// logic. worker.ts itself is covered by typecheck + the live receipts in the
// feature files. Also a project of the root vitest.config.ts (`--project
// worker-bot`).
export default defineConfig({ test: { name: "worker-bot", include: ["preflight.test.mjs"] } });
