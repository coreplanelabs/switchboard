import { describe, expect, it } from "vitest";
import { observeSandboxRun } from "./sandboxRunEvidence.js";

describe("sandbox run evidence", () => {
  it.each([
    { backend: null, sandboxKey: null, mapping: "unavailable" },
    { backend: "sandbox" as const, sandboxKey: null, mapping: "unavailable" },
    { backend: "resident" as const, sandboxKey: null, mapping: "not-sandbox" },
    { backend: "local" as const, sandboxKey: null, mapping: "not-sandbox" },
    { backend: "e2b" as const, sandboxKey: null, mapping: "not-sandbox" },
  ])("marks a $backend mapping as $mapping without assigning fleet evidence to it", async ({ mapping, ...target }) => {
    const evidence = await observeSandboxRun(
      { thread: "http:fixture:workspace", ...target },
      {
        now: () => 1000,
        readApp: async () => {
          throw new Error("must not read");
        },
        readInstances: async () => {
          throw new Error("must not read");
        },
      },
    );
    expect(evidence).toEqual({
      thread: "http:fixture:workspace",
      ...target,
      mapping,
      observedAt: 1000,
      finishedAt: 1000,
      application: null,
      instances: [],
      inventory: "unavailable",
      matchingInstances: 0,
      truncated: false,
    });
  });
  it("joins the exact thread to observed application, rollout and instance versions", async () => {
    const evidence = await observeSandboxRun(
      { thread: "http:fixture:workspace", backend: "sandbox", sandboxKey: "http:fixture:workspace" },
      {
        now: () => 1000,
        readApp: async () => ({
          value: { id: "app-1", version: 84, image: "image-new", activeRolloutId: "rollout-1" },
        }),
        readInstances: async () => ({
          value: [
            { id: "instance-1", name: "http:fixture:workspace", state: "running", version: 83 },
            { id: "other", name: "http:other", state: "running", version: 84 },
          ],
        }),
      },
    );
    expect(evidence).toEqual({
      observedAt: 1000,
      finishedAt: 1000,
      thread: "http:fixture:workspace",
      backend: "sandbox",
      sandboxKey: "http:fixture:workspace",
      mapping: "recorded",
      application: { id: "app-1", version: 84, image: "image-new", activeRolloutId: "rollout-1" },
      instances: [{ id: "instance-1", state: "running", version: 83 }],
      inventory: "complete",
      matchingInstances: 1,
      truncated: false,
    });
  });

  it("keeps missing rollout identity and failed inventory explicit without copying provider errors", async () => {
    expect(
      await observeSandboxRun(
        { thread: "http:fixture:workspace", backend: "sandbox", sandboxKey: "http:fixture:workspace" },
        {
          now: () => 1000,
          readApp: async () => ({ value: { version: 84, image: null } }),
          readInstances: async () => ({ error: "Authorization: Bearer secret" }),
        },
      ),
    ).toEqual({
      observedAt: 1000,
      finishedAt: 1000,
      thread: "http:fixture:workspace",
      backend: "sandbox",
      sandboxKey: "http:fixture:workspace",
      mapping: "recorded",
      application: { id: null, version: 84, image: null, activeRolloutId: null },
      instances: [],
      inventory: "unavailable",
      matchingInstances: 0,
      truncated: false,
      readFailures: {
        instances: {
          stage: "instances",
          reason: "unknown",
          commandExit: null,
          httpStatus: null,
          errorClass: "unknown",
          responseFormat: "unknown",
          providerCodes: [],
        },
      },
    });
  });
});
