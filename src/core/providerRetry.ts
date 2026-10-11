import { PROVIDER_RETRY_BACKOFFS_MS, PROVIDER_RETRY_WAIT_MS, secondsToMs } from "./budgets.js";
import { providerFailureParks, type ProviderFailure } from "./provider.js";

/** The harness owns retries; the proxy makes exactly one upstream request.
 * Provider advice is a minimum delay, never permission to exceed the budget. */
export function providerRetryDelay(
  failure: ProviderFailure | undefined,
  retries: number,
  now: number,
  random: () => number = Math.random,
): number | undefined {
  const base = PROVIDER_RETRY_BACKOFFS_MS[retries];
  if (base === undefined || (failure && !providerFailureParks(failure.cause))) return undefined;
  if (!failure) return base; // Local cancellation/EOF establishes no provider health.
  const header = failure.diagnostic?.headers?.["retry-after"];
  let advised = 0;
  if (header !== undefined) {
    const seconds = /^\d+(?:\.\d+)?$/.test(header.trim()) ? Number(header) : undefined;
    const delay = seconds === undefined ? Date.parse(header) - now : secondsToMs(seconds);
    if (Number.isFinite(delay)) advised = Math.max(0, delay);
  }
  const delay = Math.max(advised, Math.ceil(base * (1 + random() * 0.2)));
  return delay <= PROVIDER_RETRY_WAIT_MS ? delay : undefined;
}
