import { defineConfig } from "vitest/config";

// Only the deploy preflight is tested here — it is plain Node (no workerd).
// worker.ts is covered by typecheck + the [agent] receipts in
// features/resident-repos.md.
export default defineConfig({ test: { include: ["preflight.test.mjs"] } });
