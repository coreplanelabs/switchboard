import { sourceHash } from "./references/receipts.js";
import {
  PermanentStoreError,
  TransientStoreError,
  UncertainStoreError,
  type StoreRequestWitness,
} from "./storeFailure.js";

export type StoreOperationKind = "read" | "write";

/** Freeze before the first transport await; later caller edits cannot change
 * the bytes or identity used to reconcile an uncertain operation. */
export async function storeRequestWitness(operation: string, payload: string): Promise<StoreRequestWitness> {
  return Object.freeze({ version: 1 as const, operation, payload, digest: await sourceHash({ operation, payload }) });
}

export async function readStoreResponse(
  response: Response,
  kind: StoreOperationKind,
  request: StoreRequestWitness,
): Promise<Record<string, unknown>> {
  let bytes: string;
  try {
    bytes = await response.text();
  } catch (cause) {
    const message = `store ${request.operation}: response body interrupted (HTTP ${response.status})`;
    if (kind === "read") throw new TransientStoreError(message, { cause });
    throw new UncertainStoreError(message, request, { cause });
  }
  let value: unknown;
  try {
    value = JSON.parse(bytes);
  } catch (cause) {
    const message = `store ${request.operation}: non-JSON body (HTTP ${response.status})`;
    if (kind === "read") throw new PermanentStoreError(message, { cause });
    throw new UncertainStoreError(message, request, { cause });
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    const message = `store ${request.operation}: invalid response object (HTTP ${response.status})`;
    if (kind === "read") throw new PermanentStoreError(message);
    throw new UncertainStoreError(message, request);
  }
  return value as Record<string, unknown>;
}
