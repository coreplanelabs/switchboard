import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import {
  validateExecutorContinuation,
  validateContinuationSource,
  validateContinuationProvenance,
  continuationSchema,
} from "./stagingContinuation.js";
import { TEST_PROFILE } from "./testing/profile.js";

const account = "a".repeat(32);
const profile = {
  ...TEST_PROFILE,
  account,
  zone: "staging.example.test",
  workers: {
    ...TEST_PROFILE.workers,
    resident: { script: "stage-resident", hostname: "resident.staging.example.test" },
    sandbox: { script: "stage-sandbox", hostname: "sandbox.staging.example.test" },
  },
};
const expected = {
  applicationId: "11111111-1111-4111-8111-111111111111",
  namespaceId: "b".repeat(32),
  image: `registry.cloudflare.com/${account}/stage-sandbox-switchboardsandbox@sha256:${"c".repeat(64)}`,
  uploadVersion: "22222222-2222-4222-8222-222222222222",
};
const resources = {
  script: { etag: "accepted-code" },
  bindings: [{ name: "SANDBOX", type: "durable_object_namespace", namespace_id: expected.namespaceId }],
};
function observed() {
  return {
    applications: [
      {
        id: expected.applicationId,
        name: "stage-sandbox-switchboardsandbox",
        account_id: account,
        version: 1,
        durable_objects: { namespace_id: expected.namespaceId },
        configuration: { image: expected.image },
      },
    ],
    namespaces: [{ id: expected.namespaceId, script: "stage-sandbox", class: "SwitchboardSandbox" }],
    domains: [
      {
        id: "d".repeat(40),
        hostname: "sandbox.staging.example.test",
        zone_name: "staging.example.test",
        service: "stage-sandbox",
        environment: "production",
        enabled: true,
      },
    ],
    deployment: {
      id: "33333333-3333-4333-8333-333333333333",
      versions: [{ version_id: "44444444-4444-4444-8444-444444444444", percentage: 100 }],
    },
    upload: {
      id: expected.uploadVersion,
      metadata: { author_id: "original-writer" },
      resources: structuredClone(resources),
    },
    active: {
      id: "44444444-4444-4444-8444-444444444444",
      metadata: { author_id: "original-writer" },
      resources: {
        ...structuredClone(resources),
        bindings: [...resources.bindings, { name: "SANDBOX_TOKEN", type: "secret_text" }],
      },
    },
  };
}
describe("completed executor checkpoint", () => {
  it("proves the accepted code, exact application/image/namespace and provisioned secret names", () => {
    expect(
      validateExecutorContinuation("sandbox", expected, profile, "original-writer", ["SANDBOX_TOKEN"], observed()),
    ).toEqual({
      applicationId: "11111111-1111-4111-8111-111111111111",
      applicationVersion: 1,
      namespaceId: "b".repeat(32),
      image: `registry.cloudflare.com/${account}/stage-sandbox-switchboardsandbox@sha256:${"c".repeat(64)}`,
      deploymentId: "33333333-3333-4333-8333-333333333333",
      activeVersion: "44444444-4444-4444-8444-444444444444",
      secrets: ["SANDBOX_TOKEN"],
    });
  });
  it("refuses changed native ownership, code, writer, secret names and split deployments", () => {
    const changes = [
      (v: ReturnType<typeof observed>) => {
        v.applications[0].configuration.image = "other-image";
      },
      (v: ReturnType<typeof observed>) => {
        v.namespaces[0].script = "another-worker";
      },
      (v: ReturnType<typeof observed>) => {
        v.active.resources.script.etag = "other-code";
      },
      (v: ReturnType<typeof observed>) => {
        v.active.metadata.author_id = "another-writer";
      },
      (v: ReturnType<typeof observed>) => {
        v.active.resources.bindings.pop();
      },
      (v: ReturnType<typeof observed>) => {
        v.deployment.versions[0].percentage = 50;
      },
      (v: ReturnType<typeof observed>) => {
        v.domains[0].service = "another-worker";
      },
    ];
    for (const change of changes) {
      const value = observed();
      change(value);
      expect(() =>
        validateExecutorContinuation("sandbox", expected, profile, "original-writer", ["SANDBOX_TOKEN"], value),
      ).toThrow(/changed/);
    }
  });
});

describe("original continuation source", () => {
  const memory = {
    schema: 1,
    account,
    script: "stage-memory",
    hostname: "memory.staging.example.test",
    zone: "staging.example.test",
    commit: "1".repeat(40),
    uploadVersion: expected.uploadVersion,
    activeVersion: "44444444-4444-4444-8444-444444444444",
    deploymentId: "33333333-3333-4333-8333-333333333333",
    domainId: "d".repeat(40),
    authorId: "original-writer",
    resourcesHash: "e".repeat(64),
  };
  const partial = {
    status: "initializing",
    acceptance: "not-run",
    plan: { evidence: { source: { commit: "1".repeat(40), configSha256: "f".repeat(64) }, profile } },
  };
  const partialBytes = Buffer.from(JSON.stringify(partial));
  const memoryBytes = Buffer.from(JSON.stringify(memory));
  const hash = (v: Buffer) => createHash("sha256").update(v).digest("hex");
  const checkpoint = continuationSchema.parse({
    schema: 1,
    originalRun: 42,
    originalArtifact: 43,
    originalArtifactDigest: "d".repeat(64),
    originalController: "2".repeat(40),
    originalActor: 12,
    installationCommit: "1".repeat(40),
    partialArtifactSha256: hash(partialBytes),
    memoryReceiptSha256: hash(memoryBytes),
    executors: { resident: expected, sandbox: expected },
  });
  const original = {
    id: 42,
    status: "completed",
    conclusion: "failure",
    run_attempt: 1,
    event: "workflow_dispatch",
    path: ".github/workflows/recreate-staging.yml",
    head_sha: "2".repeat(40),
    actor: { id: 12 },
  };
  it("retains the immutable installation commit from the exact failed original artifacts", () => {
    expect(
      validateContinuationSource(checkpoint, original, partialBytes, memoryBytes, profile, "f".repeat(64)),
    ).toEqual(memory);
  });
  it("qualifies original artifacts before source execution and refuses a different declared checkout", () => {
    expect(validateContinuationProvenance(checkpoint, original, partialBytes, memoryBytes, "1".repeat(40))).toEqual({
      memory,
      profile,
      configSha256: "f".repeat(64),
    });
    for (const declared of ["3".repeat(40), undefined])
      expect(() => validateContinuationProvenance(checkpoint, original, partialBytes, memoryBytes, declared)).toThrow(
        "continuation original installation source changed",
      );
  });
  it("refuses a new actor, rerun, source, artifact, profile or configuration", () => {
    for (const changed of [
      { ...original, actor: { id: 13 } },
      { ...original, run_attempt: 2 },
      { ...original, head_sha: "3".repeat(40) },
    ])
      expect(() =>
        validateContinuationSource(checkpoint, changed, partialBytes, memoryBytes, profile, "f".repeat(64)),
      ).toThrow("original initialization controller or artifacts changed");
    expect(() =>
      validateContinuationSource(checkpoint, original, Buffer.from("{}"), memoryBytes, profile, "f".repeat(64)),
    ).toThrow("artifacts changed");
    expect(() =>
      validateContinuationSource(
        checkpoint,
        original,
        partialBytes,
        memoryBytes,
        { ...profile, account: "b".repeat(32) },
        "f".repeat(64),
      ),
    ).toThrow("source, profile or configuration changed");
    expect(() =>
      validateContinuationSource(checkpoint, original, partialBytes, memoryBytes, profile, "a".repeat(64)),
    ).toThrow("source, profile or configuration changed");
  });
});

describe("exact executor namespace identity", () => {
  function inputs(kind: "resident" | "sandbox") {
    const value = observed();
    const selected = { ...expected };
    if (kind === "resident") {
      selected.image = `registry.cloudflare.com/${account}/stage-resident-residentdo@sha256:${"c".repeat(64)}`;
      value.applications[0].name = "stage-resident-residentdo";
      value.applications[0].configuration.image = selected.image;
      value.namespaces[0].script = "stage-resident";
      value.namespaces[0].class = "ResidentDO";
      value.domains[0].hostname = "resident.staging.example.test";
      value.domains[0].service = "stage-resident";
    }
    return { value, selected };
  }
  it.each(["resident", "sandbox"] as const)("accepts only the exact recorded %s namespace", (kind) => {
    const { value, selected } = inputs(kind);
    expect(validateExecutorContinuation(kind, selected, profile, "original-writer", ["SANDBOX_TOKEN"], value)).toEqual({
      applicationId: "11111111-1111-4111-8111-111111111111",
      applicationVersion: 1,
      namespaceId: "b".repeat(32),
      image: selected.image,
      deploymentId: "33333333-3333-4333-8333-333333333333",
      activeVersion: "44444444-4444-4444-8444-444444444444",
      secrets: ["SANDBOX_TOKEN"],
    });
  });
  it.each(["resident", "sandbox"] as const)(
    "refuses a different or missing %s namespace ID despite matching Worker/class",
    (kind) => {
      for (const id of ["e".repeat(32), undefined]) {
        const { value, selected } = inputs(kind);
        if (id) value.namespaces[0].id = id;
        else Reflect.deleteProperty(value.namespaces[0], "id");
        expect(() =>
          validateExecutorContinuation(kind, selected, profile, "original-writer", ["SANDBOX_TOKEN"], value),
        ).toThrow("continuation executor application or namespace changed");
      }
    },
  );
});
