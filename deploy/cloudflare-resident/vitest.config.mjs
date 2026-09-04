import { defineConfig } from "vitest/config";

// Plain-Node tests only (no workerd): the deploy preflight and the pure GC
// decision logic (gc.ts). worker.ts itself is covered by typecheck + the
// [agent] receipts in features/resident-repos.md.
export default defineConfig({ test: { include: ["preflight.test.mjs", "gc.test.ts", "instanceSizing.test.ts"] } });
