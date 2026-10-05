// The outcome word a resident streamed root carries (docs/reference/specs/tracing.md
// item 22): `ok` when the request answered, `needs_<what>` when a refusal named what
// the caller must supply, the refusal's own word when it named one, `refused` for a
// refusal that named neither, and the failure word `error` for a throw no route named
// (a 500: `attachFailed`, `op-failed`, `read-failed`, `catchAllErr`). Only the failure
// word ends the span `error`; a refusal is a handled outcome the caller acts on, never
// a failure. The word rides the root span's attrs alone — never the answer's body, so
// nothing a caller reads changes.
import type { ThreadErr } from "./threadErr";

/** The word a refusal with neither a need nor a word of its own carries. */
export const REFUSED_OUTCOME = "refused";
/** The one failure word: a throw no route named (a 500), the only span error. */
export const FAILURE_OUTCOME = "error";

/** The one word a refusal's root carries: what it needed, else the refusal's own word,
 *  else `refused`; a throw no route named (a 500) is the failure word. */
export function refusalOutcome(err: ThreadErr): string {
  if (err.needs) return `needs_${err.needs}`;
  if (err.status === 500) return FAILURE_OUTCOME;
  return err.reason ?? REFUSED_OUTCOME;
}

/** The span status for one outcome word: only the failure word is an error. */
export function rootStatusForOutcome(outcome: string): "ok" | "error" {
  return outcome === FAILURE_OUTCOME ? "error" : "ok";
}
