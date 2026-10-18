import { z } from "zod";

/** Immutable identity shared by native scope control and its state authority. */
export const nativeScopeRefSchema = z
  .object({
    version: z.literal(1),
    id: z.string().uuid(),
    boot: z.string().uuid(),
    threadKey: z.string().min(1),
    owner: z.object({
      runId: z.string().min(1),
      ownerGen: z.string().min(1),
      ownerFence: z.number().int().positive(),
    }),
  })
  .strict();
export type NativeScopeRef = z.infer<typeof nativeScopeRefSchema>;

export const nativeOperatorOwnerSchema = z
  .object({ opOwner: z.string().regex(/^op:[A-Za-z0-9_.:-]{1,124}$/) })
  .strict();
export type NativeOperatorOwner = z.infer<typeof nativeOperatorOwnerSchema>;

/** Operator work has its own authority. It cannot impersonate a run or thread. */
export const nativeOperatorScopeRefSchema = z
  .object({
    version: z.literal(1),
    kind: z.literal("operation"),
    id: z.string().uuid(),
    boot: z.string().uuid(),
    owner: nativeOperatorOwnerSchema,
  })
  .strict();
export type NativeOperatorScopeRef = z.infer<typeof nativeOperatorScopeRefSchema>;
export const nativeExecutionScopeRefSchema = z.union([nativeScopeRefSchema, nativeOperatorScopeRefSchema]);
export type NativeExecutionScopeRef = z.infer<typeof nativeExecutionScopeRefSchema>;
