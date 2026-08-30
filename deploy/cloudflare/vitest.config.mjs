import { defineConfig } from "vitest/config";

// Plain-Node tests only (no workerd): the deploy preflight's pure decision
// logic. worker.ts itself is covered by typecheck + the live receipts in the
// feature files.
export default defineConfig({ test: { include: ["preflight.test.mjs"] } });
