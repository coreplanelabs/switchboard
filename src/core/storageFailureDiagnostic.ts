import type { RunEvent } from "./runEvents.js";
import { cloudflareErrorMessage } from "./cloudflareErrors.js";
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
import { STORAGE_OPERATIONS, type StorageRequestContext } from "./storageRequestContext.js";

export const STORAGE_FAILURE_DIAGNOSTIC_HEADER = "x-switchboard-storage-failure";
export const STORAGE_REQUEST_ID_HEADER = "x-switchboard-storage-request-id";
/** Diagnostic correlation only. Receivers never use it to authorize or settle a write. */
export const STORAGE_REQUEST_DIGEST_HEADER = "x-switchboard-storage-request-digest";
export function storageRequestDigestOf(value: unknown): string | undefined {
  return typeof value === "string" && /^[a-f0-9]{64}$/.test(value) ? value : undefined;
}

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
  context: StorageRequestContext;
  diagnostic: StorageFailureDiagnostic;
}

const originalTransportDiagnostics = new WeakMap<object, StorageFailureDiagnostic>();
const reportedStorageFailures = new WeakSet<object>();
const LOG_TARGET_LIMIT = 200;

function clearStorageFailure(error: unknown): void {
  if (!error || typeof error !== "object") return;
  originalTransportDiagnostics.delete(error);
  reportedStorageFailures.delete(error);
}

/** Preserve closed observations on the original error without retaining exception prose. */
export function rememberStorageFailure(error: unknown, diagnostic: StorageFailureDiagnostic): void {
  if (!error || typeof error !== "object") return;
  const { exception: _exception, server: _server, ...closed } = diagnostic;
  const parsed = storageFailureDiagnosticOf(closed);
  if (parsed) {
    originalTransportDiagnostics.set(error, structuredClone(parsed));
    reportedStorageFailures.delete(error);
  }
}

export function originalStorageFailure(error: unknown): StorageFailureDiagnostic | undefined {
  const value = error && typeof error === "object" ? originalTransportDiagnostics.get(error) : undefined;
  return value && structuredClone(value);
}

/** Saved metadata alone does not prove that the primary operator log succeeded. */
export function storageFailureWasReported(error: unknown): boolean {
  return !!error && typeof error === "object" && reportedStorageFailures.has(error);
}

/** A domain wrapper keeps its cause's evidence without reporting the same failure twice. */
export function inheritStorageFailure(error: unknown, cause: unknown): void {
  const reported = storageFailureWasReported(cause);
  const diagnostic = originalStorageFailure(cause);
  if (diagnostic) rememberStorageFailure(error, diagnostic);
  if (error && typeof error === "object") {
    if (reported) reportedStorageFailures.add(error);
    else reportedStorageFailures.delete(error);
  }
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
  observation?: Pick<
    StorageFailureDiagnostic,
    "timing" | "requestId" | "requestedAt" | "response" | "httpStatus" | "rayId"
  > & { exceptionDetails?: false },
): StorageFailureNotice {
  const context = request.context ?? { scope: "unresolved" as const, reason: "malformed-target" as const };
  const runIds = context.scope === "runs" ? context.runIds : [];
  const ownerGen = context.scope === "runs" ? context.ownerGen : undefined;
  const diagnosis = error instanceof UncertainStoreError ? error.diagnosis : undefined;
  const observedPhase = diagnosis?.kind ?? phase;
  const ray = response?.headers.get("cf-ray") ?? observation?.rayId;
  const requestId = storageRequestIdOf(observation?.requestId ?? request.requestId);
  const responseFacts = observation?.response ?? (response ? storageResponseMetadata(response) : undefined);
  const notice: StorageFailureNotice = {
    runIds,
    context,
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
        : observation?.httpStatus !== undefined
          ? { httpStatus: observation.httpStatus }
          : diagnosis && "status" in diagnosis
            ? { httpStatus: diagnosis.status }
            : {}),
      ...(ray && /^[a-f0-9]{16}(?:-[A-Z]{3})?$/.test(ray) ? { rayId: ray } : {}),
      ...(responseFacts ? { response: responseFacts } : {}),
      // Decoder exceptions can quote private response bytes. Capture only the
      // transport exception; remote exceptions come from the validated header.
      ...(observedPhase === "transport" && observation?.exceptionDetails !== false
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
  notice.diagnostic = structuredClone(notice.diagnostic);
  const freeze = (value: unknown): void => {
    if (!value || typeof value !== "object" || Object.isFrozen(value)) return;
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  };
  freeze(notice);
  return notice;
}

/** Keep operator output below the platform log ceiling; callbacks keep the full notice. */
export function storageFailureLog(notice: StorageFailureNotice) {
  const context = notice.context.scope === "runs" ? { scope: "runs" as const } : notice.context;
  const diagnostic = { ...notice.diagnostic };
  const entry = {
    ...storageFailureTargets(notice.runIds),
    context,
    diagnostic,
    diagnosticDetailsOmitted: false,
  };
  if (new TextEncoder().encode(JSON.stringify(entry)).length > 24 * 1024) {
    delete diagnostic.exception;
    if (diagnostic.server && "exception" in diagnostic.server) {
      const { exception: _exception, ...facts } = diagnostic.server;
      diagnostic.server = facts;
    }
    entry.diagnosticDetailsOmitted = true;
  }
  if (new TextEncoder().encode(JSON.stringify(entry)).length > 24 * 1024)
    throw new RangeError("Storage diagnostic exceeds the operator log bound");
  return entry;
}

function storageFailureTargets(targets: readonly string[]) {
  const runIds = targets.slice(0, LOG_TARGET_LIMIT);
  return {
    runIds,
    targetCounts: { total: targets.length, emitted: runIds.length, omitted: targets.length - runIds.length },
  };
}

function emitUnavailableStorageFailure(
  request?: Pick<StoreRequestWitness, "operation" | "requestId" | "digest" | "context">,
): void {
  try {
    const operation = request && Object.hasOwn(STORAGE_OPERATIONS, request.operation) ? request.operation : "unknown";
    const requestId = storageRequestIdOf(request?.requestId);
    const digest = request && /^[a-f0-9]{64}$/.test(request.digest) ? request.digest : undefined;
    console.warn(
      JSON.stringify({
        event: "storage.request.failure.unavailable",
        side: "client",
        operation,
        ...(requestId ? { requestId } : {}),
        ...(digest ? { requestDigest: digest } : {}),
        ...storageFailureTargets(request?.context?.scope === "runs" ? request.context.runIds : []),
      }),
    );
  } catch {
    // Failed capture or logging cannot replace the original storage error.
  }
}

function emitPrimaryStorageFailure(notice: StorageFailureNotice): boolean {
  let reported = false;
  try {
    console.warn(JSON.stringify({ event: "storage.request.failure", side: "client", ...storageFailureLog(notice) }));
    reported = true;
  } catch {
    // The observer remains useful when the log sink fails.
    try {
      console.warn(
        JSON.stringify({ event: "storage.request.failure_telemetry_failed", side: "client", stage: "operator-log" }),
      );
    } catch {
      /* Keep the original request outcome. */
    }
  }
  return reported;
}

function notifyStorageFailure(notice: StorageFailureNotice, onFailure?: (notice: StorageFailureNotice) => void): void {
  try {
    onFailure?.(notice);
  } catch {
    // Telemetry cannot authorize a retry or change the original result.
  }
}

/** A failed log or observer must not replace the original storage outcome. */
export function emitStorageFailure(
  notice: StorageFailureNotice,
  onFailure?: (notice: StorageFailureNotice) => void,
): boolean {
  const reported = emitPrimaryStorageFailure(notice);
  notifyStorageFailure(notice, onFailure);
  return reported;
}

/** Retain the original boundary even when its log fails; observers do not confirm logging. */
export function reportStorageFailure(
  error: unknown,
  notice: StorageFailureNotice,
  onFailure?: (notice: StorageFailureNotice) => void,
): boolean;
export function reportStorageFailure(
  error: unknown,
  capture: () => StorageFailureNotice,
  onFailure: ((notice: StorageFailureNotice) => void) | undefined,
  request: StoreRequestWitness,
): boolean;
export function reportStorageFailure(
  error: unknown,
  noticeOrCapture: StorageFailureNotice | (() => StorageFailureNotice),
  onFailure?: (notice: StorageFailureNotice) => void,
  request?: StoreRequestWitness,
): boolean {
  clearStorageFailure(error);
  try {
    const notice = typeof noticeOrCapture === "function" ? noticeOrCapture() : noticeOrCapture;
    rememberStorageFailure(error, notice.diagnostic);
    const reported = emitPrimaryStorageFailure(notice);
    if (reported && error && typeof error === "object") reportedStorageFailures.add(error);
    notifyStorageFailure(notice, onFailure);
    return reported;
  } catch {
    clearStorageFailure(error);
    emitUnavailableStorageFailure(
      request ??
        (typeof noticeOrCapture !== "function"
          ? {
              operation: noticeOrCapture.diagnostic.operation,
              requestId: noticeOrCapture.diagnostic.requestId,
              digest: noticeOrCapture.diagnostic.requestDigest,
              context: noticeOrCapture.context,
            }
          : undefined),
    );
    return false;
  }
}

/** A diagnostic append cannot recursively create another diagnostic append. */
export function isStorageDiagnosticAppend(request: StoreRequestWitness): boolean {
  return request.operation === "/runs/append" && request.diagnosticOnly === true;
}

export function storageFailureNote(
  diagnostic: StorageFailureDiagnostic,
  originalSummary?: string,
): Extract<RunEvent, { type: "run_note" }> {
  const exception =
    diagnostic.server && "exception" in diagnostic.server ? diagnostic.server.exception : diagnostic.exception;
  const cause =
    diagnostic.server && "reason" in diagnostic.server
      ? `: ${diagnostic.server.reason}`
      : exception
        ? `: ${exception.name}: ${cloudflareErrorMessage(exception.message)}`
        : "";
  const keepOriginal = !exception || cloudflareErrorMessage(exception.message) === exception.message;
  return {
    type: "run_note",
    kind: "storage_failure",
    summary:
      originalSummary !== undefined && keepOriginal
        ? originalSummary
        : `Storage request failed: ${diagnostic.operation} (${diagnostic.phase}${diagnostic.httpStatus ? `, HTTP ${diagnostic.httpStatus}` : ""})${cause}`,
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
