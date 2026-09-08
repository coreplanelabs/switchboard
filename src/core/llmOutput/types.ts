// Typed LLM output contract (docs/reference/specs/llm-output.md): every LLM call's output
// is an assumption the system made. A per-datatype module makes the assumption
// explicit — what shape was requested, how to classify what came back, whether
// a violation is worth asking the model again — and everything downstream of
// the call receives a strongly-typed value plus ONE canonical text form. The
// control loop below is deterministic and type-blind: all knowledge of what is
// valid lives in the type module (invariant 2 — new datatype = new module
// behind this seam, never a special case in a caller).

/** How a completion violated the expected output type. `syntax` — the text is
 *  not the format at all (unparseable JSON); `schema` — the format parsed but
 *  the shape is wrong (missing/mistyped fields). `observed` is a one-line
 *  statement of what was seen, phrased to be sent back to the model on a
 *  re-ask. */
export interface OutputFailure {
  kind: "syntax" | "schema";
  observed: string;
}

/** One deterministic parse of one raw completion. `canonical` is the one text
 *  form every consumer stores/projects; `changed` says whether normalization
 *  altered the raw text (false = canonical is byte-identical to the input). */
export type ParseOutcome<T> =
  { ok: true; value: T; canonical: string; changed: boolean } | { ok: false; failure: OutputFailure };

/** The per-datatype half of the contract. Modules are pure: `parse` never
 *  throws and touches no I/O — classification, normalization, and schema
 *  validation only. */
export interface OutputType<T> {
  readonly name: string;
  /** Optional system-prompt steering toward the expected shape — the request
   *  side of the contract. Consumers opt in; nothing appends it implicitly. */
  readonly requestHint?: string;
  parse(raw: string): ParseOutcome<T>;
  /** Whether this failure is worth one more model turn. Prose types answer
   *  false (normalization already failed open); crisp formats answer true. */
  retryable(failure: OutputFailure): boolean;
  /** Upper bound on re-asks when `retryable` says yes. */
  readonly maxRetries: number;
}

/** What `acceptOutput` hands back: the typed value with the canonical and the
 *  LAST raw text on success, or the final failure — returned, never thrown,
 *  so the caller decides fail-open vs fail-closed. `attempts` counts parses. */
export type AcceptedOutput<T> =
  | { ok: true; value: T; canonical: string; raw: string; changed: boolean; attempts: number }
  | { ok: false; failure: OutputFailure; raw: string; attempts: number };

/**
 * The deterministic control loop around one LLM call's output: parse; on a
 * failure the type declares retryable, ask the model again (via the caller's
 * `reask`, which receives the failure so the model is told exactly what was
 * observed) up to `maxRetries` times; otherwise return the failure. The loop
 * sequences — it decides nothing about validity.
 */
export async function acceptOutput<T>(
  type: OutputType<T>,
  raw: string,
  reask?: (failure: OutputFailure) => Promise<string>,
): Promise<AcceptedOutput<T>> {
  let current = raw;
  let attempts = 0;
  for (;;) {
    attempts++;
    const outcome = type.parse(current);
    if (outcome.ok) return { ...outcome, raw: current, attempts };
    if (!reask || !type.retryable(outcome.failure) || attempts > type.maxRetries) {
      return { ok: false, failure: outcome.failure, raw: current, attempts };
    }
    current = await reask(outcome.failure);
  }
}
