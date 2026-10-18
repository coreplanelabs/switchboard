import { sourceHash } from "./references/receipts.js";
import { storageRequestContext, type StorageOperation, type StorageOperationBody } from "./storageRequestContext.js";
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
export async function storeRequestWitness(
  operation: string,
  payload: string,
  body?: unknown,
  requestId?: string,
): Promise<StoreRequestWitness> {
  // String-only callers decode once at admission, never while reporting a failure.
  if (body === undefined) {
    try {
      body = JSON.parse(payload);
    } catch {
      body = null;
    }
  }
  const context = storageRequestContext(operation, body);
  const events =
    operation === "/runs/append" && body && typeof body === "object" && !Array.isArray(body)
      ? (body as Record<string, unknown>).events
      : undefined;
  const diagnosticOnly =
    Array.isArray(events) &&
    events.length > 0 &&
    events.every(
      (event) => event && typeof event === "object" && event.type === "run_note" && event.kind === "storage_failure",
    );
  if (requestId === undefined) {
    try {
      requestId = crypto.randomUUID();
    } catch {
      /* Telemetry cannot prevent dispatch. */
    }
  }
  return Object.freeze({
    version: 1 as const,
    operation,
    payload,
    context,
    ...(requestId ? { requestId } : {}),
    ...(diagnosticOnly ? { diagnosticOnly: true as const } : {}),
    digest: await sourceHash({ operation, payload }),
  });
}

/** First-party requests cannot dispatch with a missing operation identity. */
const preparedRequest = Symbol("prepared-storage-request");
export type PreparedStorageRequest = StoreRequestWitness & {
  readonly [preparedRequest]: true;
  readonly context:
    | Exclude<import("./storageRequestContext.js").StorageRequestContext, { scope: "unresolved" }>
    | { readonly scope: "unresolved"; readonly reason: "legacy-identity" };
};
export async function prepareStorageRequest<O extends StorageOperation>(
  operation: O,
  body: StorageOperationBody<NoInfer<O>>,
  encodedBody?: string,
): Promise<PreparedStorageRequest> {
  const expected = storageRequestContext(operation, body);
  const serialized = encodedBody ?? JSON.stringify(body);
  let actualBody: unknown;
  try {
    actualBody = JSON.parse(serialized);
  } catch {
    throw new PermanentStoreError(`storage ${operation}: invalid encoded request`);
  }
  if (JSON.stringify(storageRequestContext(operation, actualBody)) !== JSON.stringify(expected))
    throw new PermanentStoreError(`storage ${operation}: encoded request identity mismatch`);
  const request = await storeRequestWitness(operation, serialized, actualBody);
  const context = request.context;
  if (
    !context ||
    (context.scope === "unresolved" && context.reason !== "legacy-identity") ||
    (operation === "/runs/session/write" && context.scope === "session")
  )
    throw new PermanentStoreError(`storage ${operation}: invalid request identity`);
  if (context.scope === "unresolved")
    return Object.freeze({
      ...request,
      [preparedRequest]: true as const,
      context: { scope: "unresolved" as const, reason: "legacy-identity" as const },
    });
  return Object.freeze({ ...request, [preparedRequest]: true as const, context });
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
