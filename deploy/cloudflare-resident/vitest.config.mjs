import { defineConfig } from "vitest/config";

// Plain-Node tests only (no workerd): the deploy preflight and the pure GC
// decision logic (gc.ts). worker.ts itself is covered by typecheck + the
// [agent] receipts in features/resident-repos.md. Also a project of the root
// vitest.config.ts (`--project worker-resident`).
export default defineConfig({
  test: { name: "worker-resident", include: ["preflight.test.mjs", "gc.test.ts", "instanceSizing.test.ts"] },
});
