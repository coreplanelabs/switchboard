// The installed Containers SDK recognizes this private message with a
// lowercased substring match. Mirror that decision for startAndWaitForPorts,
// which runs before the SDK's fetch error handling can answer 503.
// See @cloudflare/containers/dist/lib/container.js: isNoInstanceError.

/** The runtime's no-instance message, lowercased for the substring match. */
const NO_CONTAINER_INSTANCE_ERROR = "there is no container instance that can be provided to this durable object";

/** True when the platform could not provide a container instance. */
export function isNoContainerInstanceError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return message.toLowerCase().includes(NO_CONTAINER_INSTANCE_ERROR);
}

/** Temporary unavailability, with a retry hint for callers that support it.
 *  GitHub records a failed delivery; it does not automatically redeliver. */
export function noContainerInstanceResponse(): Response {
  return new Response("There is no Container instance available at this time.", {
    status: 503,
    headers: { "retry-after": "1" },
  });
}
