import { z } from "zod";

/** Registered purpose and placement data. Schema validity alone never grants
 * a lifetime: only a registered definition supplies it to a fresh run. */
export const resourceLifetimeSchema = z.union([
  z.strictObject({
    version: z.literal(1),
    purpose: z.literal("retained-work"),
    resident: z.literal("retained"),
    cold: z.literal("retained"),
  }),
  z.strictObject({
    version: z.literal(1),
    purpose: z.literal("pull-request-review"),
    resident: z.literal("retained"),
    cold: z.strictObject({
      kind: z.literal("exclusive-scratch"),
      scope: z.literal("original-cold-allocation"),
      custody: z.literal("session-report-and-review-publication"),
    }),
  }),
]);

export type ResourceLifetimeDeclaration = z.infer<typeof resourceLifetimeSchema>;

/** Missing or unreadable registered data cannot establish scratch policy. */
export function resourceLifetimeOrRetained(value: unknown): ResourceLifetimeDeclaration {
  const parsed = resourceLifetimeSchema.safeParse(value);
  return parsed.success
    ? structuredClone(parsed.data)
    : {
        version: 1,
        purpose: "retained-work",
        resident: "retained",
        cold: "retained",
      };
}

export function sameResourceLifetime(left: unknown, right: unknown): boolean {
  const a = resourceLifetimeSchema.safeParse(left),
    b = resourceLifetimeSchema.safeParse(right);
  return a.success && b.success && JSON.stringify(a.data) === JSON.stringify(b.data);
}
