import { z } from "zod";

/** Trusted check identity, persisted before dispatch; never a model argument. */
export const checkOperationSchema = z
  .object({
    key: z.string().regex(/^[a-f0-9]{64}$/),
    commandHash: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();
export type CheckOperation = z.infer<typeof checkOperationSchema>;

export async function checkCommandHash(command: string): Promise<string> {
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(command));
  return Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** A typed, pre-admission refusal, never an uncertain command result. */
export class CheckCapacityError extends Error {}

export type CheckResultFailure =
  | "result_write_unconfirmed"
  | "operation_result_unavailable"
  | "check_capacity"
  | "lookup_transport_unavailable"
  | "lookup_refused"
  | "result_not_completed"
  | "result_identity_mismatch"
  | "result_ending_unproven"
  | "result_invalid";

/** Log only the controller's bounded identity and a closed failure code.
 * Error objects, command text and returned payloads are never diagnostic fields. */
export function reportCheckResultFailure(
  code: CheckResultFailure,
  owner: { threadKey?: string; runId?: string; ownerFence?: number },
  operation: CheckOperation,
): void {
  const { threadKey, runId, ownerFence } = owner;
  if (
    typeof threadKey !== "string" ||
    !threadKey ||
    threadKey.length > 256 ||
    typeof runId !== "string" ||
    !runId ||
    runId.length > 128 ||
    !Number.isSafeInteger(ownerFence) ||
    (ownerFence ?? 0) <= 0 ||
    !checkOperationSchema.safeParse(operation).success
  )
    return;
  try {
    console.warn(
      "[check-result]",
      JSON.stringify({ version: 1, code, threadKey, runId, ownerFence, operationKey: operation.key }),
    );
  } catch {
    /* Diagnostics cannot change command settlement. */
  }
}
