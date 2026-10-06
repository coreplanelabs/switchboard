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

/** No automatic retry: the original write may already be committed. The
 * immutable request remains available for canonical reconciliation, not logs. */
export class UncertainStoreError extends PermanentStoreError {
  override readonly name = "UncertainStoreError";
  readonly outcome = "unknown";
  declare readonly request: StoreRequestWitness;
  constructor(message: string, request: StoreRequestWitness, options?: ErrorOptions) {
    super(message, options);
    Object.defineProperty(this, "request", { value: Object.freeze({ ...request }), enumerable: false });
  }
}
