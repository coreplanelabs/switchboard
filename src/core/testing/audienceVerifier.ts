import type { AudienceCheck } from "../audienceDecision.js";

/** Existing fixtures drive availability with booleans; the channel seam is typed. */
export function booleanAudienceVerifier<Args extends unknown[]>(verify: (...args: Args) => Promise<boolean>) {
  return async (...args: Args): Promise<AudienceCheck> =>
    (await verify(...args)) ? { ok: true } : { ok: false, code: "direct-audience-unavailable" };
}
