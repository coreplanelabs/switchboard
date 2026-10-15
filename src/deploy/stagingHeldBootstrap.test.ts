import { readFileSync } from "node:fs";
import { parse, stringify } from "yaml";
import { describe, expect, it } from "vitest";
import { sha256Hex } from "../configDocument.js";
import { parseAppConfigText } from "../config.js";
import { stagingProblems } from "./staging.js";
import { maintenanceProfileMaterial, type DeploymentProfile } from "./profile.js";
import { TEST_PROFILE, TEST_MAINTENANCE } from "./testing/profile.js";
import { runHeldStagingBootstrap, type HeldBootstrapIO, type HeldBootstrapRequest } from "./stagingHeldBootstrap.js";

const commit = "a".repeat(40);
const previous = "b".repeat(40);
const profileRef = `github://example/config/profile.json@${"c".repeat(40)}`;
const version = "00000000-0000-4000-8000-000000000001";
function fixture(successor = false) {
  const account = TEST_PROFILE.account;
  const profile: DeploymentProfile = {
    ...TEST_PROFILE,
    configSource: `github://example/config/config.yaml@${"d".repeat(40)}`,
    workers: {
      memory: { script: "staging-memory", hostname: "staging-memory.example.test" },
      bot: { script: "staging-bot", hostname: "staging-bot.example.test" },
      resident: { script: "staging-resident", hostname: "staging-resident.example.test" },
      sandbox: { script: "staging-sandbox", hostname: "staging-sandbox.example.test" },
    },
    artifacts: { bucket: "staging-artifacts" },
    metrics: { dataset: "staging_runs" },
  };
  const config = parse(readFileSync("config/config.example.yaml", "utf8"));
  Object.assign(config, {
    grants: { "http:staging": { actions: ["dispatch"], channels: ["http:staging"] } },
    runHistory: { worker: { baseUrl: "https://staging-memory.example.test" } },
    runtimeOverrides: { worker: { baseUrl: "https://staging-memory.example.test" } },
    memory: { worker: { baseUrl: "https://staging-memory.example.test" } },
    execution: {
      type: "cloudflare",
      url: "https://staging-sandbox.example.test",
      resident: { baseUrl: "https://staging-resident.example.test" },
    },
    artifacts: { r2: { accountId: account, bucket: "staging-artifacts" } },
    metrics: { dataset: "staging_runs" },
  });
  const text = stringify(config);
  const policy: NonNullable<DeploymentProfile["residentMaintenance"]> = {
    ...TEST_MAINTENANCE,
    residentScript: "staging-resident",
    residentOrigin: "https://staging-resident.example.test",
    attempt: {
      ...TEST_MAINTENANCE.attempt,
      deadline: 1_800_000,
      sourceCommit: commit,
      configSha256: sha256Hex(text),
      profileSha256: sha256Hex(maintenanceProfileMaterial(profile)),
    },
  };
  if (successor) {
    const predecessor = {
      holdId: policy.holdId,
      generation: policy.generation,
      attempt: { ...policy.attempt, id: "44444444-4444-4444-8444-444444444444", sourceCommit: previous },
      fixtureSha256: policy.fixtureSha256,
      decisionSha256: policy.decisionSha256,
      policySha256: "6".repeat(64),
      releasedAt: 0,
      releaseDecisionSha256: "7".repeat(64),
      request: { id: "55555555-5555-4555-8555-555555555555", startedAt: 0, recordSha256: "8".repeat(64) },
    };
    Object.assign(policy, {
      holdId: "33333333-3333-4333-8333-333333333333",
      generation: 2,
      decisionSha256: "5".repeat(64),
      predecessor,
    });
  }
  profile.residentMaintenance = policy;
  expect(
    stagingProblems(profile, parseAppConfigText(text), { staging: account, production: policy.productionAccount }),
  ).toEqual([]);
  const request: HeldBootstrapRequest = {
    repository: "example/switchboard",
    pullRequest: 1,
    branch: "candidate",
    commit,
    controllerCommit: commit,
    workflowRef: "example/switchboard/.github/workflows/deploy-staging-bootstrap.yml@refs/heads/candidate",
    event: "workflow_dispatch",
    actorId: 1,
    runId: 2,
    runAttempt: 1,
    attemptId: policy.attempt.id,
    profileRef,
    previousCommit: previous,
    previousWorkerVersion: version,
  };
  const row = { resource: "repo:acme/api", live: { inFlight: 0, runsInFlight: 0, imageReport: "current" } };
  const held = {
    schema: 1,
    state: "held",
    fixtureSha256: policy.fixtureSha256,
    decisionSha256: policy.decisionSha256,
    holdId: policy.holdId,
    generation: policy.generation,
    attempt: policy.attempt,
    window: null,
  };
  const predecessorView = policy.predecessor
    ? {
        schema: 1,
        state: "released",
        ...policy.predecessor,
        window: {
          state: "unverified",
          recordId: policy.predecessor.request.id,
          originalRecordSha256: policy.predecessor.request.recordSha256,
          decisionSha256: policy.predecessor.decisionSha256,
          disposition: "operator-abandoned",
          requestEnd: "unobserved",
          nativeOutcome: "unverified",
          stored: 1,
          excluded: 0,
          blocking: 1,
        },
      }
    : undefined;
  const policySha256 = sha256Hex(
    JSON.stringify(policy, (_key, item) =>
      item && typeof item === "object" && !Array.isArray(item)
        ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
        : item,
    ),
  );
  if (policy.predecessor)
    Object.assign(held, {
      policySha256,
      installation: {
        schema: 1,
        state: "installed",
        holdId: policy.holdId,
        generation: 2,
        installedAt: 0,
        policySha256,
        predecessor: policy.predecessor,
        evidence: {
          maintenance: "a".repeat(64),
          window: "b".repeat(64),
          audit: "c".repeat(64),
          release: "d".repeat(64),
          originAudit: "e".repeat(64),
        },
      },
    });
  const history = [
    {
      id: 2,
      actor: { id: 1 },
      head_sha: commit,
      head_branch: "candidate",
      run_attempt: 1,
      event: "workflow_dispatch",
      display_title: `staging held bootstrap ${policy.attempt.id}`,
      created_at: "1970-01-01T00:00:00Z",
    },
  ];
  const receipts: Record<string, unknown>[] = [];
  let uploads = 0;
  let clock = 0;
  const io: HeldBootstrapIO = {
    now: () => clock,
    loadProfile: async () => ({ profile, path: profileRef, origin: "profile" }),
    readConfig: async () => text,
    history: async () => history,
    receipt: (value) => receipts.push(value),
    read: async (url) => ({
      status: 200,
      body: url.endsWith("/healthz")
        ? { ok: true, build: { commit: uploads ? commit : previous }, features: { nativeRunScopes: "native-v1" } }
        : {
            count: 1,
            residents: [
              {
                ...row,
                live: {
                  ...row.live,
                  ...(uploads
                    ? {
                        imageTarget: {
                          application: "staging-resident-residentdo",
                          version: 2,
                          image: "registry.example.test/resident:qualified",
                        },
                      }
                    : {}),
                },
              },
            ],
            ...(uploads
              ? { stagingMaintenance: held }
              : predecessorView
                ? { stagingMaintenance: predecessorView }
                : {}),
          },
    }),
    deploy: async (loaded, config, selectedVersion) => {
      expect(loaded.profile.residentMaintenance?.holdId).toBe(policy.holdId);
      expect(config).toBe(text);
      expect(selectedVersion).toBe(version);
      uploads++;
      return {
        result: {
          kind: "ran",
          ok: true,
          notAttempted: [],
          results: [
            {
              name: "resident",
              script: "staging-resident",
              status: "deployed",
              live: "uploaded, image-ready, maintenance held",
            },
          ],
        },
        target: {
          application: "staging-resident-residentdo",
          version: 2,
          image: "registry.example.test/resident:qualified",
        },
      };
    },
  };
  return {
    request,
    policy,
    profile,
    held,
    predecessorView,
    history,
    io,
    receipts,
    uploads: () => uploads,
    expire: () => {
      clock = policy.attempt.deadline;
    },
    accounts: { staging: account, production: policy.productionAccount, configRepository: "example/config" },
  };
}

describe("held CI bootstrap", () => {
  it("records only held bootstrap readiness after one selected Resident upload", async () => {
    const h = fixture();
    const result = await runHeldStagingBootstrap(h.request, h.accounts, h.io);
    expect(result).toMatchObject({
      schema: 1,
      kind: "staging-held-bootstrap",
      outcome: "image-ready-maintenance-held",
      riskWindow: null,
      target: { application: "staging-resident-residentdo", version: 2 },
    });
    expect(result).not.toHaveProperty("accepted");
    expect(h.uploads()).toBe(1);
    expect(h.held.window).toBeNull();
  });

  it("bootstraps the exact released predecessor and verifies its new installation receipt", async () => {
    const h = fixture(true);
    expect(await runHeldStagingBootstrap(h.request, h.accounts, h.io)).toMatchObject({
      outcome: "image-ready-maintenance-held",
      riskWindow: null,
      installation: { state: "installed", generation: 2 },
    });
    expect(h.uploads()).toBe(1);
    expect(h.predecessorView).toMatchObject({
      state: "released",
      generation: 1,
      window: { requestEnd: "unobserved", nativeOutcome: "unverified" },
    });
  });

  it("keeps acknowledged retained workspace counters for the final fenced activity classification", async () => {
    const h = fixture(true);
    const retained = { threadKey: "retained-work", evicted: false, user: "worker2" };
    const read = h.io.read;
    h.io.read = async (...args) => {
      const result = await read(...args);
      if (args[0].endsWith("/residents") && !("error" in result)) {
        const body = result.body as { residents: { live: object }[] };
        return {
          status: 200,
          body: {
            ...result.body,
            residents: body.residents.map((row) => ({
              ...row,
              live: { ...row.live, inFlight: 1, runsInFlight: 1, threads: [retained] },
            })),
          },
        };
      }
      return result;
    };
    expect(await runHeldStagingBootstrap(h.request, h.accounts, h.io)).toMatchObject({
      outcome: "image-ready-maintenance-held",
    });
    expect(h.uploads()).toBe(1);
    expect(retained).toEqual({ threadKey: "retained-work", evicted: false, user: "worker2" });
  });

  it("refuses changed released predecessor or missing new installation proof", async () => {
    for (const problem of ["release", "quote", "source", "future", "phase", "receipt"] as const) {
      const h = fixture(true);
      if (problem === "release") h.predecessorView!.releaseDecisionSha256 = "0".repeat(64);
      if (problem === "quote") h.predecessorView!.window.originalRecordSha256 = "0".repeat(64);
      if (problem === "source") h.request.previousCommit = "c".repeat(40);
      if (problem === "future") {
        h.policy.predecessor!.releasedAt = 1000;
        h.predecessorView!.releasedAt = 1000;
      }
      if (problem === "phase") Object.assign(h.predecessorView!.window, { recordedState: "authorized" });
      if (problem === "receipt") delete (h.held as { installation?: unknown }).installation;
      await expect(runHeldStagingBootstrap(h.request, h.accounts, h.io)).rejects.toThrow();
      expect(h.uploads()).toBe(problem === "receipt" ? 1 : 0);
      expect(h.receipts.at(-1)?.outcome).toBe("unverified");
    }
  });

  it("refuses reruns, wrong source and mutable references before an upload", async () => {
    for (const change of [
      { runAttempt: 2 },
      { controllerCommit: previous },
      { previousCommit: commit },
      { profileRef: "github://example/config/profile.json@main" },
    ]) {
      const h = fixture();
      await expect(runHeldStagingBootstrap({ ...h.request, ...change }, h.accounts, h.io)).rejects.toThrow();
      expect(h.uploads()).toBe(0);
      expect(h.receipts.at(-1)?.outcome).toBe("unverified");
    }
  });

  it("refuses missing or prior original attempt history and a changed actor", async () => {
    for (const history of [[], [{ id: 1 }, { id: 2 }], [{ id: 2, actor: { id: 9 } }]]) {
      const h = fixture();
      const original = h.history[0]!;
      h.io.history = async () => history.map((item) => ({ ...original, ...item }));
      await expect(runHeldStagingBootstrap(h.request, h.accounts, h.io)).rejects.toThrow("original bootstrap run");
      expect(h.uploads()).toBe(0);
    }
  });

  it("refuses changed frozen inputs or an expired deadline without upload", async () => {
    for (const change of ["config", "source", "deadline"] as const) {
      const h = fixture();
      if (change === "config") h.io.readConfig = async () => "changed";
      if (change === "source") h.policy.attempt.sourceCommit = previous;
      if (change === "deadline") h.expire();
      await expect(runHeldStagingBootstrap(h.request, h.accounts, h.io)).rejects.toThrow();
      expect(h.uploads()).toBe(0);
    }
  });

  it("retains the original intent after lost upload and never sends another upload", async () => {
    const h = fixture();
    let submissions = 0;
    h.io.deploy = async () => {
      submissions++;
      throw new Error("upload response lost");
    };
    await expect(runHeldStagingBootstrap(h.request, h.accounts, h.io)).rejects.toThrow("upload response lost");
    expect(submissions).toBe(1);
    expect(h.receipts.at(-1)).toMatchObject({ outcome: "unverified", request: { runId: 2, runAttempt: 1, commit } });
  });

  it("refuses a normal risk window or missing terminal source proof after the single upload", async () => {
    for (const problem of ["window", "health"] as const) {
      const h = fixture();
      const read = h.io.read;
      h.io.read = async (...args) => {
        const result = await read(...args);
        if (h.uploads() && problem === "window" && args[0].endsWith("/residents") && !("error" in result))
          return {
            status: 200,
            body: { ...result.body, stagingMaintenance: { ...h.held, window: { state: "claimed" } } },
          };
        if (h.uploads() && problem === "health") return { error: "terminal source unreadable" };
        return result;
      };
      await expect(runHeldStagingBootstrap(h.request, h.accounts, h.io)).rejects.toThrow();
      expect(h.uploads()).toBe(1);
      expect(h.receipts.at(-1)?.outcome).toBe("unverified");
    }
  });

  it("refuses missing fixture members or pending activation after the single upload", async () => {
    for (const problem of ["missing", "pending", "target", "member"] as const) {
      const h = fixture();
      const read = h.io.read;
      h.io.read = async (...args) => {
        const result = await read(...args);
        if (h.uploads() && args[0].endsWith("/residents") && !("error" in result))
          return {
            status: 200,
            body: {
              ...result.body,
              ...(problem === "missing"
                ? { count: 0, residents: [] }
                : problem === "pending"
                  ? { pendingReplicas: 1 }
                  : {
                      residents: [
                        {
                          resource: "repo:acme/api",
                          ...(problem === "member" ? { residentId: "repo:acme/api:other" } : {}),
                          live: {
                            imageReport: "current",
                            imageTarget: {
                              application: "staging-resident-residentdo",
                              version: 1,
                              image: "registry.example.test/resident:old",
                            },
                          },
                        },
                      ],
                    }),
            },
          };
        return result;
      };
      await expect(runHeldStagingBootstrap(h.request, h.accounts, h.io)).rejects.toThrow();
      expect(h.uploads()).toBe(1);
      expect(h.receipts.at(-1)?.outcome).toBe("unverified");
    }
  });
});
