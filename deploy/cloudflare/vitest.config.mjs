import { defineConfig } from "vitest/config";

// Plain-Node tests only (no workerd): the deploy preflight's pure decision
// logic, the bucket step's (ensure-bucket.test.mjs), the artifact copy route
// over its injected bucket/fetch/pipe (artifactsCopy.test.ts), the scan over
// the sources for the module boundary the Workflows binding depends on
// (coordinator.test.ts), and the scan that holds the shim to forwarding the
// model proxy's paths blind (modelProxyForwarding.test.ts). The container start
// contract loads worker.ts with the SDK boundary mocked to call its actual
// fetch override. Live receipts cover the runtime. Also a project of the root
// vitest.config.ts (`--project worker-bot`).
export default defineConfig({
  test: {
    name: "worker-bot",
    include: [
      "preflight.test.mjs",
      "ensure-bucket.test.mjs",
      "artifactsCopy.test.ts",
      "prImages.test.ts",
      "depotCi.test.ts",
      "knownLength.test.ts",
      "containerStart.test.ts",
      "containerStartContract.test.ts",
      "coordinator.test.ts",
      "modelProxyForwarding.test.ts",
      "githubDoorForwarding.test.ts",
    ],
  },
});
