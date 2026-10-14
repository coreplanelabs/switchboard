import { z } from "zod";
import type { CheckInspection, CheckSelector } from "../core/checkInspection.js";
import { RUN_STORE_TIMEOUT_MS } from "../core/runStoreConstants.js";
import { processSecrets, type Secrets } from "../secrets.js";
import type { ExecutionConfig } from "./factory.js";

const inspectionSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("known"),
      source: z.enum(["canonical", "resident"]),
      result: z
        .object({
          stdout: z.string().max(4_000),
          stderr: z.string().max(4_000),
          exitCode: z.number().int().min(0).max(255),
          truncated: z.boolean(),
        })
        .strict(),
    })
    .strict(),
  z.object({ kind: z.literal("pending"), reason: z.literal("native_ending_unproven") }).strict(),
  z
    .object({
      kind: z.literal("retired"),
      reason: z.enum(["output_retired", "native_ended"]),
      proofHash: z
        .string()
        .regex(/^[a-f0-9]{64}$/)
        .optional(),
    })
    .strict(),
  z
    .object({ kind: z.literal("unavailable"), reason: z.enum(["source", "identity", "proof", "backend", "live"]) })
    .strict(),
]);

/** Read or retire an original check. The receiver resolves every identity from its own stores. */
export function createRunCheck(
  execution: ExecutionConfig | undefined,
  secrets: Secrets = processSecrets,
  fetchImpl = fetch,
): ((selector: CheckSelector, settle: boolean, expectedSourceHash: string) => Promise<CheckInspection>) | undefined {
  const url = execution?.resident?.baseUrl;
  if (!url) return undefined;
  return async (selector, settle, expectedSourceHash) => {
    const unavailable: CheckInspection = { kind: "unavailable", reason: "backend" };
    const token = secrets.named(execution?.resident?.tokenEnv ?? "RESIDENT_OPERATOR_TOKEN");
    if (!token) return unavailable;
    try {
      const response = await fetchImpl(new URL(settle ? "/settle-check" : "/inspect-check", url), {
        method: "POST",
        headers: { authorization: `Bearer ${token.reveal()}`, "content-type": "application/json" },
        body: JSON.stringify({ runId: selector.runId, callId: selector.callId, phase: selector.phase }),
        signal: AbortSignal.timeout(RUN_STORE_TIMEOUT_MS),
      });
      if (!response.ok) return unavailable;
      const body = await response.json();
      const parsed = z
        .object({
          sourceHash: z.string().regex(/^[a-f0-9]{64}$/),
          inspection: inspectionSchema,
        })
        .strict()
        .safeParse(body);
      if (!parsed.success) {
        const refused = inspectionSchema.safeParse(body);
        return refused.success && refused.data.kind === "unavailable" ? refused.data : unavailable;
      }
      // The receiver rereads Memory itself; its evidence must still belong to
      // the exact identity the command authorized before making this request.
      if (parsed.data.sourceHash !== expectedSourceHash) return { kind: "unavailable", reason: "identity" };
      return parsed.data.inspection;
    } catch {
      // A lost acknowledgement never triggers a second settlement request.
      return unavailable;
    }
  };
}
