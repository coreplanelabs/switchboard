import { parseTraceparent } from "./traceparent.js";

export const WORKER_REQUEST_ID_HEADER = "x-switchboard-request-id";
const STORAGE_REQUEST_ID_HEADER = "x-switchboard-storage-request-id";
const uuid = (value: string | null): string | undefined =>
  value && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(value) ? value : undefined;

export function workerRequestId(headers: Headers): string | undefined {
  return uuid(headers.get(STORAGE_REQUEST_ID_HEADER)) ?? uuid(headers.get(WORKER_REQUEST_ID_HEADER));
}

/** The caller owns the route vocabulary. No URL, body or credential reaches this record. */
export function observeWorkerSend(
  headers: Headers,
  route: string,
  host: string,
  traceId?: string,
  runId?: string,
): boolean {
  try {
    const requestId = workerRequestId(headers) ?? crypto.randomUUID();
    headers.set(WORKER_REQUEST_ID_HEADER, requestId);
    console.log(
      JSON.stringify({
        event: "cloudflare.request.sent",
        requestId,
        route,
        host,
        ...(traceId ? { traceId } : {}),
        ...(runId && uuid(runId) ? { runId } : {}),
      }),
    );
    return true;
  } catch {
    unavailable("client", "operator-log");
    return false;
  }
}

/** Structural platform seam: core does not import the Workers SDK. */
interface NativeTracing {
  getActiveSpan(): { setAttributes(attributes: Record<string, string>): unknown } | undefined;
}

/** Log before the first awaited operation so a missing completion still has a join key.
 * Cloudflare attaches invocation metadata to this line; its native RPC spans name
 * the actual Durable Object and method. None of these identifiers grants authority. */
export function observeWorkerRequest(
  request: Request,
  options: {
    service: "bot" | "memory" | "resident" | "sandbox";
    route: string;
    build: { commit: string; builtAt?: string };
    traceId?: string;
    publicEdge?: true;
  },
  tracing?: NativeTracing,
): void {
  const { service, route, build } = options;
  const requestId = options.publicEdge ? undefined : workerRequestId(request.headers);
  const traceId =
    options.traceId ?? (options.publicEdge ? undefined : parseTraceparent(request.headers.get("traceparent"))?.traceId);
  const ray = request.headers.get("cf-ray");
  const rayId = ray && /^[a-f0-9]{16}(?:-[A-Z]{3})?$/.test(ray) ? ray : undefined;
  try {
    tracing?.getActiveSpan()?.setAttributes({
      "switchboard.service": service,
      "switchboard.route": route,
      "switchboard.build_commit": build.commit,
      ...(requestId ? { "switchboard.request_id": requestId } : {}),
      ...(traceId ? { "switchboard.trace_id": traceId } : {}),
    });
  } catch {
    unavailable(service, "native-span");
  }
  try {
    console.log(
      JSON.stringify({
        event: "cloudflare.request.received",
        service,
        route,
        ...(requestId ? { requestId } : {}),
        ...(traceId ? { traceId } : {}),
        ...(rayId ? { rayId } : {}),
        build,
      }),
    );
  } catch {
    unavailable(service, "operator-log");
  }
}

/** A streamed HTTP 200 can carry an error after the invocation has answered. */
export function observeWorkerCompletion(
  service: "resident" | "sandbox",
  route: string,
  requestId: string | undefined,
  payload: object,
  delivery: "sent" | "client-gone",
): void {
  if (!uuid(requestId ?? null) || !/^\/[a-z-]{1,40}$/.test(route)) return;
  try {
    const fields = Object.getOwnPropertyDescriptors(payload);
    const error = Object.hasOwn(fields, "error");
    const value = (key: string): unknown => (fields[key] && "value" in fields[key] ? fields[key].value : undefined);
    const failure = error || (service === "sandbox" && route === "/seed" && value("seeded") === false);
    if (!failure && delivery === "sent") return;
    const status = value("status");
    const cause = value("cause");
    const transient = value("transient");
    console.log(
      JSON.stringify({
        event: "cloudflare.request.completed",
        service,
        route,
        requestId,
        outcome: failure ? "failure" : "success",
        delivery,
        ...(Number.isInteger(status) && Number(status) >= 100 && Number(status) <= 599 ? { answerStatus: status } : {}),
        ...(cause === "request" || cause === "policy" || cause === "system" ? { cause } : {}),
        ...(typeof transient === "boolean" ? { transient } : {}),
      }),
    );
  } catch {
    unavailable(service, "operator-log");
  }
}

function unavailable(service: string, stage: "operator-log" | "native-span"): void {
  try {
    console.warn(JSON.stringify({ event: "cloudflare.correlation.unavailable", service, stage }));
  } catch {
    // A failed fallback sink cannot change the request outcome or recurse.
  }
}
