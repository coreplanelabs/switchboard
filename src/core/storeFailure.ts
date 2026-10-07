/** The `/runs/*` route answered 404: the Worker does not have this route yet. Never retried. */
export class RouteMissingError extends Error {
  readonly name = "RouteMissingError";
}
/** Network failure, timeout, 408, 429, or 5xx: retry with backoff. */
export class TransientStoreError extends Error {
  readonly name = "TransientStoreError";
}
/** Any other non-2xx, or a malformed response body: log and count, never retry. */
export class PermanentStoreError extends Error {
  readonly name: string = "PermanentStoreError";
}

export interface StoreRequestWitness {
  readonly version: 1;
  readonly operation: string;
  readonly payload: string;
  readonly digest: string;
}

/** Observed transport facts only; no response body or private exception text. */
export type UncertainStoreDiagnosis =
  | { readonly kind: "transport" }
  | {
      readonly kind: "http" | "response-body" | "response-json" | "response-shape" | "acknowledgement";
      readonly status: number;
    };

function closedDiagnosis(value: UncertainStoreDiagnosis | undefined): UncertainStoreDiagnosis | undefined {
  if (!value || typeof value !== "object") return undefined;
  if (value.kind === "transport" && Object.keys(value).every((key) => key === "kind"))
    return Object.freeze({ kind: "transport" });
  if (
    ["http", "response-body", "response-json", "response-shape", "acknowledgement"].includes(value.kind) &&
    "status" in value &&
    Number.isInteger(value.status) &&
    value.status >= 100 &&
    value.status <= 599 &&
    Object.keys(value).every((key) => key === "kind" || key === "status")
  )
    return Object.freeze({ kind: value.kind, status: value.status }) as UncertainStoreDiagnosis;
  return undefined;
}

/** No automatic retry: the original write may already be committed. The
 * immutable request remains available for canonical reconciliation, not logs. */
export class UncertainStoreError extends PermanentStoreError {
  override readonly name = "UncertainStoreError";
  readonly outcome = "unknown";
  declare readonly request: StoreRequestWitness;
  declare readonly diagnosis: UncertainStoreDiagnosis | undefined;
  constructor(
    message: string,
    request: StoreRequestWitness,
    options?: ErrorOptions & { diagnosis?: UncertainStoreDiagnosis },
  ) {
    super(message, options);
    Object.defineProperty(this, "request", { value: Object.freeze({ ...request }), enumerable: false });
    Object.defineProperty(this, "diagnosis", { value: closedDiagnosis(options?.diagnosis), enumerable: false });
  }
}

/** A bounded log label; exception prose and request bytes never reach it. */
export function uncertainStoreSummary(error: UncertainStoreError): string {
  return storeWriteDiagnosisSummary(error.request.operation, error.diagnosis);
}

/** Shared by the retained boundary and its existing readable failure note. */
export function storeWriteDiagnosisSummary(operationInput: string, diagnosisInput?: UncertainStoreDiagnosis): string {
  const operation = ["/runs/state", "/runs/step", "/runs/live-state", "/runs/session/checkpoint"].includes(
    operationInput,
  )
    ? operationInput
    : "other";
  const diagnosis = closedDiagnosis(diagnosisInput);
  return `operation=${operation} failure=${diagnosis?.kind ?? "unclassified"}${diagnosis && "status" in diagnosis ? ` status=${diagnosis.status}` : ""}`;
}
