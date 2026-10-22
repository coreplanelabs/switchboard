import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import { resetDigest } from "./installationReset.js";
import { parseConfigSource } from "./configSource.js";

const sha = z.string().regex(/^[a-f0-9]{64}$/);
const commit = z.string().regex(/^[a-f0-9]{40}$/);
const cloudId = z.string().regex(/^[a-f0-9]{32}$/);
const positive = z.number().int().positive();
const count = z.number().int().nonnegative();
const priorFields = {
  outcome: z.literal("unknown"),
  intentSha256: sha,
  response: z
    .object({
      httpStatus: z.number().int().min(100).max(599).nullable(),
      requestId: z
        .string()
        .regex(/^[a-f0-9]{16,32}(?:-[a-z]{3})?$/i)
        .nullable(),
    })
    .strict(),
};
const priorOne = z.object({ sequence: z.literal(1), phase: z.literal("verification-intent"), ...priorFields }).strict();
const priorTwo = z
  .object({ sequence: z.literal(2), phase: z.literal("original-intent-observed"), ...priorFields })
  .strict();
const reportedPriorWrites = z.tuple([priorOne, priorTwo]);
const priorWrites = z.tuple([
  priorOne.extend({ readStatus: z.literal(404) }),
  priorTwo.extend({ readStatus: z.literal(404) }),
]);
export const stagingResetRecoveryRequest = z
  .object({
    schema: z.literal(1),
    originalRun: positive,
    originalCommit: commit,
    operation: z.string().uuid(),
    recoveryId: z.string().uuid(),
    planSha256: sha,
    heldSequence: positive.max(10000),
    priorWrites: reportedPriorWrites,
    maintenance: z.object({ id: z.string().uuid(), version: positive, actor: z.string().min(1) }).strict(),
    profileRef: z.string(),
    liveCommit: commit,
    credentialKind: z.enum(["user", "account"]),
    expectedTokenId: cloudId.optional(),
    preview: z.object({ run: positive, sha256: sha }).strict().optional(),
  })
  .strict();
export type StagingResetRecoveryRequest = z.infer<typeof stagingResetRecoveryRequest>;
const contextSchema = z
  .object({
    mode: z.enum(["preview", "continue"]),
    repository: z.string().regex(/^[\w.-]+\/[\w.-]+$/),
    event: z.literal("workflow_dispatch"),
    ref: z.literal("refs/heads/main"),
    workflowRef: z.string(),
    workflowSha: commit,
    checkoutSha: commit,
    clean: z.literal(true),
    runId: positive,
    runAttempt: z.literal(1),
    actorId: positive,
    actor: z.string().min(1),
    stagingAccount: cloudId,
    productionAccount: cloudId,
    recoveryId: z.string().uuid(),
    operation: z.string().uuid(),
    configRepository: z.string(),
  })
  .strict();
const maintenanceSchema = z.object({
  version: count,
  episode: z
    .object({
      id: z.string().uuid(),
      phase: z.enum(["active", "ended", "announced"]),
      scopes: z.array(z.string()),
      actor: z.string(),
      reason: z.string(),
      channel: z.string(),
      updatedAt: z.number(),
      notice: z.object({ status: z.enum(["sent", "sending", "unverified"]) }).passthrough(),
    })
    .passthrough()
    .nullable(),
});
const resetStatus = z
  .object({
    config: z.object({ operation: z.string().uuid(), phase: z.enum(["restoring", "verified"]) }).strict(),
    organizations: z.array(
      z.object({ operation: z.string().uuid(), phase: z.enum(["restoring", "verified"]) }).strict(),
    ),
    installations: z.array(z.string()),
  })
  .passthrough();
const originalSchema = z.object({
  account: cloudId,
  operation: z.string().uuid(),
  planSha256: sha,
  originalRun: positive,
  originalCommit: commit,
  heldSequence: positive,
  heldPhase: z.literal("held"),
  resetOutcome: z.literal("unknown"),
  maintenance: maintenanceSchema,
  settingsSha256: sha,
  hostingSha256: sha,
  installations: z.array(z.string()).min(1),
  applications: z.literal(3),
  heldSha256: sha,
  preservationSha256: sha,
  priorWrites,
  workflow: z
    .object({
      id: positive,
      path: z.literal(".github/workflows/deploy-staging.yml"),
      event: z.literal("workflow_dispatch"),
      status: z.literal("completed"),
      conclusion: z.enum(["failure", "cancelled"]),
      head_sha: commit,
      run_attempt: z.literal(1),
      actor: z.object({ id: positive, login: z.string() }),
    })
    .passthrough(),
});
const health = z.object({ ok: z.boolean(), commit: z.union([commit, z.literal("unknown")]) });
export const stagingResetRecoveryObservation = z.object({
  at: z.string().datetime(),
  settingsSha256: sha,
  settingsExceptMaintenanceSha256: sha,
  hostingSha256: sha,
  oldNamespacesRemaining: count,
  oldApplicationsRemaining: count,
  applications: count,
  oldBucketKeysRemaining: count,
  bucketObjects: count,
  historyEntries: count,
  liveRuns: count,
  inFlight: count,
  inFlightUnknown: count,
  reserved: count,
  pendingReplicas: count,
  residents: count,
  draining: z.boolean(),
  admissions: count,
  botInFlight: count,
  botDraining: z.boolean(),
  health: z.object({ memory: health, resident: health, bot: health, sandbox: health }),
  resetStatus,
  maintenance: maintenanceSchema,
});
export interface StagingResetRecoveryIO {
  now(): number;
  token(): Promise<unknown>;
  original(): Promise<unknown>;
  history(currentRunId: number): Promise<unknown>;
  preview(): Promise<unknown>;
  observe(): Promise<unknown>;
  record(sequence: number, phase: string, value: Record<string, unknown>): Promise<unknown>;
  verify(): Promise<unknown>;
  end(expected: unknown): Promise<unknown>;
  receipt(value: Record<string, unknown>): void;
}
/** This type is used only for source-owned guard text, never provider prose. */
export class StagingResetRecoveryRefusal extends Error {
  constructor(
    readonly reason: "evidence-mismatch" | "active-work" | "duplicate-continuation" | "inputs-unavailable",
    message: string,
  ) {
    super(message);
    this.name = "StagingResetRecoveryRefusal";
  }
}
const same = (
  actual: unknown,
  expected: unknown,
  reason: string,
  code: StagingResetRecoveryRefusal["reason"] = "evidence-mismatch",
) => {
  if (!isDeepStrictEqual(actual, expected)) throw new StagingResetRecoveryRefusal(code, reason);
};
const requestBinding = ({ expectedTokenId: _token, preview: _preview, ...scope }: StagingResetRecoveryRequest) =>
  resetDigest(scope);

export function validateStagingResetRecoveryIdentity(request: StagingResetRecoveryRequest, rawContext: unknown) {
  const context = contextSchema.parse(rawContext);
  same(context.workflowSha, context.checkoutSha, "recovery source differs");
  same(
    context.workflowRef,
    `${context.repository}/.github/workflows/recover-staging-reset.yml@refs/heads/main`,
    "recovery workflow differs",
  );
  same(context.recoveryId, request.recoveryId, "recovery ID differs");
  same(context.operation, request.operation, "original operation differs");
  if (context.stagingAccount === context.productionAccount)
    throw new StagingResetRecoveryRefusal("evidence-mismatch", "recovery requires isolated staging");
  const profile = parseConfigSource(request.profileRef);
  if (
    !profile.ok ||
    profile.source.kind !== "github" ||
    !/^[a-f0-9]{40}$/.test(profile.source.ref) ||
    `${profile.source.owner}/${profile.source.repo}` !== context.configRepository
  )
    throw new StagingResetRecoveryRefusal("evidence-mismatch", "recovery profile is not immutable configuration");
  return context;
}

/** One CI continuation can verify an already restored installation, never repeat the reset. */
export async function runStagingResetRecovery(rawRequest: unknown, rawContext: unknown, io: StagingResetRecoveryIO) {
  let receipt: Record<string, unknown> = {
    schema: 1,
    kind: "staging-reset-recovery",
    outcome: "unverified",
    phase: "identity",
    originalRestartOutcome: "unknown",
    discardedWorkOutcome: "unknown",
    historicalTokenIdentity: "unproved",
    priorWriteOutcomes: ["unknown", "unknown"],
    qualification: "unproved",
    verifyAttempted: false,
    maintenanceEndAttempted: false,
  };
  const save = (fields: Record<string, unknown>) => {
    receipt = { ...receipt, ...fields };
    io.receipt(receipt);
  };
  io.receipt(receipt);
  try {
    const request = stagingResetRecoveryRequest.parse(rawRequest);
    const context = validateStagingResetRecoveryIdentity(request, rawContext);
    save({
      mode: context.mode,
      requestBinding: requestBinding(request),
      operation: request.operation,
      recoveryId: request.recoveryId,
      controller: { run: context.runId, commit: context.workflowSha, actorId: context.actorId },
      phase: "token-identity",
    });
    const token = z
      .object({ kind: z.enum(["user", "account"]), id: cloudId, status: z.literal("active") })
      .parse(await io.token());
    same(token.kind, request.credentialKind, "protected token kind differs");
    if (request.expectedTokenId) same(token.id, request.expectedTokenId, "protected CI token changed");
    save({ token });
    save({ phase: "original" });
    const original = originalSchema.parse(await io.original());
    for (const name of ["operation", "planSha256", "originalRun", "originalCommit", "heldSequence"] as const)
      same(original[name], request[name], "original reset identity differs");
    same(original.account, context.stagingAccount, "original reset account differs");
    same(
      original.priorWrites.map(({ readStatus: _read, ...reported }) => reported),
      request.priorWrites,
      "operator-reported prior intent evidence differs",
    );
    same(original.workflow.id, request.originalRun, "original workflow differs");
    same(original.workflow.head_sha, request.originalCommit, "original workflow source differs");
    same(original.workflow.actor, { id: context.actorId, login: context.actor }, "original workflow actor differs");
    same(request.maintenance.actor, `reset-controller:${context.actor}`, "reset actor differs");
    const initial = original.maintenance;
    const episode = initial.episode;
    if (
      !episode ||
      episode.phase !== "active" ||
      !isDeepStrictEqual(episode.scopes, ["all"]) ||
      episode.id !== request.maintenance.id ||
      episode.actor !== request.maintenance.actor ||
      initial.version !== request.maintenance.version ||
      episode.channel !== "staging-reset-fixture" ||
      episode.reason !== "Isolated staging reset validation" ||
      episode.notice.status !== "unverified" ||
      episode.thread !== undefined
    )
      throw new StagingResetRecoveryRefusal("evidence-mismatch", "original maintenance is not the owned fixture hold");
    const observe = async (phase: "restoring" | "verified", ended?: unknown) => {
      save({ observed: undefined, evidence: undefined });
      const o = stagingResetRecoveryObservation.parse(await io.observe());
      // Retain closed, safe facts before qualification. Private settings and notice text never enter this receipt.
      const { maintenance, resetStatus, ...bounded } = o;
      save({
        observed: {
          ...bounded,
          maintenance: {
            id: maintenance.episode?.id,
            version: maintenance.version,
            phase: maintenance.episode?.phase,
            ownerMatches: maintenance.episode?.actor === episode.actor,
            noticeStatus: maintenance.episode?.notice.status,
            threadPresent: maintenance.episode?.thread !== undefined,
          },
          resetStatus: { config: resetStatus.config, organizations: resetStatus.organizations },
        },
      });
      same(o.settingsExceptMaintenanceSha256, original.settingsSha256, "preserved settings changed");
      same(o.hostingSha256, original.hostingSha256, "hosting changed");
      for (const n of ["oldNamespacesRemaining", "oldApplicationsRemaining", "oldBucketKeysRemaining"] as const)
        same(o[n], 0, "old reset data remains");
      same(o.applications, original.applications, "replacement applications differ");
      for (const value of Object.values(o.health)) {
        same(value.ok, true, "selected Worker is not healthy");
        same(value.commit, request.liveCommit, "live build differs");
      }
      same(o.resetStatus.installations, original.installations, "restored installation scope differs");
      same(o.resetStatus.config, { operation: request.operation, phase }, "Config reset phase differs");
      same(
        o.resetStatus.organizations,
        original.installations.map(() => ({ operation: request.operation, phase })),
        "Organization reset phase differs",
      );
      if (ended === undefined) {
        same(o.settingsSha256, original.settingsSha256, "settings changed before maintenance end");
        same(o.maintenance, initial, "maintenance owner or version changed");
        for (const name of [
          "bucketObjects",
          "historyEntries",
          "liveRuns",
          "inFlight",
          "inFlightUnknown",
          "reserved",
          "pendingReplicas",
          "residents",
          "admissions",
          "botInFlight",
        ] as const)
          same(o[name], 0, "recovery waits for absent active and uncertain work", "active-work");
        if (o.draining || o.botDraining)
          throw new StagingResetRecoveryRefusal("evidence-mismatch", "another controller retains a drain");
      } else same(o.maintenance, ended, "maintenance end readback differs");
      const evidence = {
        at: o.at,
        liveCommit: request.liveCommit,
        settingsSha256: o.settingsExceptMaintenanceSha256,
        hostingSha256: o.hostingSha256,
        originalNativeIdsAndKeysAbsent: true,
        resetPhase: phase,
        maintenance: {
          id: o.maintenance.episode?.id,
          version: o.maintenance.version,
          phase: o.maintenance.episode?.phase,
        },
        ...(ended === undefined ? { idleBeforeAccess: true } : {}),
      };
      save({ evidence });
      return o;
    };
    save({
      phase: "preflight",
      originalWorkflowOutcome: original.workflow.conclusion === "failure" ? "failed" : "cancelled",
      originalJournal: { heldSha256: original.heldSha256, preservationSha256: original.preservationSha256 },
    });
    await observe("restoring");
    if (context.mode === "preview") {
      save({ outcome: "previewed", phase: "previewed", at: new Date(io.now()).toISOString() });
      return receipt;
    }
    if (!request.expectedTokenId || !request.preview)
      throw new StagingResetRecoveryRefusal(
        "evidence-mismatch",
        "continuation requires an approved preview and token ID",
      );
    same(token.id, request.expectedTokenId, "protected CI token changed");
    save({ phase: "approved-preview" });
    const preview = z
      .object({
        schema: z.literal(1),
        kind: z.literal("staging-reset-recovery"),
        outcome: z.literal("previewed"),
        mode: z.literal("preview"),
        requestBinding: sha,
        controller: z.object({ run: positive, commit, actorId: positive }),
        token: z.object({ kind: z.enum(["user", "account"]), id: cloudId, status: z.literal("active") }),
      })
      .passthrough()
      .parse(await io.preview());
    same(preview.requestBinding, requestBinding(request), "approved preview scope differs");
    same(
      preview.controller,
      { run: request.preview.run, commit: context.workflowSha, actorId: context.actorId },
      "approved preview controller differs",
    );
    same(preview.token, token, "approved preview token differs");
    save({ phase: "admission" });
    const runs = z
      .array(z.object({ id: positive, display_title: z.string(), run_attempt: positive }).passthrough())
      .parse(await io.history(context.runId));
    const admitted = runs.filter((run) =>
      run.display_title.startsWith(`staging reset recovery continue ${request.operation} `),
    );
    if (
      admitted.length !== 1 ||
      admitted[0].id !== context.runId ||
      admitted[0].run_attempt !== 1 ||
      admitted[0].display_title !== `staging reset recovery continue ${request.operation} ${request.recoveryId}`
    )
      throw new StagingResetRecoveryRefusal(
        "duplicate-continuation",
        "this recovery continuation was already requested or its history is incomplete",
      );
    const record = async (sequence: number, phase: string) => {
      save({ phase, journalSequence: sequence });
      const stored = await io.record(sequence, phase, {
        ...receipt,
        ...(sequence === 6 ? { outcome: "recovered" } : {}),
        at: new Date(io.now()).toISOString(),
        planSha256: request.planSha256,
        originalRun: request.originalRun,
        originalCommit: request.originalCommit,
        priorWrites: original.priorWrites,
      });
      const written = z
        .object({ bucket: z.string().min(1), keySha256: sha, sha256: sha, bytes: positive })
        .strict()
        .parse(stored);
      save({ lastJournal: written });
    };
    await record(3, "verification-intent");
    await observe("restoring");
    save({ phase: "verify", verifyAttempted: true });
    const result = resetStatus.parse(await io.verify());
    same(result.installations, original.installations, "reset verification installation scope differs");
    same(result.config, { operation: request.operation, phase: "verified" }, "reset verification response differs");
    same(
      result.organizations,
      original.installations.map(() => ({ operation: request.operation, phase: "verified" })),
      "reset verification response is partial",
    );
    save({ verificationAcknowledged: true });
    await observe("verified");
    await record(4, "verification-observed");
    await observe("verified");
    await record(5, "maintenance-end-intent");
    save({ phase: "maintenance-end", maintenanceEndAttempted: true });
    const ended = maintenanceSchema.parse(await io.end(initial));
    if (
      ended.version !== initial.version + 1 ||
      ended.episode?.id !== episode.id ||
      ended.episode.actor !== episode.actor ||
      ended.episode.phase !== "ended"
    )
      throw new StagingResetRecoveryRefusal("evidence-mismatch", "maintenance end acknowledgment differs");
    same(
      ended.episode,
      { ...episode, phase: "ended", updatedAt: ended.episode.updatedAt, notice: ended.episode.notice },
      "maintenance end changed another field",
    );
    same(ended.episode.notice.status, "unverified", "maintenance notice was not retained as unverified");
    save({ maintenanceEndAcknowledged: { id: ended.episode.id, version: ended.version, phase: ended.episode.phase } });
    await observe("verified", ended);
    await record(6, "recovery-observed");
    save({ outcome: "recovered", phase: "recovered", at: new Date(io.now()).toISOString() });
    return receipt;
  } catch (error) {
    try {
      save({ outcome: "unverified" });
    } catch (receiptError) {
      throw new AggregateError([error, receiptError], "recovery and local receipt are unverified", {
        cause: receiptError,
      });
    }
    throw error;
  }
}
