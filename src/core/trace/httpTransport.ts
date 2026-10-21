import { systemClock } from "./clock.js";
import { newSpanId } from "./ids.js";

/** Fetch settles at response headers. Reading a response body is the caller's work. */
export interface HttpTransportEvent {
  event: "http.transport";
  id: string;
  stage: "send" | "headers" | "error";
  at: number;
  host?: string;
  method?: string;
  elapsedMs?: number;
  status?: number;
  requestId?: string;
  cause?: "abort" | "timeout" | "transport";
  errorCode?: string;
  traceId?: string;
}

export interface HttpTransportObserver {
  onSend?(id: string): void;
  onHeaders?(status: number): void;
}

export interface HttpTransportOptions {
  clock?: () => number;
  report?: (event: HttpTransportEvent) => void;
  observer?: HttpTransportObserver;
  traceId?: string;
  /** A preceding correlation log already recorded this send with the same id. */
  sendAlreadyLogged?: boolean;
  id?: string;
}

const METHODS = new Set(["GET", "POST", "PATCH", "PUT", "DELETE", "HEAD", "OPTIONS"]);
const HOST = /^[a-z0-9.-]+(?::[0-9]+)?$/i;
const REQUEST_ID = /^[a-z0-9._:-]{1,128}$/i;
const REQUEST_ID_HEADERS = ["x-request-id", "request-id", "x-github-request-id", "cf-ray"] as const;
const ERROR_CODES = new Set([
  "ECONNREFUSED",
  "ECONNRESET",
  "EPIPE",
  "ETIMEDOUT",
  "ERR_STREAM_DESTROYED",
  "ERR_STREAM_PREMATURE_CLOSE",
  "UND_ERR_ABORTED",
  "UND_ERR_BODY_TIMEOUT",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_HEADERS_TIMEOUT",
  "UND_ERR_SOCKET",
]);
const TIMEOUT_CODES = new Set([
  "ETIMEDOUT",
  "UND_ERR_BODY_TIMEOUT",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_HEADERS_TIMEOUT",
]);

function safeRequest(
  input: RequestInfo | URL,
  init: RequestInit | undefined,
): Pick<HttpTransportEvent, "host" | "method"> {
  let host: string | undefined;
  try {
    const value = input instanceof Request ? input.url : String(input);
    const candidate = new URL(value).host;
    if (candidate.length <= 64 && HOST.test(candidate)) host = candidate.toLowerCase();
  } catch {
    // An invalid URL stays the fetcher's error, without copying its text into telemetry.
  }
  const suppliedMethod = init?.method ?? (input instanceof Request ? input.method : "GET");
  const method = typeof suppliedMethod === "string" ? suppliedMethod.toUpperCase() : undefined;
  return { ...(host ? { host } : {}), ...(method && METHODS.has(method) ? { method } : {}) };
}

function safeRequestId(headers: Headers): string | undefined {
  try {
    for (const name of REQUEST_ID_HEADERS) {
      const value = headers.get(name);
      if (value && REQUEST_ID.test(value)) return value;
    }
  } catch {
    // A malformed diagnostic header cannot change a completed HTTP response.
  }
  return undefined;
}

/** Only known transport codes cross the telemetry boundary, including a Fetch TypeError's cause. */
export function safeHttpErrorCode(error: unknown): string | undefined {
  let current = error;
  for (let depth = 0; depth < 4 && current !== null && typeof current === "object"; depth++) {
    try {
      const code = Object.getOwnPropertyDescriptor(current, "code");
      if (code && "value" in code && typeof code.value === "string" && ERROR_CODES.has(code.value)) return code.value;
      const cause = Object.getOwnPropertyDescriptor(current, "cause");
      current = cause && "value" in cause ? cause.value : undefined;
    } catch {
      return undefined;
    }
  }
  return undefined;
}

function failureCause(
  error: unknown,
  signal: AbortSignal | null | undefined,
  errorCode?: string,
): HttpTransportEvent["cause"] {
  if ((error instanceof Error && error.name === "TimeoutError") || (errorCode && TIMEOUT_CODES.has(errorCode)))
    return "timeout";
  if (signal?.aborted || (error instanceof Error && error.name === "AbortError")) return "abort";
  return "transport";
}

/** One reporting owner for an outbound Fetch API send, including injected fetchers and bindings. */
export async function observeHttpRequest<T extends Response>(
  input: RequestInfo | URL,
  init: RequestInit | undefined,
  send: () => Promise<T>,
  options: HttpTransportOptions = {},
): Promise<T> {
  const clock = options.clock ?? systemClock;
  const report = options.report ?? ((event: HttpTransportEvent) => console.log(JSON.stringify(event)));
  const startedAt = clock();
  const base = {
    event: "http.transport" as const,
    id: options.id ?? newSpanId(),
    ...safeRequest(input, init),
    ...(options.traceId ? { traceId: options.traceId } : {}),
  };
  const emit = (event: HttpTransportEvent): void => {
    try {
      report(event);
    } catch {
      // Telemetry cannot change an HTTP request or its result.
    }
  };
  if (!options.sendAlreadyLogged) emit({ ...base, stage: "send", at: startedAt });
  try {
    options.observer?.onSend?.(base.id);
  } catch {
    // A diagnostic observer cannot change the HTTP request.
  }
  try {
    const response = await send();
    const at = clock();
    const requestId = safeRequestId(response.headers);
    emit({
      ...base,
      stage: "headers",
      at,
      elapsedMs: Math.max(0, at - startedAt),
      status: response.status,
      ...(requestId ? { requestId } : {}),
    });
    try {
      options.observer?.onHeaders?.(response.status);
    } catch {
      // A diagnostic observer cannot change the HTTP response.
    }
    return response;
  } catch (error) {
    const at = clock();
    const errorCode = safeHttpErrorCode(error);
    emit({
      ...base,
      stage: "error",
      at,
      elapsedMs: Math.max(0, at - startedAt),
      cause: failureCause(error, init?.signal ?? (input instanceof Request ? input.signal : undefined), errorCode),
      ...(errorCode ? { errorCode } : {}),
    });
    throw error;
  }
}

const RAW_FETCH = Symbol.for("switchboard.http.rawFetch");
type WrappedFetch = typeof fetch & { [RAW_FETCH]?: typeof fetch };

/** An explicit span or observer uses the underlying fetch so one send gets one transport receipt. */
export function nativeHttpFetch(candidate: typeof fetch = globalThis.fetch): typeof fetch {
  return (candidate as WrappedFetch)[RAW_FETCH] ?? candidate;
}

/** Install once per live bot or Worker isolate. SDKs using global fetch inherit the same receipts. */
export function installHttpTransport(options: HttpTransportOptions = {}): () => void {
  if (nativeHttpFetch(globalThis.fetch) !== globalThis.fetch) return () => {};
  const raw = globalThis.fetch;
  const wrapped = ((input: RequestInfo | URL, init?: RequestInit) =>
    observeHttpRequest(input, init, () => raw(input, init), options)) as WrappedFetch;
  Object.defineProperty(wrapped, RAW_FETCH, { value: raw });
  globalThis.fetch = wrapped;
  return () => {
    if (globalThis.fetch === wrapped) globalThis.fetch = raw;
  };
}

/** Service and container bindings have their own fetch method and bypass global fetch. */
export function bindingFetch(
  binding: { fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> },
  input: RequestInfo | URL,
  init?: RequestInit,
): Promise<Response> {
  return observeHttpRequest(input, init, () => binding.fetch(input, init));
}
