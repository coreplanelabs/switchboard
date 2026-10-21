import { describe, expect, it } from "vitest";
import { deployStep, type SandboxGateDeps } from "./run.js";
import type { DeployStep } from "./plan.js";

const step: DeployStep = {
  name: "memory",
  script: "example-memory",
  dir: "deploy/cloudflare-memory",
  command: ["npm", "run", "deploy"],
  unsetEnv: [],
  setEnv: {},
  requiredEnv: [],
  capabilities: [],
  retryOnPreflightRefusal: false,
  why: "state",
};
const version = "11111111-1111-4111-8111-111111111111";
function harness(state: "ready" | "failed" | "waiting") {
  let now = 0;
  const lines: string[] = [];
  const deps: SandboxGateDeps = {
    env: {},
    now: () => now,
    sleep: async (ms) => {
      now += ms;
    },
    readDeploymentStatus: async (intent) => {
      expect(intent).toEqual({ script: "example-memory", versionId: version, since: 0 });
      return { state, reason: "Worker deployment status" };
    },
    readHealth: async () => {
      throw new Error("no service read before provider acceptance");
    },
    readAppState: async () => {
      throw new Error("memory has no container");
    },
    readInstances: async () => {
      throw new Error("memory has no instances");
    },
    probeExec: async () => {
      throw new Error("memory has no executor");
    },
  };
  const run = () =>
    deployStep(
      step,
      { waitMaxMs: 600_000, pollMs: 60_000 },
      "a".repeat(40),
      { log: (line) => lines.push(line), warn: () => {}, stream: () => {} },
      deps,
      async () => ({ code: 0, output: `Current Version ID: ${version}` }),
    );
  return { run, lines };
}
describe("memory Worker deployment status", () => {
  it("reports the activated upload without inventing a container rollout", async () => {
    const h = harness("ready");
    expect(await h.run()).toEqual({ ok: true, versionId: version, live: "n/a" });
    expect(h.lines.join("\n")).toContain("memory: Cloudflare Worker deployment status");
  });
  it("stops when the provider refuses the uploaded version", async () => {
    expect(await harness("failed").run()).toMatchObject({
      ok: false,
      versionId: version,
      reason: "deployed but NOT live — Cloudflare deployment failed: Worker deployment status",
    });
  });
  it("does not claim success when provider status stays unverified", async () => {
    expect(await harness("waiting").run()).toMatchObject({
      ok: false,
      versionId: version,
      reason: expect.stringContaining("Cloudflare deployment readiness deadline exhausted"),
    });
  });
});
