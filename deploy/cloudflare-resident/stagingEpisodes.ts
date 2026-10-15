import { z } from "zod";
import {
  abandonmentAuditSchema,
  maintenanceRecordSchema,
  releaseWindowSchema,
  stagingInstallationSchema,
  stagingEvidenceSha256,
  stagingSuccessorProblems,
  stagingReleaseReceiptSchema,
  liveMaintenanceWindow,
  type MaintenanceRecord,
  type StagingMaintenancePolicy,
} from "../../src/deploy/residentMaintenance.js";
import { admissionRecordHash } from "./admissionRecovery.js";

interface EpisodeReader {
  get<T = unknown>(key: string): Promise<T | undefined>;
  list<T = unknown>(options: { prefix: string; limit?: number }): Promise<Map<string, T>>;
}
interface EpisodeWriter extends EpisodeReader {
  put(key: string, value: unknown): Promise<void>;
}

const ACTIVE = "deploy:staging-active";
const MAINTENANCE = "deploy:staging-maintenance";
const INSTALLATION = "deploy:staging-installation:";
const pointerSchema = z
  .object({
    schema: z.literal(1),
    holdId: z.uuid(),
    generation: z.number().int().positive(),
    policySha256: z.string().regex(/^[0-9a-f]{64}$/),
  })
  .strict();

/** Only validated identifiers and closed condition names enter refusal text. */
function episodeRefusal(code: string, selected: unknown, condition: string): Error {
  const fields = z.object({ holdId: z.unknown().optional(), generation: z.unknown().optional() }).safeParse(selected);
  const hold = z.uuid().safeParse(fields.success ? fields.data.holdId : undefined);
  const generation = z
    .number()
    .int()
    .positive()
    .max(Number.MAX_SAFE_INTEGER)
    .safeParse(fields.success ? fields.data.generation : undefined);
  return new Error(
    `${code}: hold=${hold.success ? hold.data : "unverified"} generation=${generation.success ? generation.data : "unverified"} condition=${condition}`,
  );
}

export function stagingEpisodeKeys(policy?: StagingMaintenancePolicy) {
  return {
    maintenance: policy?.predecessor ? `${MAINTENANCE}:${policy.holdId}` : MAINTENANCE,
    window: policy?.predecessor ? `deploy:staging-window:${policy.holdId}` : "deploy:staging-window",
    release: `deploy:staging-release:${policy?.holdId}`,
    installation: `${INSTALLATION}${policy?.holdId}`,
  };
}
export function stagingEpisodeAuditKey(policy: StagingMaintenancePolicy | undefined, id: string) {
  return `deploy:abandoned:${id}${policy?.predecessor ? `:${policy.holdId}` : ""}`;
}

async function predecessorEvidence(store: EpisodeReader, policy: StagingMaintenancePolicy) {
  const selected = policy.predecessor;
  if (!selected) throw episodeRefusal("staging-successor-predecessor-unverified", policy, "predecessor-selection");
  const successorRaw = await store.get(`${MAINTENANCE}:${selected.holdId}`);
  const raw = successorRaw === undefined ? await store.get(MAINTENANCE) : successorRaw;
  const prior = maintenanceRecordSchema.safeParse(raw);
  if (!prior.success)
    throw episodeRefusal("staging-successor-predecessor-unverified", policy, "predecessor-maintenance-record");
  const hold = prior.data;
  const keys = stagingEpisodeKeys(hold.policy);
  const window = await store.get(keys.window);
  const audit = await store.get(stagingEpisodeAuditKey(hold.policy, selected.request.id));
  const release = await store.get(keys.release);
  const originAudit = await store.get(`deploy:abandoned:${selected.request.id}`);
  return { hold, raw, window, audit, release, originAudit, keys };
}

/** Missing current selection never silently revives a released legacy record. */
export async function readStagingEpisode(
  store: EpisodeReader,
  historicalHoldId?: string,
): Promise<MaintenanceRecord | null> {
  const activeRaw = await store.get(ACTIVE);
  let raw: unknown;
  let pointer: z.infer<typeof pointerSchema> | undefined;
  if (historicalHoldId !== undefined) {
    if (!z.uuid().safeParse(historicalHoldId).success)
      throw episodeRefusal("staging-maintenance-identity-invalid", { holdId: historicalHoldId }, "historical-hold-id");
    raw = await store.get(`${MAINTENANCE}:${historicalHoldId}`);
    if (raw === undefined) {
      const legacy = await store.get<MaintenanceRecord>(MAINTENANCE);
      if (legacy?.policy?.holdId === historicalHoldId) raw = legacy;
    }
  } else if (activeRaw === undefined) {
    const installation = await store.list({ prefix: INSTALLATION, limit: 1 });
    const retained = installation.size ? installation : await store.list({ prefix: `${MAINTENANCE}:`, limit: 1 });
    if (retained.size) {
      const witness = retained.values().next().value;
      const receipt = stagingInstallationSchema.safeParse(witness);
      const record = maintenanceRecordSchema.safeParse(witness);
      throw episodeRefusal(
        "staging-episode-pointer-unverified",
        receipt.success ? receipt.data : record.success ? record.data.policy : undefined,
        "active-pointer-missing",
      );
    }
    raw = await store.get(MAINTENANCE);
  } else {
    const parsed = pointerSchema.safeParse(activeRaw);
    if (!parsed.success) throw episodeRefusal("staging-episode-pointer-unverified", activeRaw, "active-pointer-shape");
    pointer = parsed.data;
    raw = await store.get(`${MAINTENANCE}:${pointer.holdId}`);
    if (raw === undefined)
      throw episodeRefusal("staging-episode-record-unverified", pointer, "current-maintenance-missing");
  }
  if (raw === undefined) return null;
  const parsed = maintenanceRecordSchema.safeParse(raw);
  if (!parsed.success)
    throw episodeRefusal("staging-maintenance-record-unverified", pointer, "maintenance-record-shape");
  const hold = parsed.data;
  if (historicalHoldId !== undefined && hold.policy.holdId !== historicalHoldId)
    throw episodeRefusal("staging-episode-record-unverified", hold.policy, "selection-hold-generation-policy");
  if (pointer) {
    if (hold.policy.holdId !== pointer.holdId)
      throw episodeRefusal("staging-episode-record-unverified", hold.policy, "pointer-hold-id");
    if (hold.policy.generation !== pointer.generation)
      throw episodeRefusal("staging-episode-record-unverified", hold.policy, "pointer-generation");
    if ((await stagingEvidenceSha256(hold.policy)) !== pointer.policySha256)
      throw episodeRefusal("staging-episode-record-unverified", hold.policy, "pointer-policy-digest");
  }
  if (hold.policy.predecessor) {
    const receipt = stagingInstallationSchema.safeParse(await store.get(stagingEpisodeKeys(hold.policy).installation));
    if (!receipt.success)
      throw episodeRefusal("staging-installation-receipt-unverified", hold.policy, "installation-shape");
    if (receipt.data.holdId !== hold.policy.holdId)
      throw episodeRefusal("staging-installation-receipt-unverified", hold.policy, "installation-hold-id");
    if (receipt.data.generation !== hold.policy.generation)
      throw episodeRefusal("staging-installation-receipt-unverified", hold.policy, "installation-generation");
    if (receipt.data.installedAt !== hold.installedAt)
      throw episodeRefusal("staging-installation-receipt-unverified", hold.policy, "installation-time");
    if (receipt.data.policySha256 !== (await stagingEvidenceSha256(hold.policy)))
      throw episodeRefusal("staging-installation-receipt-unverified", hold.policy, "installation-policy-digest");
    if (JSON.stringify(receipt.data.predecessor) !== JSON.stringify(hold.policy.predecessor))
      throw episodeRefusal("staging-installation-receipt-unverified", hold.policy, "installation-predecessor");
    const prior = await predecessorEvidence(store, hold.policy);
    for (const [name, value] of Object.entries({
      maintenance: prior.raw,
      window: prior.window,
      audit: prior.audit,
      release: prior.release,
      originAudit: prior.originAudit,
    }))
      if ((await stagingEvidenceSha256(value)) !== receipt.data.evidence[name as keyof typeof receipt.data.evidence])
        throw episodeRefusal("staging-predecessor-evidence-changed", hold.policy, `predecessor-${name}-digest`);
  } else if (pointer)
    throw episodeRefusal("staging-episode-record-unverified", hold.policy, "selection-hold-generation-policy");
  return hold;
}

/** The caller supplies one storage transaction and the rendered trusted policy. */
export async function installStagingEpisode(
  store: EpisodeWriter,
  policy: StagingMaintenancePolicy,
  now: number,
): Promise<void> {
  if (stagingSuccessorProblems(policy).length)
    throw episodeRefusal("staging-successor-policy-invalid", policy, "successor-identity-source-generation-fixture");
  const current = await readStagingEpisode(store);
  if (current && JSON.stringify(current.policy) === JSON.stringify(policy)) return;
  const held: MaintenanceRecord = { schema: 1, state: "held", installedAt: now, policy };
  if (!liveMaintenanceWindow(held, now))
    throw episodeRefusal("staging-maintenance-deadline-invalid", policy, "fixed-deadline");
  if (!current) {
    if (policy.predecessor)
      throw episodeRefusal("staging-successor-predecessor-missing", policy, "current-released-record-missing");
    await store.put(MAINTENANCE, held);
    return;
  }
  const selected = policy.predecessor;
  if (!selected)
    throw episodeRefusal("staging-maintenance-generation-mismatch", policy, "selected-predecessor-missing");
  const prior = await predecessorEvidence(store, policy);
  const window = releaseWindowSchema.safeParse(prior.window);
  const audit = abandonmentAuditSchema.safeParse(prior.audit);
  const parsedRelease = stagingReleaseReceiptSchema.safeParse(prior.release);
  const release = parsedRelease.success ? parsedRelease.data : undefined;
  const originAudit = abandonmentAuditSchema.safeParse(prior.originAudit);
  const original = await store.get(`deploy:admission:${selected.request.id}`);
  function verify(condition: unknown, name: string): asserts condition {
    if (!condition) throw episodeRefusal("staging-successor-predecessor-unverified", policy, name);
  }
  verify(JSON.stringify(prior.hold) === JSON.stringify(current), "predecessor-current-selection");
  verify(current.state === "released", "predecessor-state");
  verify(current.policy.holdId === selected.holdId, "predecessor-hold-id");
  verify(current.policy.generation === selected.generation, "predecessor-generation");
  verify(JSON.stringify(current.policy.attempt) === JSON.stringify(selected.attempt), "predecessor-operation");
  verify(current.policy.fixtureSha256 === selected.fixtureSha256, "predecessor-fixture-digest");
  verify(current.policy.decisionSha256 === selected.decisionSha256, "predecessor-decision-digest");
  verify(current.releasedAt === selected.releasedAt, "predecessor-release-time");
  verify(current.releaseDecisionSha256 === selected.releaseDecisionSha256, "predecessor-release-decision");
  verify((await stagingEvidenceSha256(current.policy)) === selected.policySha256, "predecessor-policy-digest");
  verify(policy.generation === current.policy.generation + 1, "successor-generation");
  verify(policy.holdId !== current.policy.holdId, "successor-hold-id");
  verify(policy.attempt.id !== current.policy.attempt.id, "successor-operation-id");
  verify(policy.attempt.sourceCommit !== current.policy.attempt.sourceCommit, "successor-source");
  verify(policy.decisionSha256 !== current.policy.decisionSha256, "successor-decision");
  verify(now >= selected.releasedAt, "predecessor-release-clock");
  for (const key of [
    "stagingAccount",
    "productionAccount",
    "residentScript",
    "residentOrigin",
    "fixtureSha256",
    "resources",
  ] as const)
    verify(JSON.stringify(policy[key]) === JSON.stringify(current.policy[key]), `successor-scope-${key}`);
  verify(originAudit.success, "original-audit-shape");
  verify(originAudit.data.id === selected.request.id, "original-audit-request-id");
  verify(originAudit.data.originalRecordSha256 === selected.request.recordSha256, "original-audit-selected-digest");
  verify(
    (await admissionRecordHash(originAudit.data.originalRecord)) === selected.request.recordSha256,
    "original-audit-record-digest",
  );
  verify(window.success, "predecessor-window-shape");
  verify(window.data.state === "completed", "predecessor-window-state");
  verify(window.data.recordId === selected.request.id, "predecessor-window-request-id");
  verify(
    window.data.holdId === current.policy.holdId && window.data.generation === current.policy.generation,
    "predecessor-window-hold-generation",
  );
  verify(window.data.attemptId === current.policy.attempt.id, "predecessor-window-operation-id");
  verify(audit.success, "predecessor-audit-shape");
  verify(audit.data.id === selected.request.id, "predecessor-audit-request-id");
  verify(JSON.stringify(audit.data.policy) === JSON.stringify(current.policy), "predecessor-audit-policy");
  verify(
    audit.data.decidedAt >= current.installedAt && audit.data.decidedAt <= selected.releasedAt,
    "predecessor-audit-time",
  );
  verify(
    Date.parse(audit.data.fence.until) >= current.policy.attempt.deadline &&
      Date.parse(window.data.drain.until) >= current.policy.attempt.deadline,
    "predecessor-fence-deadline",
  );
  verify(audit.data.originalRecord.startedAt === selected.request.startedAt, "predecessor-audit-request-start");
  verify(audit.data.originalRecordSha256 === selected.request.recordSha256, "predecessor-audit-selected-digest");
  verify(
    (await admissionRecordHash(audit.data.originalRecord)) === selected.request.recordSha256,
    "predecessor-audit-record-digest",
  );
  verify((await admissionRecordHash(original)) === selected.request.recordSha256, "original-request-digest");
  verify((await store.list({ prefix: "deploy:admission:" })).size === 1, "other-global-requests");
  verify(release?.schema === 1, "predecessor-release-shape");
  verify(
    release.holdId === current.policy.holdId && release.generation === current.policy.generation,
    "predecessor-release-hold-generation",
  );
  verify(release.fixtureSha256 === current.policy.fixtureSha256, "predecessor-release-fixture");
  verify(release.decisionSha256 === selected.releaseDecisionSha256, "predecessor-release-digest");
  verify(release.releasedAt === selected.releasedAt, "predecessor-release-record-time");
  verify(release.originalRecordSha256 === selected.request.recordSha256, "predecessor-release-request-digest");
  verify(
    release.requestEnd === "unobserved" && release.nativeOutcome === "unverified",
    "predecessor-release-unknown-ending",
  );
  const keys = stagingEpisodeKeys(policy);
  if (
    (await store.get(keys.maintenance)) !== undefined ||
    (await store.get(keys.installation)) !== undefined ||
    (await store.get(keys.window)) !== undefined ||
    (await store.get(keys.release)) !== undefined ||
    (await store.get(stagingEpisodeAuditKey(policy, selected.request.id))) !== undefined
  )
    throw episodeRefusal("staging-successor-identity-used", policy, "successor-key-already-present");
  const policySha256 = await stagingEvidenceSha256(policy);
  const installation = stagingInstallationSchema.parse({
    schema: 1,
    state: "installed",
    holdId: policy.holdId,
    generation: policy.generation,
    installedAt: now,
    policySha256,
    predecessor: selected,
    evidence: {
      maintenance: await stagingEvidenceSha256(prior.raw),
      window: await stagingEvidenceSha256(prior.window),
      audit: await stagingEvidenceSha256(prior.audit),
      release: await stagingEvidenceSha256(prior.release),
      originAudit: await stagingEvidenceSha256(prior.originAudit),
    },
  });
  await store.put(keys.maintenance, held);
  await store.put(keys.installation, installation);
  await store.put(ACTIVE, { schema: 1, holdId: policy.holdId, generation: policy.generation, policySha256 });
}
