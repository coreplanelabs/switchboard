import { describe, expect, it } from "vitest";
import { readCloudflareDeployment, type DeploymentIntent } from "./cloudflareDeployment.js";

const version = "11111111-1111-4111-8111-111111111111";
const intent: DeploymentIntent = { script: "worker", versionId: version, since: 1000 };
const worker = {
  deployments: [
    {
      id: "deployment",
      created_on: new Date(2000).toISOString(),
      versions: [{ version_id: version, percentage: 100 }],
    },
  ],
};
const rollout = {
  id: "rollout",
  created_at: new Date(2000).toISOString(),
  current_version: 94,
  target_version: 95,
  target_configuration: { image: "registry.example/new" },
  status: "progressing",
  progress: { updated_instances: 1, total_instances: 7, current_step: 1, total_steps: 2 },
  health: { errors: [] },
};
const container: DeploymentIntent = {
  ...intent,
  container: { application: "app", beforeVersion: 94, image: "registry.example/new" },
};
const get = (result: unknown) => async (path: string) => ({ value: path.includes("/workers/") ? worker : result });

describe("Cloudflare deployment status", () => {
  it("confirms the uploaded Worker version at 100 percent without a container", async () => {
    expect(await readCloudflareDeployment(intent, get(null))).toEqual({
      state: "ready",
      reason: "Worker version 11111111-1111-4111-8111-111111111111 serves 100%",
    });
  });
  it("reports real rollout progress then completion for the same target", async () => {
    expect(await readCloudflareDeployment(container, get([rollout]))).toEqual({
      state: "waiting",
      rolloutId: "rollout",
      reason: "rollout rollout progressing: version 94 → 95; step 1/2; updated 1/7; health errors 0",
    });
    expect(
      await readCloudflareDeployment({ ...container, rolloutId: "rollout" }, get({ ...rollout, status: "completed" })),
    ).toEqual({
      state: "ready",
      rolloutId: "rollout",
      reason: "rollout rollout completed: version 94 → 95; step 1/2; updated 1/7; health errors 0",
    });
  });
  it("does not adopt an old or foreign rollout that happens to use the image", async () => {
    expect(
      await readCloudflareDeployment(
        container,
        get([
          { ...rollout, created_at: new Date(0).toISOString() },
          { ...rollout, id: "foreign", current_version: 90 },
        ]),
      ),
    ).toEqual({ state: "waiting", reason: "selected container rollout has not registered" });
  });
  it("refuses a replaced pinned rollout instead of adopting its successor", async () => {
    expect(
      await readCloudflareDeployment({ ...container, rolloutId: "rollout" }, get({ ...rollout, status: "replaced" })),
    ).toMatchObject({ state: "failed", rolloutId: "rollout", reason: expect.stringContaining("replaced") });
  });
  it("refuses changed pins and ambiguous rollout matches", async () => {
    expect(
      await readCloudflareDeployment(
        { ...container, rolloutId: "rollout" },
        get({ ...rollout, target_configuration: { image: "registry.example/other" } }),
      ),
    ).toEqual({ state: "failed", reason: "pinned container rollout target changed" });
    expect(await readCloudflareDeployment(container, get([rollout, { ...rollout, id: "other" }]))).toEqual({
      state: "failed",
      reason: "container rollout identity is ambiguous",
    });
  });
  it("reports read failures and malformed status without granting readiness", async () => {
    expect(await readCloudflareDeployment(intent, async () => ({ error: "HTTP 503" }))).toEqual({
      state: "waiting",
      reason: "Worker deployment read unavailable: HTTP 503",
    });
    expect(await readCloudflareDeployment(container, get({}))).toEqual({
      state: "waiting",
      reason: "container rollout list is incomplete",
    });
    expect(
      await readCloudflareDeployment({ ...container, rolloutId: "rollout" }, get({ ...rollout, status: "unknown" })),
    ).toEqual({ state: "failed", reason: "container rollout response is incomplete" });
  });
  it("refuses a newer Worker deployment and waits for a partially active version", async () => {
    expect(
      await readCloudflareDeployment(intent, async () => ({
        value: { deployments: [{ ...worker.deployments[0], versions: [{ version_id: "other", percentage: 100 }] }] },
      })),
    ).toEqual({ state: "failed", reason: "uploaded Worker version was superseded" });
    expect(
      await readCloudflareDeployment(intent, async () => ({
        value: { deployments: [{ ...worker.deployments[0], versions: [{ version_id: version, percentage: 10 }] }] },
      })),
    ).toEqual({ state: "waiting", reason: "Worker version 11111111-1111-4111-8111-111111111111 serves 10%" });
  });
});
