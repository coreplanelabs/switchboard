import { z } from "zod";
import { nativeScopeRefSchema } from "./nativeScope.js";

export const nativeRetirementTargetSchema = z
  .object({
    resource: z
      .string()
      .regex(/^repo:[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/)
      .max(128),
    key: z.string().min(1).max(2048),
    recordHash: z.string().regex(/^[a-f0-9]{64}$/),
    scope: nativeScopeRefSchema,
  })
  .strict()
  .refine((v) => v.key.startsWith(`native-operation:${v.scope.threadKey}:${v.scope.owner.runId}:`));
export type NativeRetirementTarget = z.infer<typeof nativeRetirementTargetSchema>;
const sourceSchema = z
  .object({
    id: z.string().min(1),
    threadKey: z.string().min(1),
    repo: z.string().min(1),
    status: z.enum(["completed", "failed", "interrupted", "stopped_soft", "stopped_hard"]),
    startedAt: z.number().finite().nonnegative(),
    finishedAt: z.number().finite().nonnegative(),
    sealedAt: z.number().finite().nonnegative(),
  })
  .strict();
export function nativeRetirementSource(value: unknown): z.infer<typeof sourceSchema> | undefined {
  if (!value || typeof value !== "object") return;
  const v = value as Record<string, unknown>;
  if (v.provisional !== undefined || v.restarting !== undefined) return;
  const parsed = sourceSchema.safeParse(Object.fromEntries(Object.keys(sourceSchema.shape).map((k) => [k, v[k]])));
  return parsed.success ? parsed.data : undefined;
}
export const nativeRetirementPermitSchema = z
  .object({
    version: z.literal(1),
    purpose: z.literal("terminal-native-scope"),
    id: z.string().uuid(),
    target: nativeRetirementTargetSchema,
    source: sourceSchema,
  })
  .strict()
  .refine(
    (v) =>
      v.source.id === v.target.scope.owner.runId &&
      v.source.threadKey === v.target.scope.threadKey &&
      v.target.resource === `repo:${v.source.repo}`,
  );
export type NativeRetirementPermit = z.infer<typeof nativeRetirementPermitSchema>;
export type NativeRetirementPreparation =
  | { kind: "prepared"; permit: NativeRetirementPermit }
  | { kind: "held"; reason: "owner-live" | "terminal-source-unavailable" };
export const nativeRetirementTargetKey = (target: NativeRetirementTarget): string => JSON.stringify(target);
