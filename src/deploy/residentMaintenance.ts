import { z } from "zod";
import { DRAIN, minutesToMs } from "../core/budgets.js";

const digest = z.string().regex(/^[0-9a-f]{64}$/);
const account = z.string().regex(/^[0-9a-f]{32}$/);
const word = z.string().regex(/^[A-Za-z0-9_.:-]{1,128}$/);

const selectedOperationSchema = z
  .object({
    id: z.uuid(),
    controllerId: word,
    sourceCommit: z.string().regex(/^[0-9a-f]{40}$/),
    profileSha256: digest,
    configSha256: digest,
    deadline: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  })
  .strict();

export const stagingPredecessorSchema = z
  .object({
    holdId: z.uuid(),
    generation: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    attempt: selectedOperationSchema,
    fixtureSha256: digest,
    decisionSha256: digest,
    policySha256: digest,
    releasedAt: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    releaseDecisionSha256: digest,
    request: z
      .object({
        id: z.uuid(),
        startedAt: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
        recordSha256: digest,
      })
      .strict(),
  })
  .strict();
export type StagingPredecessor = z.infer<typeof stagingPredecessorSchema>;

/** The deployment profile selects one staging decision. Request data cannot
 * enable it. Digests identify retained evidence; they do not verify it. */
export const stagingMaintenanceSchema = z
  .object({
    schema: z.literal(1),
    stagingAccount: account,
    productionAccount: account,
    residentScript: word,
    residentOrigin: z.url().refine((value) => {
      const url = new URL(value);
      return url.protocol === "https:" && url.origin === value && !url.username && !url.password;
    }),
    fixtureSha256: digest,
    resources: z
      .array(z.string().regex(/^repo:[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/))
      .min(1)
      .max(100)
      .refine((values) => new Set(values).size === values.length),
    decisionSha256: digest,
    holdId: z.uuid(),
    generation: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    attempt: selectedOperationSchema,
    predecessor: stagingPredecessorSchema.optional(),
  })
  .strict();

export type StagingMaintenancePolicy = z.infer<typeof stagingMaintenanceSchema>;
export type StagingDeployAttempt = StagingMaintenancePolicy["attempt"];

export const stagingAttemptSchema = stagingMaintenanceSchema.shape.attempt
  .extend({
    holdId: z.uuid(),
    generation: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  })
  .strict();
export type SelectedStagingAttempt = z.infer<typeof stagingAttemptSchema>;

/** The authenticated deploy controller's observed native application target. */
export const residentImageTargetSchema = z
  .object({
    application: word,
    version: z.number().int().nonnegative(),
    image: z.string().min(1).max(2048).regex(/^\S+$/),
  })
  .strict();
export type ResidentImageTarget = z.infer<typeof residentImageTargetSchema>;

export function sameResidentImageTarget(stored: unknown, target: ResidentImageTarget): boolean {
  const parsed = residentImageTargetSchema.safeParse(stored);
  return (
    parsed.success &&
    parsed.data.application === target.application &&
    parsed.data.version === target.version &&
    parsed.data.image === target.image
  );
}

const timestamp = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
export const maintenanceRecordSchema = z
  .object({
    schema: z.literal(1),
    state: z.enum(["held", "released"]),
    installedAt: timestamp,
    releasedAt: timestamp.optional(),
    releaseDecisionSha256: digest.optional(),
    policy: stagingMaintenanceSchema,
  })
  .strict()
  .refine((row) =>
    row.state === "held"
      ? row.releasedAt === undefined
      : row.releasedAt !== undefined && row.releasedAt >= row.installedAt && row.releaseDecisionSha256 !== undefined,
  );
export type MaintenanceRecord = z.infer<typeof maintenanceRecordSchema>;

export const stagingReleaseReceiptSchema = z
  .object({
    schema: z.literal(1),
    holdId: z.uuid(),
    generation: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    fixtureSha256: digest,
    decisionSha256: digest,
    releasedAt: timestamp,
    originalRecordSha256: digest,
    requestEnd: z.literal("unobserved"),
    nativeOutcome: z.literal("unverified"),
  })
  .strict();

export const stagingFenceSchema = z
  .object({
    since: z.iso.datetime(),
    until: z.iso.datetime(),
    versionId: z.uuid(),
  })
  .strict()
  .refine((fence) => Date.parse(fence.until) > Date.parse(fence.since));
export type StagingFence = z.infer<typeof stagingFenceSchema>;

export const abandonmentAuditSchema = z
  .object({
    schema: z.literal(1),
    id: z.uuid(),
    disposition: z.literal("operator-abandoned"),
    requestEnd: z.literal("unobserved"),
    nativeOutcome: z.literal("unverified"),
    independentObligations: z.literal("unchanged"),
    policy: stagingMaintenanceSchema,
    originalRecord: z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()])),
    originalRecordSha256: digest,
    decidedAt: timestamp,
    fence: stagingFenceSchema,
  })
  .strict();
export type AbandonmentAudit = z.infer<typeof abandonmentAuditSchema>;

export const releaseWindowSchema = z
  .object({
    schema: z.literal(1),
    state: z.enum(["authorized", "claimed", "fenced", "completed"]),
    recordId: z.uuid(),
    holdId: z.uuid(),
    generation: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    attemptId: z.uuid(),
    drain: stagingFenceSchema,
  })
  .strict();
export type ReleaseWindow = z.infer<typeof releaseWindowSchema>;

export function liveMaintenanceWindow(hold: MaintenanceRecord, now: number): boolean {
  return (
    Number.isSafeInteger(now) &&
    now >= hold.installedAt &&
    now < hold.policy.attempt.deadline &&
    hold.policy.attempt.deadline <= hold.installedAt + minutesToMs(DRAIN.maxMinutes)
  );
}

export function selectedStagingAttempt(hold: MaintenanceRecord, input: unknown, now: number): boolean {
  return hold.state === "held" && liveMaintenanceWindow(hold, now) && stagingAttemptMatches(hold, input);
}

export function stagingAttemptMatches(hold: Pick<MaintenanceRecord, "policy">, input: unknown): boolean {
  const attempt = stagingAttemptSchema.safeParse(input);
  if (!attempt.success) return false;
  const expected = { ...hold.policy.attempt, holdId: hold.policy.holdId, generation: hold.policy.generation };
  return (Object.keys(expected) as Array<keyof typeof expected>).every((key) => attempt.data[key] === expected[key]);
}

export function stagingSuccessorProblems(policy: StagingMaintenancePolicy): string[] {
  const previous = policy.predecessor;
  if (!previous) return [];
  return policy.generation !== previous.generation + 1 ||
    policy.holdId === previous.holdId ||
    policy.attempt.id === previous.attempt.id ||
    policy.attempt.sourceCommit === previous.attempt.sourceCommit ||
    policy.fixtureSha256 !== previous.fixtureSha256 ||
    policy.decisionSha256 === previous.decisionSha256 ||
    policy.decisionSha256 === previous.releaseDecisionSha256
    ? ["residentMaintenance: successor identity, source, generation or fixture is invalid"]
    : [];
}

export function maintenanceProfileProblems(
  policy: StagingMaintenancePolicy,
  profile: { account: string; images: string; resident?: { script: string; hostname: string } },
): string[] {
  if (policy.stagingAccount === policy.productionAccount)
    return ["residentMaintenance: staging and production accounts must differ"];
  if (profile.account !== policy.stagingAccount)
    return ["residentMaintenance: profile must use the selected staging account"];
  if (
    !profile.resident ||
    profile.resident.script !== policy.residentScript ||
    `https://${profile.resident.hostname}` !== policy.residentOrigin
  )
    return ["residentMaintenance: Resident script and origin must match the profile"];
  if (!policy.residentScript.includes("staging") || profile.images !== "build")
    return ["residentMaintenance: a staging Resident with locally built images is required"];
  return stagingSuccessorProblems(policy);
}

/** Digests bind retained values; they never prove a request or native ending. */
export async function stagingEvidenceSha256(value: unknown): Promise<string> {
  const bytes = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(
      JSON.stringify(value, (_key, item) =>
        item && typeof item === "object" && !Array.isArray(item)
          ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
          : item,
      ),
    ),
  );
  return [...new Uint8Array(bytes)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export const stagingInstallationSchema = z
  .object({
    schema: z.literal(1),
    state: z.literal("installed"),
    holdId: z.uuid(),
    generation: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    policySha256: digest,
    installedAt: timestamp,
    predecessor: stagingPredecessorSchema,
    evidence: z
      .object({ maintenance: digest, window: digest, audit: digest, release: digest, originAudit: digest })
      .strict(),
  })
  .strict();

const releasedPredecessorViewSchema = stagingPredecessorSchema
  .omit({ policySha256: true, request: true })
  .extend({
    schema: z.literal(1),
    state: z.literal("released"),
    policySha256: digest.optional(),
    window: z.object({
      state: z.enum(["unverified", "expired"]),
      recordedState: z.literal("completed").optional(),
      recordId: z.uuid(),
      originalRecordSha256: digest,
      decisionSha256: digest,
      disposition: z.literal("operator-abandoned"),
      requestEnd: z.literal("unobserved"),
      nativeOutcome: z.literal("unverified"),
      stored: z.literal(1),
      excluded: z.literal(0),
      blocking: z.literal(1),
    }),
  })
  .passthrough();

/** The old projection cannot report the full policy digest. Its installed
 * policy is qualified separately; startup compares the complete stored value. */
export function releasedStagingPredecessorMatches(value: unknown, predecessor: StagingPredecessor): boolean {
  const parsed = releasedPredecessorViewSchema.safeParse(value);
  if (!parsed.success) return false;
  const row = parsed.data;
  return (
    row.holdId === predecessor.holdId &&
    row.generation === predecessor.generation &&
    row.fixtureSha256 === predecessor.fixtureSha256 &&
    row.decisionSha256 === predecessor.decisionSha256 &&
    row.releasedAt === predecessor.releasedAt &&
    row.releaseDecisionSha256 === predecessor.releaseDecisionSha256 &&
    (Object.keys(predecessor.attempt) as Array<keyof StagingPredecessor["attempt"]>).every(
      (key) => row.attempt[key] === predecessor.attempt[key],
    ) &&
    (row.policySha256 === undefined || row.policySha256 === predecessor.policySha256) &&
    row.window.recordId === predecessor.request.id &&
    row.window.originalRecordSha256 === predecessor.request.recordSha256 &&
    row.window.decisionSha256 === predecessor.decisionSha256
  );
}
