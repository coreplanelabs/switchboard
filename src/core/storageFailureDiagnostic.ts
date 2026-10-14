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
import type { StoreOperationKind } from "./storeResponse.js";
import { RUN_ID_PATTERN } from "./runIdentity.js";

export const STORAGE_FAILURE_DIAGNOSTIC_HEADER = "x-switchboard-storage-failure";
export const STORAGE_REQUEST_ID_HEADER = "x-switchboard-storage-request-id";

export function storageRequestIdOf(value: unknown): string | undefined {
  return typeof value === "string" && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(value)
    ? value
    : undefined;
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

/** Diagnosis only. It neither acknowledges nor permits replay of a mutation. */
export interface StorageFailureDiagnostic {
  version: 1;
  operation: string;
  requestDigest: string;
  requestId?: string;
  kind?: StoreOperationKind;
  phase: (typeof phases)[number];
  ownerGen?: string;
  httpStatus?: number;
  rayId?: string;
  exception?: StateWriteException;
  server?: StateWriteFailure;
  timing?: { elapsedMs: number; timeoutMs: number; deadlineExceeded: boolean };
}
export interface StorageFailureNotice {
  runIds: readonly string[];
  diagnostic: StorageFailureDiagnostic;
}

/** Correlation comes from the frozen request, never a caller's later edits. */
export function storageFailureNotice(
  request: StoreRequestWitness,
  kind: StoreOperationKind | undefined,
  phase: StorageFailureDiagnostic["phase"],
  error: unknown,
  response?: Response,
  server?: StateWriteFailure,
  observation?: Pick<StorageFailureDiagnostic, "timing" | "requestId">,
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
      ...(typeof ownerGen === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(ownerGen) ? { ownerGen } : {}),
      ...(response
        ? { httpStatus: response.status }
        : diagnosis && "status" in diagnosis
          ? { httpStatus: diagnosis.status }
          : {}),
      ...(ray && /^[a-f0-9]{16}(?:-[A-Z]{3})?$/.test(ray) ? { rayId: ray } : {}),
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
          "kind",
          "phase",
          "ownerGen",
          "httpStatus",
          "rayId",
          "exception",
          "server",
          "timing",
        ].includes(key),
    ) ||
    v.version !== 1 ||
    typeof v.operation !== "string" ||
    !/^\/(?:runs|plane)\/[a-z-]+(?:\/[a-z-]+){0,2}$/.test(v.operation) ||
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
