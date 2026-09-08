import { defineConfig } from "vitest/config";

// The package's own tests: the asset selection (pure) and the smoke test, which
// packs the package, installs the tarball into a temp directory and runs the
// installed `switchboard` — a minute's budget, not vitest's five seconds.
export default defineConfig({
  test: {
    name: "package",
    include: ["*.test.mts"],
    testTimeout: 120_000,
    hookTimeout: 120_000,
  },
});
