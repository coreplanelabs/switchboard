// SwitchboardServer.fetch starts the container before forwarding, so the SDK's
// own fetch error handling cannot answer failures in that startup path. The
// platform's no-instance and runtime-rollout errors mean temporary availability,
// not a fault of the request. Port loss needs state, not another string match:
// the SDK sends its crash diagnostic only to onError, swallows that hook's
// throw, then rethrows the original TCP error (which is ambiguous on its own).

// The SDK keeps its message constants private. Match these platform conditions
// as lowercased substrings, like isErrorOfType in the SDK's container.js.
const NO_CONTAINER_INSTANCE_ERROR = "there is no container instance that can be provided to this durable object";
const RUNTIME_SIGNALLED_ERROR = "runtime signalled the container to exit";
const ROLL_START_ERRORS = [NO_CONTAINER_INSTANCE_ERROR, RUNTIME_SIGNALLED_ERROR];

/** Raised only for a failed port wait whose container is verified stopped,
 *  after the SDK's instance acquisition succeeded. Preserve the TCP cause for
 *  diagnostics without exposing it in the response. */
export class ContainerPortLostError extends Error {
  constructor(cause: unknown) {
    super("Container stopped while waiting for a port", { cause });
    this.name = "ContainerPortLostError";
  }
}

/** Temporary startup unavailability, including verified loss during port wait.
 *  A stopped container alone cannot prove a rollout rather than an app crash. */
export function isContainerRollStartError(error: unknown): boolean {
  if (error instanceof ContainerPortLostError) return true;
  const message = (error instanceof Error ? error.message : String(error)).toLowerCase();
  return ROLL_START_ERRORS.some((needle) => message.includes(needle));
}

/** The retryable answer for a start that lost its container: 503 with a retry
 *  hint. GitHub records a failed delivery; it does not automatically redeliver,
 *  so this status is availability information, not a guarantee. */
export function containerRollResponse(): Response {
  return new Response("There is no Container instance available at this time.", {
    status: 503,
    headers: { "retry-after": "1" },
  });
}
