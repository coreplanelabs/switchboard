import { defineConfig } from "vitest/config";

// One vitest entry for the whole workspace. Each project keeps its own config
// (root, environment, plugins) so `npm test -w <path>` inside a package is
// unchanged; from the root, `npx vitest run <filter>` searches every project
// at once (`--project bot|web|worker-bot|worker-resident` narrows to one;
// `--changed origin/main` runs what a branch's diff reaches). The memory
// Worker is NOT a project here: it runs inside workerd on
// @cloudflare/vitest-pool-workers, which pins vitest 4 — `npm test -w
// deploy/cloudflare-memory` is its entry. Nor is the npm package: its tests
// need the package BUILT (the smoke test installs the packed tarball), which
// `npm run verify -w packages/switchboard` and CI's `package` job do first and
// the root shards never would. src/vitestWorkspace.test.ts holds the list to
// the workspaces.
// CI runs this same entry as N shards, one job each: `npm test -- --shard=i/N`
// splits the projects' files across the shards (.github/workflows/ci.yml).
export default defineConfig({
  test: {
    projects: [
      { test: { name: "bot", include: ["src/**/*.test.ts"] } },
      "./web/vite.config.ts",
      "./deploy/cloudflare/vitest.config.mjs",
      "./deploy/cloudflare-resident/vitest.config.mjs",
    ],
  },
});
