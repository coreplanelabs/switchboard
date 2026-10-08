import { describe, expect, it } from "vitest";
import {
  memoryReceiptSelection,
  memoryResourcesHash,
  parseMemoryCreationReceipt,
  validateMemoryReceipt,
} from "./stagingMemoryReceipt.js";
import { TEST_PROFILE } from "./testing/profile.js";

describe("provisional Memory receipt", () => {
  it("uses the Memory-specific zone and falls back to the profile zone", () => {
    const profile = {
      ...TEST_PROFILE,
      zone: "default.example.test",
      workers: {
        ...TEST_PROFILE.workers,
        memory: { script: "staging-memory", hostname: "memory.second.example.test", zone: "second.example.test" },
      },
    };
    expect(memoryReceiptSelection(profile)).toEqual({
      account: TEST_PROFILE.account,
      script: "staging-memory",
      hostname: "memory.second.example.test",
      zone: "second.example.test",
    });
    delete (profile.workers.memory as { zone?: string }).zone;
    expect(memoryReceiptSelection(profile).zone).toBe("default.example.test");
  });
  const uploadVersion = "11111111-1111-4111-8111-111111111111";
  const activeVersion = "22222222-2222-4222-8222-222222222222";
  const selected = {
    account: "abcdef1234567890".repeat(2),
    script: "switchboard-staging-memory",
    hostname: "memory.staging.example.test",
    zone: "staging.example.test",
  };
  const resources = {
    script: { etag: "owned-script" },
    bindings: [{ name: "CONFIG", type: "durable_object_namespace", namespace_id: "owned" }],
  };
  const receipt = {
    schema: 1 as const,
    ...selected,
    commit: "1".repeat(40),
    uploadVersion,
    activeVersion,
    deploymentId: "33333333-3333-4333-8333-333333333333",
    domainId: "4".repeat(40),
    authorId: "owner",
    resourcesHash: "d68dd4151909260f" + "ff70d4b4118e4378" + "2bffaeed77aeac97" + "398cd76e7f8fadf9",
  };
  const uploaded = { id: uploadVersion, metadata: { author_id: "owner" }, resources };
  const active = {
    id: activeVersion,
    metadata: { author_id: "owner" },
    resources: { ...resources, bindings: [...resources.bindings, { name: "MEMORY_TOKEN", type: "secret_text" }] },
  };
  const deployment = { id: receipt.deploymentId, versions: [{ version_id: activeVersion, percentage: 100 }] };
  const domain = {
    id: receipt.domainId,
    hostname: selected.hostname,
    zone_name: selected.zone,
    service: selected.script,
    environment: "production",
    enabled: true,
  };

  it("accepts the recorded upload with only the expected secret added", () => {
    expect(parseMemoryCreationReceipt(receipt)).toEqual(receipt);
    validateMemoryReceipt(receipt, selected, deployment, uploaded, active, [domain]);
    expect(memoryResourcesHash(active.resources)).toBe(receipt.resourcesHash);
    expect(() =>
      validateMemoryReceipt(receipt, { ...selected, script: "other-memory" }, deployment, uploaded, active, [domain]),
    ).toThrow("does not match");
  });

  it("refuses a changed deployment, writer, script, namespace or non-provisional binding", () => {
    for (const changed of [
      { ...active, id: uploadVersion },
      { ...active, metadata: { author_id: "other-writer" } },
      { ...active, resources: { ...resources, script: { etag: "other-script" } } },
      {
        ...active,
        resources: {
          ...resources,
          bindings: [{ name: "CONFIG", type: "durable_object_namespace", namespace_id: "other" }],
        },
      },
      { ...active, resources: { ...resources, bindings: [...resources.bindings, { name: "BOT", type: "service" }] } },
    ])
      expect(() => validateMemoryReceipt(receipt, selected, deployment, uploaded, changed, [domain])).toThrow(/Memory/);
    expect(() =>
      validateMemoryReceipt(
        receipt,
        selected,
        { versions: [{ version_id: uploadVersion, percentage: 100 }] },
        uploaded,
        active,
        [domain],
      ),
    ).toThrow("changed or is incomplete");
  });

  it("refuses a new deployment of the same version", () => {
    expect(() =>
      validateMemoryReceipt(receipt, selected, { ...deployment, id: uploadVersion }, uploaded, active, [domain]),
    ).toThrow("changed or is incomplete");
    expect(memoryResourcesHash(active.resources)).toBe(receipt.resourcesHash);
  });

  it("refuses a reassigned or replaced hostname", () => {
    for (const domains of [
      [],
      [domain, domain],
      [{ ...domain, id: "5".repeat(40) }],
      [{ ...domain, hostname: "other.staging.example.test" }],
      [{ ...domain, service: "other-memory" }],
      [{ ...domain, environment: "other" }],
      [{ ...domain, zone_name: "other.test" }],
      [{ ...domain, enabled: false }],
    ])
      expect(() => validateMemoryReceipt(receipt, selected, deployment, uploaded, active, domains)).toThrow(/Memory/);
    expect(memoryResourcesHash(active.resources)).toBe(receipt.resourcesHash);
  });
});
