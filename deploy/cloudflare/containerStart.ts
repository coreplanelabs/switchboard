// The container's start, reframed as an answer instead of a 500.
//
// `SwitchboardServer.fetch` starts the container before forwarding
// (`startBot` → `startAndWaitForPorts`), because a stopped container is
// restarted by the next request through it. A deploy or a container-application
// roll replaces the single instance, and for a moment the platform has no
// instance to provide; `startAndWaitForPorts` throws for exactly that state.
// Uncaught, the throw escaped the shim as HTTP 500 — a status a caller reads as
// a broken endpoint, and which GitHub's webhook intake cannot tell from a
// permanent failure. The same condition is retryable: the container comes back
// when the roll settles, so the answer is the SDK's own retryable 503.
//
// The SDK keeps the message private (`NO_CONTAINER_INSTANCE_ERROR` in
// `@cloudflare/containers`, matched the same way there: a lowercased substring
// test), so the match is restated here, in one place, and tested without
// workerd.

/** The runtime's no-instance message, lowercased for the substring match. */
const NO_CONTAINER_INSTANCE_ERROR = "there is no container instance that can be provided to this durable object";

/** True when a container start failed because the platform had no instance to
 *  provide — a roll in progress, not a fault of the request. */
export function isNoContainerInstanceError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return message.toLowerCase().includes(NO_CONTAINER_INSTANCE_ERROR);
}

/** The retryable answer for a start that found no instance: 503 with
 *  `Retry-After`, so a webhook sender redelivers rather than recording a
 *  failure. */
export function noContainerInstanceResponse(): Response {
  return new Response("There is no Container instance available at this time.", {
    status: 503,
    headers: { "retry-after": "1" },
  });
}
