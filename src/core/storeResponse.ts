import { sourceHash } from "./references/receipts.js";
import {
  PermanentStoreError,
  TransientStoreError,
  UncertainStoreError,
  type StoreRequestWitness,
} from "./storeFailure.js";

export type StoreOperationKind = "read" | "write";

export const STORE_RESPONSE_BODY_KINDS = [
  "json",
  "html",
  "empty",
  "other",
  "unreadable",
  "not-read",
  "unknown",
] as const;
type StoreResponseBodyKind = (typeof STORE_RESPONSE_BODY_KINDS)[number];
const decodedBodies = new WeakMap<Response, StoreResponseBodyKind>();

/** Only a closed format survives decoding; response bytes never enter telemetry state. */
export function observedStoreResponseBodyKind(response: Response): StoreResponseBodyKind {
  return decodedBodies.get(response) ?? (response.bodyUsed ? "unknown" : "not-read");
}

export function unparsedStoreResponseBodyKind(body: string): "empty" | "html" | "other" {
  if (body.trim() === "") return "empty";
  return /^\s*(?:<!doctype\s+html|<html\b)/i.test(body) ? "html" : "other";
}

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
    decodedBodies.set(response, "unreadable");
    const message = `store ${request.operation}: response body interrupted (HTTP ${response.status})`;
    if (kind === "read") throw new TransientStoreError(message, { cause });
    throw new UncertainStoreError(message, request, {
      cause,
      diagnosis: { kind: "response-body", status: response.status },
    });
  }
  let value: unknown;
  try {
    value = JSON.parse(bytes);
  } catch (cause) {
    decodedBodies.set(response, unparsedStoreResponseBodyKind(bytes));
    const message = `store ${request.operation}: non-JSON body (HTTP ${response.status})`;
    if (kind === "read") throw new PermanentStoreError(message, { cause });
    throw new UncertainStoreError(message, request, {
      cause,
      diagnosis: { kind: "response-json", status: response.status },
    });
  }
  decodedBodies.set(response, "json");
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    const message = `store ${request.operation}: invalid response object (HTTP ${response.status})`;
    if (kind === "read") throw new PermanentStoreError(message);
    throw new UncertainStoreError(message, request, { diagnosis: { kind: "response-shape", status: response.status } });
  }
  return value as Record<string, unknown>;
}
