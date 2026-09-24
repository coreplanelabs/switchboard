import { describe, expect, it } from "vitest";
import { configurationFingerprint, residentRolloutDecision } from "./residentRollout.js";

const account = "a".repeat(32);
const digest = `sha256:${"b".repeat(64)}`;
const configuration = {
  image: `registry.cloudflare.com/${account}/switchboard-resident@${digest}`,
  instance_type: { vcpu: 4, memory_mib: 12288, disk_mb: 20000 },
  max_instances: 10,
};
const receipt = {
  manifestDigest: digest,
  controlResetPiReceipt: "run:control-reset-pi-verified",
  configuration,
  configurationFingerprint: configurationFingerprint(configuration),
};

describe("residentRolloutDecision", () => {
  it("allows worker-only upload only for the immutable account image and an exact full configuration receipt", () => {
    expect(
      residentRolloutDecision({ account, mode: "registry", force: false, receipt, current: configuration }),
    ).toEqual({
      rollout: "none",
      reason: "the immutable resident image and full effective container configuration match the verified receipt",
    });
  });

  it.each([
    ["build mode", { mode: "build" as const }],
    ["forced", { force: true }],
    ["missing receipt", { receipt: undefined }],
    [
      "moved image",
      { current: { ...configuration, image: configuration.image.replace(digest, `sha256:${"c".repeat(64)}`) } },
    ],
    ["configuration drift", { current: { ...configuration, max_instances: 9 } }],
    ["stale fingerprint", { receipt: { ...receipt, configurationFingerprint: `sha256:${"0".repeat(64)}` } }],
    ["missing control-reset/pi receipt", { receipt: { ...receipt, controlResetPiReceipt: "" } }],
  ])("drains and rolls for %s", (_name, override) => {
    expect(
      residentRolloutDecision({
        account,
        mode: "registry",
        force: false,
        receipt,
        current: configuration,
        ...override,
      }),
    ).toMatchObject({ rollout: "drain" });
  });

  it("fingerprints every declared key independent of object key order", () => {
    expect(configurationFingerprint({ b: [2, { z: true, a: null }], a: 1 })).toBe(
      configurationFingerprint({ a: 1, b: [2, { a: null, z: true }] }),
    );
    expect(configurationFingerprint({ a: 1, b: 2 })).not.toBe(configurationFingerprint({ a: 1 }));
  });
});
