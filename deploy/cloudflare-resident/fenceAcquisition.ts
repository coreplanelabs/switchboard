import { z } from "zod";

export const FENCE_ACQUISITION_PREFIX = "deploy:fence-acquisition:";
const RECORD_BYTES = 8 * 1024;
const identity = z.uuid().regex(/^[0-9a-f-]{36}$/);
const requestSchema = z.object({ id: identity }).strict();
const build = z.string().min(1).max(200);
const timestamp = z
  .string()
  .max(64)
  .regex(/^\d{4}-\d\d-\d\dT[\d:.]+(?:Z|[+-]\d\d:\d\d)$/)
  .refine((value) => Number.isFinite(Date.parse(value)));
const ordinaryFields = {
  since: timestamp,
  until: timestamp,
  by: z.string().max(80),
  reason: z.string().max(200),
  holds: z.array(z.string()).optional(),
  holdsUntil: timestamp.optional(),
  liftAsked: z.boolean().optional(),
};
function noUndefined(value: Record<string, unknown>, ctx: z.RefinementCtx) {
  if (Object.values(value).some((entry) => entry === undefined))
    ctx.addIssue({ code: "custom", message: "present fields must have values" });
}
const ordinaryDrainSchema = z.object(ordinaryFields).strict().superRefine(noUndefined);
const fencedDrainSchema = z
  .object({
    ...ordinaryFields,
    swapFence: z.literal(true),
    swapBuild: build,
    swapVersion: identity,
    swapAt: timestamp,
    swapAcquisitionId: identity,
  })
  .strict()
  .superRefine(noUndefined);
const base = {
  schema: z.literal(1),
  purpose: z.literal("deploy-fence-acquisition"),
  id: identity,
  workerVersion: identity,
  build,
};
const snapshots = { originalDrain: ordinaryDrainSchema, fencedRecord: fencedDrainSchema };
const acquisitionSchema = z
  .discriminatedUnion("phase", [
    z.object({ ...base, ...snapshots, phase: z.literal("preparing") }).strict(),
    z.object({ ...base, ...snapshots, phase: z.literal("sealed") }).strict(),
    z
      .object({
        ...base,
        phase: z.literal("abandoned"),
        originalDrain: ordinaryDrainSchema.optional(),
        fencedRecord: fencedDrainSchema.optional(),
        disposition: z.enum(["cancelled-before-install", "fence-withdrawn"]),
      })
      .strict(),
  ])
  .superRefine((row, ctx) => {
    noUndefined(row, ctx);
    const fence = row.fencedRecord;
    if (
      fence &&
      (fence.swapAcquisitionId !== row.id || fence.swapVersion !== row.workerVersion || fence.swapBuild !== row.build)
    )
      ctx.addIssue({ code: "custom", message: "fence producer mismatch" });
    const original = row.originalDrain;
    if (fence && original && (["since", "until", "by", "reason"] as const).some((key) => fence[key] !== original[key]))
      ctx.addIssue({ code: "custom", message: "ordinary drain mismatch" });
    if (row.phase === "abandoned") {
      const complete = row.originalDrain !== undefined && fence !== undefined;
      if (
        (row.disposition === "fence-withdrawn" && !complete) ||
        (row.disposition === "cancelled-before-install" &&
          (Object.hasOwn(row, "originalDrain") || Object.hasOwn(row, "fencedRecord")))
      )
        ctx.addIssue({ code: "custom", message: "abandonment snapshots mismatch" });
    }
  });

export type FenceAcquisition = z.infer<typeof acquisitionSchema>;

export function validFenceAcquisitionId(value: unknown): value is string {
  return identity.safeParse(value).success;
}

export function fenceAcquisitionRequestId(value: unknown): string | undefined {
  const parsed = requestSchema.safeParse(value);
  return parsed.success ? parsed.data.id : undefined;
}

/** Presence must survive even when an old or corrupt row cannot grant authority. */
export function hasFenceAcquisition(value: unknown): boolean {
  return value !== null && typeof value === "object" && Object.hasOwn(value, "swapAcquisitionId");
}

export function ordinaryAcquisitionDrain(value: unknown) {
  const parsed = ordinaryDrainSchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}

export function fenceAcquisitionOf(value: unknown): FenceAcquisition | undefined {
  try {
    if (new TextEncoder().encode(JSON.stringify(value)).byteLength > RECORD_BYTES) return;
  } catch {
    return;
  }
  const parsed = acquisitionSchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}

/** Compare parsed raw fields and their presence, never the lossy live projection. */
export function ownsAcquisitionFence(
  row: FenceAcquisition,
  current: unknown,
  workerVersion: string | null,
  producerBuild: string,
): boolean {
  if (row.phase === "abandoned" || row.workerVersion !== workerVersion || row.build !== producerBuild) return false;
  const parsed = fencedDrainSchema.safeParse(current);
  const flat = (value: Record<string, unknown>) =>
    JSON.stringify(
      Object.keys(value)
        .sort()
        .map((key) => [key, value[key]]),
    );
  return parsed.success && flat(parsed.data) === flat(row.fencedRecord);
}

export function fenceAcquisitionReceipt(row: FenceAcquisition) {
  return {
    schema: row.schema,
    purpose: row.purpose,
    id: row.id,
    phase: row.phase,
    workerVersion: row.workerVersion,
    build: row.build,
    ...(row.phase === "abandoned" ? { disposition: row.disposition } : {}),
  };
}
