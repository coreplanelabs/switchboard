import type { z } from "zod";
import type { OutputFailure, OutputType, ParseOutcome } from "./types.js";

// The JSON output type (docs/reference/specs/llm-output.md item 4): the crisp-format
// counterpart to markdown. Violations here are classifiable and a re-ask can
// fix them, so it retries by default — and it is the ready seam for
// provider-native JSON output modes (the type module stays; only the request
// side changes).

/** The JSON value in a reply from a model that was told to send raw JSON and
 *  did not quite: the text from the first `{` or `[` to its matching closer,
 *  whatever surrounds it — a ```json fence, closed or not, a lead-in line, a
 *  trailing remark — ignored. Accepting those is normalization, not failure.
 *  Braces inside strings never close the value. A value with no closer is one
 *  the output cap cut: it runs to the end of the text, so `JSON.parse` names
 *  the cut rather than the fence. No brace at all → the trimmed text, so the
 *  parser's own message names what was seen. */
export function extractJson(text: string): string {
  const start = text.search(/[[{]/);
  if (start === -1) return text.trim();
  let depth = 0;
  let inString = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (ch === "\\") i++;
      else if (ch === '"') inString = false;
    } else if (ch === '"') {
      inString = true;
    } else if (ch === "{" || ch === "[") {
      depth++;
    } else if (ch === "}" || ch === "]") {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return text.slice(start);
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

/** A JSON OutputType for one zod schema: `extractJson` → `JSON.parse` (throw →
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
        value = JSON.parse(extractJson(raw));
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
      // (whitespace, key order) and drops a fence by design, so a byte diff
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
