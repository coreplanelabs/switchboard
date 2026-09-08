import type { SpanContext } from "./types.js";

/** Production `SpanContext`: the identity (Null Object). `span(fn)` enters it
 *  around `fn`, and it does nothing, so the primitive carries no async-context
 *  machinery and no Node dependency. The no-gaps test supplies an
 *  `AsyncLocalStorage`-backed one instead (src/core/testing/alsContext.ts). */
export const identityContext: SpanContext = {
  run: (_span, fn) => fn(),
};
