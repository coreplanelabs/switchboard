import { describe, expect, it } from "vitest";
import { installationResetPlan, resetInstallation, type InstallationResetIO } from "./installationReset.js";

const operation = "11111111-1111-4111-8111-111111111111";
function fixture() {
  const plan = installationResetPlan({
    native: {
      schema: 1,
      account: "a".repeat(32),
      evidence: {},
      sha256: "b".repeat(64),
      deletions: [
        { kind: "application", name: "gateway", path: `/accounts/${"a".repeat(32)}/containers/applications/old` },
      ],
    },
    settingsSha256: "c".repeat(64),
    journalBucket: "gateway-reset-journal",
    hostingSha256: "d".repeat(64),
    buckets: [
      { name: "gateway-artifacts", objects: [{ key: "runs/old/out.txt", size: 7, etag: "artifact" }] },
      { name: "gateway-resident-cache", objects: [{ key: "backups/old/data.sqsh", size: 8, etag: "backup" }] },
    ],
  });
  const state = {
    applications: ["old"],
    objects: ["runs/old/out.txt", "backups/old/data.sqsh"],
    settings: { repo: "acme/api", connection: "sealed-original" },
    frozen: false,
    verified: false,
  };
  const receipt: { phase: string; detail: unknown }[] = [];
  const io: InstallationResetIO = {
    preflight: async () => {},
    readPlan: async () => plan,
    record: async (phase, detail) => {
      receipt.push({ phase, detail });
    },
    preserve: async () => {
      state.frozen = true;
    },
    remove: async () => {
      state.applications = [];
    },
    absent: async () => {
      if (state.applications.length) throw new Error("native resources remain");
    },
    bucketContents: async (name) => ({ name, objects: plan.buckets.find((bucket) => bucket.name === name)!.objects }),
    removeObject: async (_bucket, object) => {
      state.objects = state.objects.filter((key) => key !== object.key);
    },
    empty: async () => {
      if (state.objects.length) throw new Error("old objects remain");
    },
    initialize: async () => {
      state.applications = ["fresh"];
    },
    verify: async () => {
      state.verified = true;
    },
  };
  return { plan, state, io, receipt };
}

describe("repeatable installation reset", () => {
  it("plans the full backup namespace without changing the installation", () => {
    const f = fixture();
    expect(f.plan.buckets.map((bucket) => ({ name: bucket.name, objects: bucket.objects }))).toEqual([
      { name: "gateway-artifacts", objects: [{ key: "runs/old/out.txt", size: 7, etag: "artifact" }] },
      { name: "gateway-resident-cache", objects: [{ key: "backups/old/data.sqsh", size: 8, etag: "backup" }] },
    ]);
    expect(f.state).toEqual({
      applications: ["old"],
      objects: ["runs/old/out.txt", "backups/old/data.sqsh"],
      settings: { repo: "acme/api", connection: "sealed-original" },
      frozen: false,
      verified: false,
    });
  });

  it("replaces application state and preserves settings while keeping maintenance closed", async () => {
    const f = fixture();
    const result = await resetInstallation(f.plan.sha256, operation, f.io);
    expect(result.status).toBe("verified");
    expect(result.maintenance).toBe("retained");
    expect(f.state).toEqual({
      applications: ["fresh"],
      objects: [],
      settings: { repo: "acme/api", connection: "sealed-original" },
      frozen: true,
      verified: true,
    });
    expect(f.receipt.at(-1)).toEqual({ phase: "verified", detail: { operation, maintenance: "retained" } });
  });

  it("keeps an unknown original deletion held without deleting backups or initializing", async () => {
    const f = fixture();
    f.io.remove = async () => {
      f.state.applications = [];
      throw new Error("original deletion timed out");
    };
    await expect(resetInstallation(f.plan.sha256, operation, f.io)).rejects.toThrow("original deletion timed out");
    expect(f.state).toEqual({
      applications: [],
      objects: ["runs/old/out.txt", "backups/old/data.sqsh"],
      settings: { repo: "acme/api", connection: "sealed-original" },
      frozen: true,
      verified: false,
    });
    expect(f.receipt.at(-1)).toEqual({
      phase: "removing",
      detail: {
        kind: "application",
        name: "gateway",
        path: `/accounts/${"a".repeat(32)}/containers/applications/old`,
      },
    });
  });

  it("refuses deletion when the original intent cannot be stored outside the runner", async () => {
    const f = fixture();
    f.io.record = async (phase) => {
      if (phase === "removing") throw new Error("durable journal readback failed");
    };
    await expect(resetInstallation(f.plan.sha256, operation, f.io)).rejects.toThrow("durable journal readback failed");
    expect(f.state).toEqual({
      applications: ["old"],
      objects: ["runs/old/out.txt", "backups/old/data.sqsh"],
      settings: { repo: "acme/api", connection: "sealed-original" },
      frozen: true,
      verified: false,
    });
  });

  it("refuses a changed plan or an existing receipt before freezing settings", async () => {
    for (const failure of ["changed", "existing receipt"]) {
      const f = fixture();
      if (failure === "existing receipt")
        f.io.record = async () => {
          throw new Error("existing receipt");
        };
      await expect(
        resetInstallation(failure === "changed" ? "e".repeat(64) : f.plan.sha256, operation, f.io),
      ).rejects.toThrow(failure === "changed" ? "plan changed" : "existing receipt");
      expect(f.state).toEqual({
        applications: ["old"],
        objects: ["runs/old/out.txt", "backups/old/data.sqsh"],
        settings: { repo: "acme/api", connection: "sealed-original" },
        frozen: false,
        verified: false,
      });
    }
  });

  it("holds a changed bucket scope before its first object deletion", async () => {
    const f = fixture();
    f.io.bucketContents = async () => ({ name: "foreign-bucket", objects: [] });
    await expect(resetInstallation(f.plan.sha256, operation, f.io)).rejects.toThrow("bucket scope changed");
    expect(f.state).toEqual({
      applications: [],
      objects: ["runs/old/out.txt", "backups/old/data.sqsh"],
      settings: { repo: "acme/api", connection: "sealed-original" },
      frozen: true,
      verified: false,
    });
  });

  it("clears data that arrived in the approved stores without expanding the deletion scope", async () => {
    const f = fixture();
    f.state.objects.push("runs/later/out.txt");
    f.io.bucketContents = async (name) => ({
      name,
      objects: [
        ...f.plan.buckets.find((bucket) => bucket.name === name)!.objects,
        ...(name === "gateway-artifacts" ? [{ key: "runs/later/out.txt", size: 3, etag: "later" }] : []),
      ],
    });
    expect(
      installationResetPlan({
        ...f.plan,
        buckets: await Promise.all(f.plan.buckets.map((bucket) => f.io.bucketContents(bucket.name))),
      }).sha256,
    ).toBe(f.plan.sha256);
    const result = await resetInstallation(f.plan.sha256, operation, f.io);
    expect(result.status).toBe("verified");
    expect(f.state.objects).toEqual([]);
    expect(f.state.applications).toEqual(["fresh"]);
  });

  it("refuses keys which could escape the object path", () => {
    const f = fixture();
    expect(() =>
      installationResetPlan({
        ...f.plan,
        buckets: [
          { name: "gateway-artifacts", objects: [{ key: "../foreign", etag: "x", size: 1 }] },
          f.plan.buckets[1],
        ],
      }),
    ).toThrow("bucket inventory is incomplete");
  });
});
