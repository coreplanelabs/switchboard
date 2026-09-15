import { defineConfig } from "vitest/config";

// Plain-Node tests only (no workerd): the deploy preflight, the pure GC
// decision logic (gc.ts), the instance arithmetic, and the scans over the
// sources — for the module boundary the Workflows binding depends on
// (refresh.test.ts), for the order of the instance step's gates and its
// in-flight count (instanceStep.test.ts), for the absence of any
// lifecycle timer (lifecycle.test.ts), and for the runtime-unreachable
// counter and its escalation ladder (runtimeUnreachable.test.ts), and for the
// reuse-only attach path and the container identity (reuseAttach.test.ts), and
// for the in-place rebind onto the thread's own pull request branch
// (rebindAttach.test.ts);
// testing/sourceScan.ts is their helper.
// worker.ts itself is covered by typecheck + the [agent] receipts in
// docs/reference/specs/resident-repos.md. Also a project of the root
// vitest.config.ts (`--project worker-resident`).
export default defineConfig({
  test: {
    name: "worker-resident",
    include: [
      "preflight.test.mjs",
      "gc.test.ts",
      "instanceSizing.test.ts",
      "refresh.test.ts",
      "instanceStep.test.ts",
      "lifecycle.test.ts",
      "runtimeUnreachable.test.ts",
      "reuseAttach.test.ts",
      "rebindAttach.test.ts",
    ],
  },
});
