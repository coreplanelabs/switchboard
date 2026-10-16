import { z } from "zod";
import { GEN_PATTERN } from "./types.js";
import { RUN_ID_PATTERN, CHANNEL_VISIBILITIES, isRunVisibilityFilter, type RunVisibilityFilter } from "../runRecord.js";
import { storageFailureDiagnosticOf, type StorageFailureDiagnostic } from "../storageFailureDiagnostic.js";

/** An observation is not a live run, a current hold, or a claim acknowledgement. */
export type ClaimTransportDiagnostic = Pick<
  StorageFailureDiagnostic,
  "version" | "operation" | "requestDigest" | "kind" | "phase" | "ownerGen" | "httpStatus" | "requestId" | "timing"
>;

export interface NativeClaimObservation {
  version: 1;
  runId: string;
  gen: string;
  channelId: string;
  threadKey: string;
  userId: string;
  channelVisibility: (typeof CHANNEL_VISIBILITIES)[number];
  repo?: string;
  startedAt: number;
  observedAt: number;
  outcome: "unknown";
  attempts: 1;
  diagnostic?: ClaimTransportDiagnostic;
}

const identity = z.string().min(1).max(512);
const timestamp = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const observation = z
  .object({
    version: z.literal(1),
    runId: z.string().regex(RUN_ID_PATTERN),
    gen: z.string().regex(GEN_PATTERN),
    channelId: identity,
    threadKey: identity,
    userId: identity,
    channelVisibility: z.enum(CHANNEL_VISIBILITIES),
    repo: z
      .string()
      .regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/)
      .max(256)
      .optional(),
    startedAt: timestamp,
    observedAt: timestamp,
    outcome: z.literal("unknown"),
    attempts: z.literal(1),
    diagnostic: z.unknown().optional(),
  })
  .strict();

/** Reuse the transport parser, but never persist exception prose or response bodies. */
export function claimTransportDiagnostic(value: unknown): ClaimTransportDiagnostic | undefined {
  const parsed = storageFailureDiagnosticOf(value);
  if (!parsed || parsed.operation !== "/runs/claim" || parsed.kind !== "write") return;
  return {
    version: 1,
    operation: parsed.operation,
    requestDigest: parsed.requestDigest,
    kind: "write",
    phase: parsed.phase,
    ...(parsed.ownerGen ? { ownerGen: parsed.ownerGen } : {}),
    ...(parsed.httpStatus === undefined ? {} : { httpStatus: parsed.httpStatus }),
    ...(parsed.requestId ? { requestId: parsed.requestId } : {}),
    ...(parsed.timing ? { timing: { ...parsed.timing } } : {}),
  };
}

export function nativeClaimObservationOf(value: unknown): NativeClaimObservation | undefined {
  const parsed = observation.safeParse(value);
  if (!parsed.success) return;
  const { diagnostic: raw, ...fields } = parsed.data;
  if (raw === undefined) return fields;
  const diagnostic = claimTransportDiagnostic(raw);
  // Reject private or extra fields at the durable boundary instead of silently retaining them.
  if (
    !diagnostic ||
    Object.keys(raw as object).some(
      (key) =>
        ![
          "version",
          "operation",
          "requestDigest",
          "kind",
          "phase",
          "ownerGen",
          "httpStatus",
          "requestId",
          "timing",
        ].includes(key),
    ) ||
    (diagnostic.ownerGen !== undefined && diagnostic.ownerGen !== fields.gen)
  )
    return;
  return { ...fields, diagnostic };
}

export const claimObservationKey = (value: Pick<NativeClaimObservation, "runId" | "gen">): string =>
  `${value.runId}|${value.gen}`;

export interface ClaimObservationQuery {
  visibleTo: RunVisibilityFilter;
  ordinaryOnly?: true;
  after?: string;
  limit?: number;
}
export interface ClaimObservationPage {
  observations: NativeClaimObservation[];
  nextAfter?: string;
  /** A failed diagnostic write can leave no row. Absence never proves no unknown claim. */
  coverage: "recorded-only";
}

export const claimObservationCursor = z.string().regex(/^[A-Za-z0-9_-]{1,64}\|[A-Za-z0-9_.:-]{1,128}$/);

export function claimObservationQueryOf(value: unknown): ClaimObservationQuery | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return;
  const v = value as Record<string, unknown>;
  if (
    Object.keys(v).some((key) => !["visibleTo", "after", "limit", "ordinaryOnly"].includes(key)) ||
    !isRunVisibilityFilter(v.visibleTo)
  )
    return;
  if (v.ordinaryOnly !== undefined && v.ordinaryOnly !== true) return;
  if (v.limit !== undefined && (!Number.isInteger(v.limit) || Number(v.limit) < 1 || Number(v.limit) > 200)) return;
  if (v.after !== undefined && !claimObservationCursor.safeParse(v.after).success) return;
  return {
    visibleTo: structuredClone(v.visibleTo),
    ...(v.ordinaryOnly === true ? { ordinaryOnly: true as const } : {}),
    ...(v.after === undefined ? {} : { after: v.after as string }),
    ...(v.limit === undefined ? {} : { limit: v.limit as number }),
  };
}
