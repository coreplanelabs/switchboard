import { tracedFetch } from "./trace/tracedFetch.js";
import type { Span } from "./trace/types.js";
import type { PreparedStorageRequest } from "./storeResponse.js";
import type { StoreOperationKind } from "./storeResponse.js";
import { systemClock } from "./trace/clock.js";
import {
  reportStorageFailure,
  storageFailureNotice,
  STORAGE_REQUEST_ID_HEADER,
  STORAGE_REQUEST_DIGEST_HEADER,
  STORAGE_FAILURE_DIAGNOSTIC_HEADER,
  type StorageFailureNotice,
} from "./storageFailureDiagnostic.js";
import { stateWriteDiagnosticFromHeader } from "./runStateWriteDiagnostic.js";

/** Wire transport only. Callers retain their status, acknowledgement and retry policies. */
export async function storageTransport<T>(
  request: PreparedStorageRequest,
  options: {
    url: string | URL;
    headers: HeadersInit;
    signal: AbortSignal;
    timeoutMs: number;
    fetch?: typeof fetch;
    span?: Span;
    kind?: StoreOperationKind;
    redirect?: "error" | "follow" | "manual";
    onFailure?: (notice: StorageFailureNotice) => void;
    reportFailure?: false;
    exceptionDetails?: false;
    transportError?: (cause: unknown) => unknown;
  },
  receive: (response: Response) => Promise<T>,
): Promise<T> {
  const headers = new Headers(options.headers);
  if (request.requestId) headers.set(STORAGE_REQUEST_ID_HEADER, request.requestId);
  if (request.operation === "/runs/live-state" || request.operation === "/runs/session/write")
    headers.set(STORAGE_REQUEST_DIGEST_HEADER, request.digest);
  const startedAt = systemClock();
  let response: Response | undefined;
  const report = (error: unknown) => {
    if (options.reportFailure === false) return;
    reportStorageFailure(
      error,
      () => {
        let server =
          response && response.status >= 400
            ? stateWriteDiagnosticFromHeader(response.headers.get(STORAGE_FAILURE_DIAGNOSTIC_HEADER), request.digest)
            : undefined;
        if (options.exceptionDetails === false && server && "exception" in server) {
          const { exception: _exception, ...facts } = server;
          server = facts;
        }
        return storageFailureNotice(
          request,
          options.kind,
          response ? (response.ok ? "response" : "http") : "transport",
          error,
          response,
          server,
          {
            requestId: request.requestId,
            ...(options.exceptionDetails === false ? { exceptionDetails: false as const } : {}),
            timing: {
              elapsedMs: Math.max(0, systemClock() - startedAt),
              timeoutMs: options.timeoutMs,
              deadlineExceeded: options.signal.aborted,
            },
          },
        );
      },
      options.onFailure,
      request,
    );
  };
  try {
    try {
      const init = {
        method: "POST",
        headers: Object.fromEntries(headers),
        body: request.payload,
        signal: options.signal,
        ...(options.redirect ? { redirect: options.redirect } : {}),
      };
      response = options.span
        ? await tracedFetch(options.span, String(options.url), init, {
            route: request.operation,
            fetchImpl: options.fetch ?? fetch,
          })
        : await (options.fetch ?? fetch)(options.url, init);
    } catch (error) {
      throw options.transportError ? options.transportError(error) : error;
    }
    const result = await receive(response);
    if (!response.ok && response.status !== 409 && response.status !== 423)
      report(new Error("Storage HTTP request refused"));
    return result;
  } catch (error) {
    report(error);
    throw error;
  }
}
