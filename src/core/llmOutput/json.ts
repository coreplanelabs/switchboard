import type { z } from "zod";
import type { OutputFailure, OutputType, ParseOutcome } from "./types.js";

// The JSON output type (docs/reference/specs/llm-output.md item 4): the crisp-format
// counterpart to markdown. Violations here are classifiable and a re-ask can
// fix them, so it retries by default — and it is the ready seam for
// provider-native JSON output modes (the type module stays; only the request
// side changes).

/** Tolerate a model that wraps JSON in a ```json … ``` fence despite being told
 *  not to — strip a single leading/trailing fence before parsing. Accepting the
 *  fence is normalization, not failure. */
export function stripJsonFence(text: string): string {
  const trimmed = text.trim();
  const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(trimmed);
  return fenced ? fenced[1] : trimmed;
}

/** Default re-ask budget for JSON shapes — fixed small correction count,
 *  never backoff (a formatting correction is not a contended resource). */
export const JSON_MAX_RETRIES = 2;

/** Deep equality over JSON values (objects key-order-blind, arrays ordered) —
 *  what "the schema changed nothing" means for `changed`. */
function jsonValueEquals(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (Array.isArray(a) || Array.isArray(b)) {
    return Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((v, i) => jsonValueEquals(v, b[i]));
  }
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false;
  const ka = Object.keys(a);
  const kb = Object.keys(b);
  if (ka.length !== kb.length) return false;
  return ka.every((k) => jsonValueEquals((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]));
}

/** A JSON OutputType for one zod schema: fence-strip → `JSON.parse` (throw →
 *  `syntax` failure carrying the parser message) → `schema.safeParse` (fail →
 *  `schema` failure carrying the issue list). Canonical form is the
 *  re-serialized parsed value. */
export function jsonOutput<T>(schema: z.ZodType<T>, opts: { name?: string; requestHint?: string } = {}): OutputType<T> {
  return {
    name: opts.name ?? "json",
    requestHint:
      opts.requestHint ?? "Reply with ONLY a JSON object matching the required schema — no prose, no code fence.",
    parse(raw): ParseOutcome<T> {
      let value: unknown;
      try {
        value = JSON.parse(stripJsonFence(raw));
      } catch (err) {
        const observed = `not valid JSON: ${err instanceof Error ? err.message : String(err)}`;
        return { ok: false, failure: { kind: "syntax", observed } };
      }
      const parsed = schema.safeParse(value);
      if (!parsed.success) {
        const observed = parsed.error.issues
          .map((i) => `${i.path.length > 0 ? `${i.path.join(".")}: ` : ""}${i.message}`)
          .join("; ");
        return { ok: false, failure: { kind: "schema", observed } };
      }
      // `changed` is semantic, never cosmetic: canonicalization re-serializes
      // (whitespace, key order) and strips a fence by design, so a byte diff
      // against the raw text would always fire. It reports true only when the
      // schema transformed or stripped something the model actually sent.
      return {
        ok: true,
        value: parsed.data,
        canonical: JSON.stringify(parsed.data),
        changed: !jsonValueEquals(parsed.data, value),
      };
    },
    retryable: (_failure: OutputFailure) => true,
    maxRetries: JSON_MAX_RETRIES,
  };
}
