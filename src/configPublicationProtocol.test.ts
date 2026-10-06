import { describe, expect, it } from "vitest";
import { isConfigPublicationSnapshotKey } from "./configPublicationProtocol.js";
import { isConfigPublicationSnapshotKey as hostKey, sha256Hex } from "./configDocument.js";

const uuid = ["a".repeat(8), "b".repeat(4), "c".repeat(4), "d".repeat(4), "e".repeat(12)].join("-");

describe("shared configuration publication protocol", () => {
  it("keeps the host reexport and exact reserved snapshot namespace", () => {
    expect(hostKey).toBe(isConfigPublicationSnapshotKey);
    expect(isConfigPublicationSnapshotKey(`deploy-base-${uuid}`)).toBe(true);
  });

  it.each([
    "base",
    `base-${"a".repeat(40)}`,
    "overrides",
    "deploy-base-",
    `deploy-base-${uuid.toUpperCase()}`,
    `deploy-base-${uuid}x`,
    `xdeploy-base-${uuid}`,
    `deploy-base-${uuid.slice(1)}`,
    `deploy-base-${uuid.replace(/-/g, "")}`,
  ])("leaves non-snapshot document %s outside the immutable namespace", (key) => {
    expect(isConfigPublicationSnapshotKey(key)).toBe(false);
  });

  it("retains host SHA-256 hashing", () => {
    expect(sha256Hex("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  });
});
