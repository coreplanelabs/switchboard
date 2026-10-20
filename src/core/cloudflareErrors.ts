import { unwrapUntrusted } from "./untrusted.js";

/** Read only at a known Cloudflare boundary; a wrapped subrequest is not evidence. */
export const CLOUDFLARE_INTERNAL_ERROR =
  /^internal error(?:(?: in Durable Object storage caused object to be reset)?; reference = [a-z0-9]{24})?\.?$/i;
const CLOUDFLARE_FAILURE =
  /^(?:internal error(?: in Durable Object storage caused object to be reset)?; reference = [a-z0-9]{24}\.?|Durable Object(?:'s isolate exceeded its memory limit and was reset\.| storage operation exceeded timeout which caused object to be reset\.| is overloaded(?:\..*)?| reset because its code was updated\..*)|internal error while starting up durable object storage caused object to be reset\.?)$/i;
const BOUNDARY = "Failed inside Cloudflare's infrastructure boundary: ";

/** Preserve the platform's support reference, without assigning generic 5xx failures to it. */
export function cloudflareErrorMessage(message: string): string {
  const text = unwrapUntrusted(message, { restoreMarkers: true });
  return CLOUDFLARE_FAILURE.test(text) ? BOUNDARY + text : message;
}

/** Only for replay-safe calls to Cloudflare. Overload is never a reason to add work. */
export function isRetryableCloudflareError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const e = error as { name?: unknown; message?: unknown; overloaded?: unknown; retryable?: unknown };
  if (
    e.name === "TypeError" ||
    e.name === "SyntaxError" ||
    e.overloaded === true ||
    e.retryable === false ||
    (typeof e.message === "string" && /^Durable Object is overloaded/i.test(e.message))
  )
    return false;
  return e.retryable === true || (typeof e.message === "string" && CLOUDFLARE_INTERNAL_ERROR.test(e.message));
}
