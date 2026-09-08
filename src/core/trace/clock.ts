import type { Clock } from "./types.js";

/** The ONLY production file that reads the wall clock. Everything else takes a
 *  `Clock` (docs/reference/specs/tracing.md: the clock ratchet forces the allowlist of
 *  direct reads to zero). */
export const systemClock: Clock = () => Date.now();
