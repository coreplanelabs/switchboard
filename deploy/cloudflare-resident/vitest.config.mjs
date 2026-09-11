import { defineConfig } from "vitest/config";

// Plain-Node tests only (no workerd): the deploy preflight, the pure GC
// decision logic (gc.ts), the instance arithmetic, and a scan over the sources
// for the module boundary the Workflows binding depends on (refresh.test.ts)
// and for the order of the instance step's gates and its in-flight count
// (instanceStep.test.ts).
// worker.ts itself is covered by typecheck + the [agent] receipts in
// docs/reference/specs/resident-repos.md. Also a project of the root
// vitest.config.ts (`--project worker-resident`).
export default defineConfig({
  test: {
    name: "worker-resident",
    include: ["preflight.test.mjs", "gc.test.ts", "instanceSizing.test.ts", "refresh.test.ts", "instanceStep.test.ts"],
  },
});
