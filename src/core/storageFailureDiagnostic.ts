import type { RunEvent } from "./runEvents.js";
import {
  captureException,
  exceptionOf,
  stateWriteFailureOf,
  type StateWriteException,
  type StateWriteFailure,
} from "./runStateWriteDiagnostic.js";
import { TransientStoreError, UncertainStoreError } from "./storeFailure.js";
import type { StoreRequestWitness } from "./storeFailure.js";
import {
  storeRequestWitness,
  observedStoreResponseBodyKind,
  unparsedStoreResponseBodyKind,
  STORE_RESPONSE_BODY_KINDS,
  type StoreOperationKind,
} from "./storeResponse.js";
import { systemClock } from "./trace/clock.js";
import { RUN_ID_PATTERN } from "./runIdentity.js";

export const STORAGE_FAILURE_DIAGNOSTIC_HEADER = "x-switchboard-storage-failure";
export const STORAGE_REQUEST_ID_HEADER = "x-switchboard-storage-request-id";

export function storageRequestIdOf(value: unknown): string | undefined {
  return typeof value === "string" && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(value)
    ? value
    : undefined;
}

export function newStorageRequestId(): string | undefined {
  try {
    return storageRequestIdOf(crypto.randomUUID());
  } catch {
    return undefined;
  }
}
const phases = [
  "transport",
  "http",
  "response",
  "response-body",
  "response-json",
  "response-shape",
  "acknowledgement",
] as const;
const responseContentTypes = ["json", "html", "text", "other", "missing"] as const;

export interface StorageResponseMetadata {
  contentType: (typeof responseContentTypes)[number];
  bodyKind: (typeof STORE_RESPONSE_BODY_KINDS)[number];
}

/** Response format is evidence, never proof that a particular service answered. */
export function storageResponseMetadata(response: Response, body?: string | null): StorageResponseMetadata {
  const mediaType = response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
  const contentType = !mediaType
    ? "missing"
    : mediaType === "application/json" || mediaType.endsWith("+json")
      ? "json"
      : mediaType === "text/html"
        ? "html"
        : mediaType.startsWith("text/")
          ? "text"
          : "other";
  if (body === undefined) return { contentType, bodyKind: observedStoreResponseBodyKind(response) };
  if (body === null) return { contentType, bodyKind: "unreadable" };
  if (body.trim() === "") return { contentType, bodyKind: "empty" };
  try {
    JSON.parse(body);
    return { contentType, bodyKind: "json" };
  } catch {
    return { contentType, bodyKind: unparsedStoreResponseBodyKind(body) };
  }
}

/** Diagnosis only. It neither acknowledges nor permits replay of a mutation. */
export interface StorageFailureDiagnostic {
  version: 1;
  operation: string;
  requestDigest: string;
  requestId?: string;
  requestedAt?: number;
  kind?: StoreOperationKind;
  phase: (typeof phases)[number];
  ownerGen?: string;
  httpStatus?: number;
  rayId?: string;
  exception?: StateWriteException;
  server?: StateWriteFailure;
  response?: StorageResponseMetadata;
  timing?: { elapsedMs: number; timeoutMs: number; deadlineExceeded: boolean };
}
export interface StorageFailureNotice {
  runIds: readonly string[];
  diagnostic: StorageFailureDiagnostic;
}

const originalTransportDiagnostics = new WeakMap<object, StorageFailureDiagnostic>();

/** Preserve closed observations on the original error without retaining exception prose. */
export function rememberStorageFailure(error: unknown, diagnostic: StorageFailureDiagnostic): void {
  if (!error || typeof error !== "object") return;
  const { exception: _exception, server: _server, ...closed } = diagnostic;
  const parsed = storageFailureDiagnosticOf(closed);
  if (parsed) originalTransportDiagnostics.set(error, structuredClone(parsed));
}

export function originalStorageFailure(error: unknown): StorageFailureDiagnostic | undefined {
  const value = error && typeof error === "object" ? originalTransportDiagnostics.get(error) : undefined;
  return value && structuredClone(value);
}

export interface StorageFailureCapture {
  operation: string;
  payload: string;
  kind: StoreOperationKind;
  requestId?: string;
  requestedAt: number;
  timeoutMs: number;
  signal?: AbortSignal;
}

/** Config failures use the same notice without making diagnostics a request prerequisite. */
export async function captureStorageFailure(
  capture: StorageFailureCapture,
  phase: StorageFailureDiagnostic["phase"],
  response?: Response,
  body?: string | null,
  onFailure?: (notice: StorageFailureNotice) => void,
): Promise<void> {
  try {
    const timing = {
      elapsedMs: Math.max(0, systemClock() - capture.requestedAt),
      timeoutMs: capture.timeoutMs,
      deadlineExceeded: capture.signal?.aborted === true,
    };
    const responseFacts = response ? storageResponseMetadata(response, body) : undefined;
    const notice = storageFailureNotice(
      await storeRequestWitness(capture.operation, capture.payload),
      capture.kind,
      phase,
      new Error("Storage request failed"),
      response,
      undefined,
      {
        requestId: capture.requestId,
        requestedAt: capture.requestedAt,
        ...(responseFacts ? { response: responseFacts } : {}),
        timing,
      },
    );
    emitStorageFailure(notice, onFailure);
  } catch {
    // A diagnostic failure cannot replace the original request outcome.
  }
}

/** Correlation comes from the frozen request, never a caller's later edits. */
export function storageFailureNotice(
  request: StoreRequestWitness,
  kind: StoreOperationKind | undefined,
  phase: StorageFailureDiagnostic["phase"],
  error: unknown,
  response?: Response,
  server?: StateWriteFailure,
  observation?: Pick<StorageFailureDiagnostic, "timing" | "requestId" | "requestedAt" | "response">,
): StorageFailureNotice {
  let body: Record<string, unknown> = {};
  try {
    body = JSON.parse(request.payload) as Record<string, unknown>;
  } catch {
    /* No identity is invented for unreadable requests. */
  }
  const recordOf = (value: unknown): Record<string, unknown> =>
    value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
  const owners = [body?.run, body?.owner, body?.allocation, body?.confirm, body?.reference, body?.release].map(
    recordOf,
  );
  const record = recordOf(body?.record);
  const outcomes = Array.isArray(body?.outcomes) ? body.outcomes.map(recordOf) : [];
  const ids = [
    body?.runId,
    body?.sourceRunId,
    record.id,
    request.operation === "/runs/get" ? body?.id : undefined,
    ...owners.map((owner) => owner.runId),
    ...(Array.isArray(body?.runIds) ? body.runIds : []),
    ...outcomes.map((outcome) => outcome.runId),
  ];
  const runIds = [...new Set(ids.filter((id): id is string => typeof id === "string" && RUN_ID_PATTERN.test(id)))];
  const ownerGen =
    body?.gen ?? body?.ownerGen ?? owners.map((owner) => owner.gen ?? owner.ownerGen).find((gen) => gen !== undefined);
  const diagnosis = error instanceof UncertainStoreError ? error.diagnosis : undefined;
  const observedPhase = diagnosis?.kind ?? phase;
  const ray = response?.headers.get("cf-ray");
  const requestId = storageRequestIdOf(observation?.requestId);
  return {
    runIds,
    diagnostic: {
      version: 1,
      operation: request.operation,
      requestDigest: request.digest,
      ...(kind ? { kind } : {}),
      phase: observedPhase,
      ...(observation?.timing ? { timing: observation.timing } : {}),
      ...(requestId ? { requestId } : {}),
      ...(observation?.requestedAt !== undefined ? { requestedAt: observation.requestedAt } : {}),
      ...(typeof ownerGen === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(ownerGen) ? { ownerGen } : {}),
      ...(response
        ? { httpStatus: response.status }
        : diagnosis && "status" in diagnosis
          ? { httpStatus: diagnosis.status }
          : {}),
      ...(ray && /^[a-f0-9]{16}(?:-[A-Z]{3})?$/.test(ray) ? { rayId: ray } : {}),
      ...(response ? { response: observation?.response ?? storageResponseMetadata(response) } : {}),
      // Decoder exceptions can quote private response bytes. Capture only the
      // transport exception; remote exceptions come from the validated header.
      ...(observedPhase === "transport"
        ? {
            exception: captureException(
              (error instanceof UncertainStoreError || error instanceof TransientStoreError) &&
                error.cause !== undefined
                ? error.cause
                : error,
            ),
          }
        : {}),
      ...(server
        ? { server }
        : diagnosis?.kind === "http" && diagnosis.stateWrite
          ? { server: diagnosis.stateWrite }
          : {}),
    },
  };
}

/** A failed log or observer must not replace the original storage outcome. */
export function emitStorageFailure(
  notice: StorageFailureNotice,
  onFailure?: (notice: StorageFailureNotice) => void,
): void {
  try {
    console.warn(JSON.stringify({ event: "storage.request.failure", side: "client", ...notice }));
  } catch {
    // The observer remains useful when the log sink fails.
  }
  try {
    onFailure?.(notice);
  } catch {
    // Telemetry cannot authorize a retry or change the original result.
  }
}

/** A diagnostic append cannot recursively create another diagnostic append. */
export function isStorageDiagnosticAppend(request: StoreRequestWitness): boolean {
  if (request.operation !== "/runs/append") return false;
  try {
    const { events } = JSON.parse(request.payload) as { events?: unknown[] };
    return (
      Array.isArray(events) &&
      events.length > 0 &&
      events.every(
        (event) =>
          event &&
          typeof event === "object" &&
          "type" in event &&
          event.type === "run_note" &&
          "kind" in event &&
          event.kind === "storage_failure",
      )
    );
  } catch {
    return false;
  }
}

export function storageFailureNote(diagnostic: StorageFailureDiagnostic): RunEvent {
  const exception =
    diagnostic.server && "exception" in diagnostic.server ? diagnostic.server.exception : diagnostic.exception;
  const cause =
    diagnostic.server && "reason" in diagnostic.server
      ? `: ${diagnostic.server.reason}`
      : exception
        ? `: ${exception.name}: ${exception.message}`
        : "";
  return {
    type: "run_note",
    kind: "storage_failure",
    summary: `Storage request failed: ${diagnostic.operation} (${diagnostic.phase}${diagnostic.httpStatus ? `, HTTP ${diagnostic.httpStatus}` : ""})${cause}`,
    storageFailure: diagnostic,
  };
}

/** Validate external captures before retaining optional structured evidence. */
export function storageFailureDiagnosticOf(value: unknown): StorageFailureDiagnostic | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return;
  const v = value as Record<string, unknown>;
  if (
    Object.keys(v).some(
      (key) =>
        ![
          "version",
          "operation",
          "requestDigest",
          "requestId",
          "requestedAt",
          "kind",
          "phase",
          "ownerGen",
          "httpStatus",
          "rayId",
          "exception",
          "server",
          "timing",
          "response",
        ].includes(key),
    ) ||
    v.version !== 1 ||
    typeof v.operation !== "string" ||
    !/^(?:\/(?:runs|plane)\/[a-z-]+(?:\/[a-z-]+){0,2}|\/config\/(?:get|put))$/.test(v.operation) ||
    v.operation.length > 100 ||
    typeof v.requestDigest !== "string" ||
    !/^[a-f0-9]{64}$/.test(v.requestDigest) ||
    (v.kind !== undefined && v.kind !== "read" && v.kind !== "write") ||
    !phases.includes(v.phase as StorageFailureDiagnostic["phase"])
  )
    return;
  if (v.ownerGen !== undefined && (typeof v.ownerGen !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(v.ownerGen)))
    return;
  if (
    v.httpStatus !== undefined &&
    (!Number.isInteger(v.httpStatus) || Number(v.httpStatus) < 100 || Number(v.httpStatus) > 599)
  )
    return;
  if (v.rayId !== undefined && (typeof v.rayId !== "string" || !/^[a-f0-9]{16}(?:-[A-Z]{3})?$/.test(v.rayId))) return;
  if (v.requestId !== undefined && !storageRequestIdOf(v.requestId)) return;
  if (v.requestedAt !== undefined && (!Number.isSafeInteger(v.requestedAt) || Number(v.requestedAt) < 0)) return;
  if (v.response !== undefined) {
    if (!v.response || typeof v.response !== "object" || Array.isArray(v.response)) return;
    const response = v.response as Record<string, unknown>;
    if (
      Object.keys(response).some((key) => !["contentType", "bodyKind"].includes(key)) ||
      !(responseContentTypes as readonly unknown[]).includes(response.contentType) ||
      !(STORE_RESPONSE_BODY_KINDS as readonly unknown[]).includes(response.bodyKind)
    )
      return;
  }
  const server = v.server === undefined ? undefined : stateWriteFailureOf(v.server);
  if (v.timing !== undefined) {
    if (!v.timing || typeof v.timing !== "object" || Array.isArray(v.timing)) return;
    const timing = v.timing as Record<string, unknown>;
    if (
      Object.keys(timing).some((key) => !["elapsedMs", "timeoutMs", "deadlineExceeded"].includes(key)) ||
      !Number.isSafeInteger(timing.elapsedMs) ||
      Number(timing.elapsedMs) < 0 ||
      !Number.isSafeInteger(timing.timeoutMs) ||
      Number(timing.timeoutMs) < 1 ||
      typeof timing.deadlineExceeded !== "boolean"
    )
      return;
  }
  const captured = v.exception === undefined ? undefined : exceptionOf(v.exception);
  if ((v.server !== undefined && !server) || (v.exception !== undefined && !captured)) return;
  return {
    ...v,
    ...(server ? { server } : {}),
    ...(captured ? { exception: captured } : {}),
  } as unknown as StorageFailureDiagnostic;
}
