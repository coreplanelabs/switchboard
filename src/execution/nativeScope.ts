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
