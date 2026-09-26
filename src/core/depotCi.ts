// The node-free contract shared by the bot's repo-bound client and the edge.
// No generic RPC, arbitrary URL or credential can be supplied by a child.
import { z } from "zod";

export const DEPOT_CI_PATH = "/internal/depot-ci";
export const DEPOT_CI_AUTHORIZATION_PATH = "/internal/depot-ci/authorization";
export const depotCiTicketSchema = z.object({ ticket: z.string().regex(/^[a-f0-9]{64}$/) }).strict();
export const DEPOT_CI_MAX_BYTES = 2 * 1024 * 1024;
export const depotId = z.string().regex(/^[A-Za-z0-9_-]{1,160}$/);
const common = { workflowId: depotId };
export const depotOperationSchema = z.discriminatedUnion("operation", [
  z.object({ ...common, operation: z.literal("inspect") }).strict(),
  z
    .object({
      ...common,
      operation: z.literal("logs"),
      jobId: depotId,
      attemptId: depotId.optional(),
      lines: z.number().int().min(1).max(2000).optional(),
    })
    .strict(),
  z
    .object({ ...common, operation: z.literal("retry_failed"), expectedHead: z.string().regex(/^[a-f0-9]{40}$/i) })
    .strict(),
]);
export type DepotOperation = z.infer<typeof depotOperationSchema>;
/** Read only from the fixed bot callback, never from the bridge request. */
export const depotCiGrantSchema = z
  .object({
    runId: depotId,
    repo: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}\/[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$/),
    operation: depotOperationSchema,
  })
  .strict();
export type DepotCiGrant = z.infer<typeof depotCiGrantSchema>;
export interface DepotCi {
  call(operation: DepotOperation, signal?: AbortSignal): Promise<Record<string, unknown>>;
}

/** Fixed messages shared across the bridge; upstream bodies are never errors. */
export const DEPOT_ERRORS = {
  invalid: "Depot CI: invalid operation.",
  unauthorized: "Depot CI: run authorization expired or refused.",
  unavailable: "Depot CI unavailable: DEPOT_API_TOKEN is not configured at the Worker.",
  notFound: "Depot CI: workflow, job or attempt not found in the bound repository.",
  stale: "Depot CI: head mismatch or workflow is not failed/cancelled; inspect before retry.",
  unknown: "Depot retry outcome unknown; inspect before another request.",
  failed: "Depot CI upstream response invalid or unavailable.",
} as const;

/** Read through a byte ceiling, including chunked responses. A partial JSON
 * response is never parsed or returned. Callers supply the operation deadline. */
export async function depotJson(response: Response, limit = DEPOT_CI_MAX_BYTES): Promise<unknown> {
  if (!response.body) throw new Error("empty response");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let bytes = 0;
  let text = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > limit) throw new Error("response too large");
      text += decoder.decode(value, { stream: true });
    }
    return JSON.parse(text + decoder.decode()) as unknown;
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
