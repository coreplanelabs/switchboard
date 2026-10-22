import { describe, expect, it } from "vitest";
import { runStagingResetRecovery } from "./stagingResetRecovery.js";

const operation = "11111111-1111-4111-8111-111111111111";
const recoveryId = "22222222-2222-4222-8222-222222222222";
const episodeId = "33333333-3333-4333-8333-333333333333";
const account = "a".repeat(32);
const source = "b".repeat(40);
const live = "c".repeat(40);
const digest = "d".repeat(64);
const tokenId = "e".repeat(32);
function fixture() {
  const request = {
    schema: 1 as const,
    originalRun: 100,
    originalCommit: "f".repeat(40),
    operation,
    recoveryId,
    planSha256: digest,
    heldSequence: 26,
    maintenance: { id: episodeId, version: 3, actor: "reset-controller:operator" },
    priorWrites: [
      {
        sequence: 1 as const,
        phase: "verification-intent" as const,
        outcome: "unknown" as const,
        intentSha256: "7".repeat(64),
        response: { httpStatus: null, requestId: null },
      },
      {
        sequence: 2 as const,
        phase: "original-intent-observed" as const,
        outcome: "unknown" as const,
        intentSha256: "8".repeat(64),
        response: { httpStatus: 403, requestId: "0123456789abcdef-SJC" },
      },
    ] as const,
    profileRef: `github://example/infra/staging/profile.json@${source}`,
    liveCommit: live,
    credentialKind: "user" as const,
  };
  const context = {
    mode: "preview",
    repository: "example/gateway",
    event: "workflow_dispatch",
    ref: "refs/heads/main",
    workflowSha: source,
    checkoutSha: source,
    clean: true,
    runId: 200,
    runAttempt: 1,
    actorId: 42,
    actor: "operator",
    stagingAccount: account,
    productionAccount: "9".repeat(32),
    recoveryId,
    operation,
    workflowRef: "example/gateway/.github/workflows/recover-staging-reset.yml@refs/heads/main",
    configRepository: "example/infra",
  };
  const maintenance = {
    version: 3,
    episode: {
      id: episodeId,
      phase: "active" as const,
      scopes: ["all"],
      actor: "reset-controller:operator",
      reason: "Isolated staging reset validation",
      channel: "staging-reset-fixture",
      timing: "in a few minutes",
      updatedAt: 1,
      notice: { status: "unverified" },
    },
  };
  const original = {
    account,
    operation,
    planSha256: digest,
    originalRun: 100,
    originalCommit: "f".repeat(40),
    heldSequence: 26,
    heldPhase: "held",
    resetOutcome: "unknown",
    maintenance,
    settingsSha256: digest,
    hostingSha256: digest,
    installations: ["example"],
    applications: 3,
    heldSha256: "1".repeat(64),
    preservationSha256: "2".repeat(64),
    workflow: {
      id: 100,
      path: ".github/workflows/deploy-staging.yml",
      event: "workflow_dispatch",
      status: "completed",
      conclusion: "failure",
      head_sha: "f".repeat(40),
      run_attempt: 1,
      actor: { id: 42, login: "operator" },
    },
    priorWrites: request.priorWrites.map((w) => ({ ...w, readStatus: 404 })),
  };
  const resetStatus = {
    config: { operation, phase: "restoring" },
    organizations: [{ operation, phase: "restoring" }],
    installations: ["example"],
  };
  const observation = {
    at: "2026-01-01T00:00:00.000Z",
    settingsSha256: digest,
    settingsExceptMaintenanceSha256: digest,
    hostingSha256: digest,
    oldNamespacesRemaining: 0,
    oldApplicationsRemaining: 0,
    applications: 3,
    oldBucketKeysRemaining: 0,
    bucketObjects: 0,
    historyEntries: 0,
    liveRuns: 0,
    inFlight: 0,
    inFlightUnknown: 0,
    reserved: 0,
    pendingReplicas: 0,
    residents: 0,
    draining: false,
    admissions: 0,
    botInFlight: 0,
    botDraining: false,
    health: {
      memory: { ok: true, commit: live },
      resident: { ok: true, commit: live },
      bot: { ok: true, commit: live },
      sandbox: { ok: true, commit: live },
    },
    resetStatus,
    maintenance,
  };
  const effects: string[] = [];
  const records: Array<{ sequence: number; phase: string; value: unknown }> = [];
  const receipts: any[] = [];
  const history = [
    { id: 200, display_title: `staging reset recovery continue ${operation} ${recoveryId}`, run_attempt: 1 },
  ];
  let preview: any;
  let verifyFailure: Error | undefined;
  let journalFailure: Error | undefined;
  let omitJournalAck = false;
  let endFailure: Error | undefined;
  let loseAfterEnd = false;
  const io = {
    now: () => 1,
    token: async () => ({ kind: "user", id: tokenId, status: "active" }),
    original: async () => structuredClone(original),
    history: async () => history,
    preview: async () => preview,
    observe: async () => structuredClone(observation),
    record: async (sequence: number, phase: string, value: unknown) => {
      effects.push(`journal:${sequence}:${phase}`);
      records.push({ sequence, phase, value });
      if (journalFailure) throw journalFailure;
      if (omitJournalAck) return;
      return {
        bucket: "gateway-staging-memory-reset-journal",
        keySha256: "3".repeat(64),
        sha256: "4".repeat(64),
        bytes: 512,
      };
    },
    verify: async () => {
      effects.push("verify");
      if (verifyFailure) throw verifyFailure;
      observation.resetStatus.config.phase = "verified";
      observation.resetStatus.organizations[0].phase = "verified";
      return structuredClone(observation.resetStatus);
    },
    end: async (expected: any) => {
      effects.push("end");
      expect(expected).toEqual(maintenance);
      if (endFailure) throw endFailure;
      observation.maintenance = {
        ...maintenance,
        version: 4,
        episode: { ...maintenance.episode, phase: "ended" as any },
      };
      if (loseAfterEnd) {
        observation.liveRuns = 1;
        observation.historyEntries = 1;
        observation.bucketObjects = 1;
      }
      return structuredClone(observation.maintenance);
    },
    receipt: (receipt: unknown) => {
      receipts.push(structuredClone(receipt));
    },
  };
  async function approved() {
    context.runId = 199;
    const read = await runStagingResetRecovery(request, context, io);
    context.runId = 200;
    preview = read;
    context.mode = "continue";
    return { ...request, expectedTokenId: tokenId, preview: { run: 199, sha256: "4".repeat(64) } };
  }
  return {
    request,
    context,
    io,
    original,
    observation,
    effects,
    records,
    receipts,
    approved,
    omitJournalAck: () => {
      omitJournalAck = true;
    },
    duplicateOtherRecovery: () => {
      history.push({
        ...history[0],
        id: 201,
        display_title: `staging reset recovery continue ${operation} 44444444-4444-4444-8444-444444444444`,
      });
    },
    setPreview: (v: any) => {
      preview = v;
    },
    duplicate: () => {
      history.push({ ...history[0], id: 201 });
    },
    failVerify: () => {
      verifyFailure = new Error("response lost");
    },
    failJournal: () => {
      journalFailure = new Error("response lost");
    },
    failEnd: () => {
      endFailure = new Error("response lost");
    },
    admitAfterEnd: () => {
      loseAfterEnd = true;
    },
  };
}

describe("staging reset tail recovery", () => {
  it("previews the protected token and original facts without a journal or service mutation", async () => {
    const f = fixture();
    await expect(runStagingResetRecovery(f.request, f.context, f.io)).resolves.toMatchObject({
      outcome: "previewed",
      token: { id: tokenId },
      originalRestartOutcome: "unknown",
      priorWriteOutcomes: ["unknown", "unknown"],
      qualification: "unproved",
    });
    expect(f.effects).toEqual([]);
  });
  it("records sequence three before original verification and ends only its owned hold", async () => {
    const f = fixture();
    const request = await f.approved();
    await expect(runStagingResetRecovery(request, f.context, f.io)).resolves.toMatchObject({
      outcome: "recovered",
      originalWorkflowOutcome: "failed",
      verificationAcknowledged: true,
      maintenanceEndAcknowledged: { id: episodeId, version: 4, phase: "ended" },
      originalRestartOutcome: "unknown",
      priorWriteOutcomes: ["unknown", "unknown"],
      qualification: "unproved",
    });
    expect(f.effects).toEqual([
      "journal:3:verification-intent",
      "verify",
      "journal:4:verification-observed",
      "journal:5:maintenance-end-intent",
      "end",
      "journal:6:recovery-observed",
    ]);
    expect(f.records[0].value).toMatchObject({ operation, recoveryId, priorWriteOutcomes: ["unknown", "unknown"] });
    expect(f.observation.maintenance).toMatchObject({ version: 4, episode: { id: episodeId, phase: "ended" } });
  });
  it.each(["journal", "verify", "end"] as const)(
    "stops after an uncertain %s without repeating it",
    async (boundary) => {
      const f = fixture();
      const request = await f.approved();
      if (boundary === "journal") f.failJournal();
      else if (boundary === "verify") f.failVerify();
      else f.failEnd();
      await expect(runStagingResetRecovery(request, f.context, f.io)).rejects.toThrow("response lost");
      expect(f.effects.filter((x) => x === "verify")).toHaveLength(boundary === "journal" ? 0 : 1);
      expect(f.effects.filter((x) => x === "end")).toHaveLength(boundary === "end" ? 1 : 0);
      expect(f.receipts.at(-1)).toMatchObject({
        outcome: "unverified",
        originalRestartOutcome: "unknown",
        priorWriteOutcomes: ["unknown", "unknown"],
      });
    },
  );
  it.each(["inFlightUnknown", "liveRuns", "oldNamespacesRemaining", "oldBucketKeysRemaining"] as const)(
    "refuses %s evidence before its first write",
    async (field) => {
      const f = fixture();
      const request = await f.approved();
      f.observation[field] = 1;
      await expect(runStagingResetRecovery(request, f.context, f.io)).rejects.toThrow();
      expect(f.effects).toEqual([]);
      expect(f.receipts.at(-1)).toMatchObject({ outcome: "unverified", observed: { [field]: 1 } });
    },
  );
  it("retains unhealthy or unknown build facts without treating the observation as qualified", async () => {
    const f = fixture();
    const request = await f.approved();
    f.observation.health.resident.ok = false;
    f.observation.health.bot.commit = "unknown";
    await expect(runStagingResetRecovery(request, f.context, f.io)).rejects.toThrow();
    expect(f.receipts.at(-1)).toMatchObject({
      outcome: "unverified",
      observed: { health: { resident: { ok: false }, bot: { commit: "unknown" } } },
    });
    expect(f.effects).toEqual([]);
    expect(f.receipts.at(-1).evidence).toBeUndefined();
    expect(f.receipts.at(-1).observed.maintenance).toEqual({
      id: episodeId,
      version: 3,
      phase: "active",
      ownerMatches: true,
      noticeStatus: "unverified",
      threadPresent: false,
    });
    expect(JSON.stringify(f.receipts.at(-1).observed)).not.toContain("Isolated staging reset validation");
  });
  it("clears earlier qualification when a later observation refuses recovery", async () => {
    const f = fixture();
    const request = await f.approved();
    const record = f.io.record;
    f.io.record = async (...args) => {
      const result = await record(...args);
      f.observation.inFlightUnknown = 1;
      return result;
    };
    await expect(runStagingResetRecovery(request, f.context, f.io)).rejects.toThrow("uncertain work");
    expect(f.receipts.at(-1)).toMatchObject({
      outcome: "unverified",
      phase: "verification-intent",
      observed: { inFlightUnknown: 1 },
    });
    expect(f.receipts.at(-1).evidence).toBeUndefined();
    expect(f.effects).toEqual(["journal:3:verification-intent"]);
  });
  it("refuses a duplicate continuation even when its earlier journal write is absent", async () => {
    const f = fixture();
    const request = await f.approved();
    f.duplicate();
    await expect(runStagingResetRecovery(request, f.context, f.io)).rejects.toThrow();
    expect(f.effects).toEqual([]);
  });
  it("refuses a changed CI token, source, account or maintenance owner", async () => {
    for (const change of ["token", "source", "account", "owner"] as const) {
      const f = fixture();
      const request = await f.approved();
      if (change === "token") request.expectedTokenId = "5".repeat(32);
      if (change === "source") f.context.checkoutSha = "6".repeat(40);
      if (change === "account") f.context.stagingAccount = f.context.productionAccount;
      if (change === "owner") f.observation.maintenance.episode.actor = "another-operator";
      await expect(runStagingResetRecovery(request, f.context, f.io)).rejects.toThrow();
      expect(f.effects).toEqual([]);
    }
  });
  it("refuses a sent notice with no thread before any recovery write", async () => {
    const f = fixture();
    const request = await f.approved();
    f.original.maintenance.episode.notice.status = "sent";
    await expect(runStagingResetRecovery(request, f.context, f.io)).rejects.toThrow("owned fixture hold");
    expect(f.effects).toEqual([]);
    expect(f.observation.maintenance).toMatchObject({ version: 3, episode: { phase: "active" } });
  });
  it("refuses another recovery ID for an already admitted original operation", async () => {
    const f = fixture();
    const request = await f.approved();
    f.duplicateOtherRecovery();
    await expect(runStagingResetRecovery(request, f.context, f.io)).rejects.toThrow("already requested");
    expect(f.effects).toEqual([]);
  });
  it("does not advance without the journal acknowledgment", async () => {
    const f = fixture();
    const request = await f.approved();
    f.omitJournalAck();
    await expect(runStagingResetRecovery(request, f.context, f.io)).rejects.toThrow();
    expect(f.effects).toEqual(["journal:3:verification-intent"]);
    expect(f.receipts.at(-1)).toMatchObject({
      outcome: "unverified",
      verifyAttempted: false,
      maintenanceEndAttempted: false,
    });
  });
  it("preserves an original failure when retaining its local receipt also fails", async () => {
    const f = fixture();
    const request = await f.approved();
    f.failVerify();
    const write = f.io.receipt;
    f.io.receipt = (value) => {
      write(value);
      if (f.effects.includes("verify")) throw new Error("local receipt lost");
    };
    await expect(runStagingResetRecovery(request, f.context, f.io)).rejects.toMatchObject({
      errors: [{ message: "response lost" }, { message: "local receipt lost" }],
    });
    expect(f.effects).toEqual(["journal:3:verification-intent", "verify"]);
  });
  it("does not treat legitimate new work after maintenance ends as a failed recovery", async () => {
    const f = fixture();
    const request = await f.approved();
    f.admitAfterEnd();
    await expect(runStagingResetRecovery(request, f.context, f.io)).resolves.toMatchObject({
      outcome: "recovered",
      qualification: "unproved",
    });
    expect(f.observation.liveRuns).toBe(1);
  });
});
