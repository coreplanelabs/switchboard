import { describe, expect, it } from "vitest";
import { nextDeployImageReconcile, replacementContainerStarted } from "./imageReconcileState";
import { buildId, resolveBuildStamp } from "../../src/deploy/buildStamp";
import { residentImageTargetSchema } from "../../src/deploy/residentMaintenance";
import { methodOf, readSource } from "./testing/sourceScan";
import ts from "typescript";
import { runInNewContext } from "node:vm";

describe("nextDeployImageReconcile", () => {
  const build = "a".repeat(40);
  const newer = "b".repeat(40);
  const target = { application: "test-resident-residentdo", version: 1, image: "registry.example.test/resident:one" };

  it("starts a cycle for a new Worker build, even when an older build left a pending report", () => {
    expect(nextDeployImageReconcile(build, undefined, false, target)).toBe("start");
    expect(nextDeployImageReconcile(newer, { build, target, cycleIssued: true }, true, target)).toBe("start");
  });

  it("keeps a verified report on another reconcile of the same build", () => {
    expect(nextDeployImageReconcile(build, { build, target, cycleIssued: true }, false, target)).toBe("verified");
    expect(nextDeployImageReconcile(build, { build, target, cycleIssued: false }, false, target)).toBe("verified");
  });

  it("retries only a cycle that was deferred; a stopped container waits for its own report", () => {
    expect(nextDeployImageReconcile(build, { build, target, cycleIssued: false }, true, target)).toBe("retry-cycle");
    expect(nextDeployImageReconcile(build, { build, target, cycleIssued: true }, true, target)).toBe("await-report");
  });
});

describe("resident image target decisions", () => {
  const target = { application: "test-resident-residentdo", version: 1, image: "registry.example.test/resident:one" };
  function fixture(build: string, stored: unknown) {
    const source = readSource("worker.ts");
    const methods = ["reconcileForDeploy", "reconcileForDeployAdmitted", "reconcileImage", "reportPendingImageCurrent"]
      .map((name) => methodOf(source, name))
      .join("\n");
    const compiled = ts.transpileModule(`class Resident { ${methods} }`, {
      compilerOptions: { target: ts.ScriptTarget.ES2022 },
    }).outputText;
    const rows = new Map<string, unknown>([["progress", stored]]);
    const events: string[] = [];
    const { Resident } = runInNewContext(compiled + "\n({ Resident })", {
      BUILD: resolveBuildStamp("a".repeat(40), "2026-10-15T00:00:00.000Z"),
      BUILD_ID: build,
      nextDeployImageReconcile,
      replacementContainerStarted,
      residentImageTargetSchema,
      IMAGE_RECONCILE_KEY: "progress",
      IMAGE_REPORT_PENDING_KEY: "pending",
      STATE_KEY: "state",
      FACTS_KEY: "facts",
      systemClock: () => 1000,
      errMsg: (error: Error) => error.message,
      console: { log: () => {} },
      registryStub: () => ({
        holdDrainFor: async () => events.push("hold"),
        reportContainerImageCurrent: async () => ({ lifted: false }),
      }),
    });
    const resident = new Resident();
    Object.assign(resident, {
      env: { RESIDENT_SCRIPT_NAME: "test-resident" },
      ctx: {
        storage: {
          get: async (key: string) => rows.get(key),
          put: async (key: string, value: unknown) => rows.set(key, value),
          delete: async (key: string) => rows.delete(key),
        },
      },
      withRecreateSafeAdmin: async (work: () => Promise<unknown>) => work(),
      residentIdentity: async () => "repo:acme/api",
      isRuntimeActive: async () => true,
      containerIdentity: async () => "original-boot",
      inFlightCount: () => 0,
      registeredRunsBeyondOps: async () => 0,
      automaticContainerLoss: async (_reason: string, work: () => Promise<void>) => {
        await work();
        return true;
      },
      swapIncarnation: () => {},
      stop: async () => events.push("stop"),
    });
    return { resident, rows, events };
  }

  it("requires a fresh member image decision for a later same-source build and changed target", async () => {
    const old = buildId(resolveBuildStamp("a".repeat(40), "2026-10-15T00:00:00.000Z"));
    const newer = buildId(resolveBuildStamp("a".repeat(40), "2026-10-15T00:01:00.000Z"));
    const h = fixture(newer, { build: "a".repeat(40), target, cycleIssued: true });
    const next = { ...target, version: 2, image: "registry.example.test/resident:two" };
    expect(await h.resident.reconcileForDeploy("repo:acme/api", next)).toEqual({
      result: "restarted",
      verified: false,
    });
    expect(h.events).toEqual(["hold", "stop"]);
    expect(h.rows.get("progress")).toMatchObject({ build: newer, target: next, cycleIssued: true });
    expect(old).toBe(`${"a".repeat(40)}@2026-10-15T00:00:00.000Z`);
  });

  it("requires a new image decision when the target changes on the same Worker artifact", async () => {
    const build = buildId(resolveBuildStamp("a".repeat(40), "2026-10-15T00:00:00.000Z"));
    const h = fixture(build, { build, target, cycleIssued: true });
    const next = { ...target, version: 2, image: "registry.example.test/resident:two" };
    expect(await h.resident.reconcileForDeploy("repo:acme/api", next)).toEqual({
      result: "restarted",
      verified: false,
    });
    expect(h.events).toEqual(["hold", "stop"]);
    expect(await h.resident.reconcileForDeploy("repo:acme/api", next)).toEqual({ result: "deferred", verified: false });
    expect(h.events).toEqual(["hold", "stop"]);
    h.rows.delete("pending");
    expect(await h.resident.reconcileForDeploy("repo:acme/api", next)).toEqual({ result: "current", verified: true });
  });

  it("refuses incomplete or foreign targets before an image decision", async () => {
    const h = fixture("artifact", { build: "artifact", target, cycleIssued: true });
    for (const input of [undefined, { ...target, image: null }, { ...target, application: "foreign-residentdo" }])
      expect(await h.resident.reconcileForDeploy("repo:acme/api", input)).toEqual({
        result: "deferred",
        verified: false,
      });
    expect(await h.resident.reconcileForDeploy("repo:acme/api", target)).toEqual({ result: "current", verified: true });
    expect(h.events).toEqual([]);
  });

  it("lets an earlier target finish its report without certifying or cycling the newly requested target", async () => {
    const h = fixture("artifact", { build: "artifact", target, cycleIssued: true });
    h.rows.set("pending", { resource: "repo:acme/api" });
    const next = { ...target, version: 2, image: "registry.example.test/resident:two" };
    await expect(h.resident.reconcileForDeploy("repo:acme/api", next)).rejects.toThrow(
      "desired image target changed while an earlier image report remains pending",
    );
    expect(h.events).toEqual([]);
    expect(h.rows.get("progress")).toMatchObject({ target, cycleIssued: true });
    h.rows.delete("pending");
    expect(await h.resident.reconcileForDeploy("repo:acme/api", next)).toEqual({
      result: "restarted",
      verified: false,
    });
    expect(h.events).toEqual(["hold", "stop"]);
  });

  it("retains an earlier pending target through a new Worker build", async () => {
    const h = fixture("new-artifact", { build: "old-artifact", target, cycleIssued: true });
    h.rows.set("pending", { resource: "repo:acme/api" });
    await expect(h.resident.reconcileForDeploy("repo:acme/api", { ...target, version: 2 })).rejects.toThrow(
      "desired image target changed while an earlier image report remains pending",
    );
    expect(h.events).toEqual([]);
    expect(h.rows.get("progress")).toEqual({ build: "old-artifact", target, cycleIssued: true });
    expect(h.rows.get("pending")).toEqual({ resource: "repo:acme/api" });
  });

  it("refuses a pending report without valid progress or target evidence", async () => {
    for (const stored of [undefined, "invalid", { build: "artifact", cycleIssued: true }]) {
      const h = fixture("artifact", stored);
      h.rows.set("pending", { resource: "repo:acme/api" });
      await expect(h.resident.reconcileForDeploy("repo:acme/api", target)).rejects.toThrow(
        "desired image target changed while an earlier image report remains pending",
      );
      expect(h.events).toEqual([]);
      expect(h.rows.get("progress")).toEqual(stored);
      expect(h.rows.get("pending")).toEqual({ resource: "repo:acme/api" });
    }
  });
});

describe("replacementContainerStarted", () => {
  it("requires two known and different boot IDs before treating a reused disk as a fresh container", () => {
    expect(replacementContainerStarted("old", "new")).toBe(true);
    expect(replacementContainerStarted("old", "old")).toBe(false);
    expect(replacementContainerStarted(undefined, "new")).toBe(false);
    expect(replacementContainerStarted("old", undefined)).toBe(false);
  });
});
