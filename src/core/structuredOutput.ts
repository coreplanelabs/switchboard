import type { Provider } from "../providers/types.js";
import {
  fallbackMessage,
  validateStructuredMessage,
  type StructuredMessage,
} from "./structuredMessage.js";

// Schema-validated, self-healing structured output. The model is asked to emit
// the channel-agnostic StructuredMessage shape; its output is zod-validated
// BEFORE any channel formatter renders it. On a validation (or parse) failure we
// feed the specific error back and re-ask, a FIXED small number of times — this
// is a formatting correction, not a contended resource, so fixed retries are
// right, never exponential backoff. After the retries are exhausted we fall back
// gracefully to a plain-text render rather than failing the run.

/** Fixed number of correction re-asks after the initial attempt (NOT
 *  exponential backoff). Total model attempts = MAX_STRUCTURE_RETRIES + 1. */
export const MAX_STRUCTURE_RETRIES = 2;

/**
 * Produces raw structured output from the model. `feedback` is the validation
 * error from the previous attempt — undefined on the first attempt, present on
 * every re-ask so the model can correct itself. The returned value may be a JSON
 * string (parsed here) or an already-parsed object.
 */
export type StructuredProducer = (feedback: string | undefined) => Promise<unknown>;

export interface ProduceOptions {
  /** Fixed re-ask budget after the first attempt. Defaults to MAX_STRUCTURE_RETRIES. */
  maxRetries?: number;
  /** Text used for the graceful plain fallback if every attempt fails. */
  fallbackText?: string;
  /** Called once with a human-readable warning when we fall back. */
  onWarn?: (message: string) => void;
}

export interface StructureResult {
  /** The validated message, or the plain fallback when `fellBack` is true. */
  message: StructuredMessage;
  /** True when no attempt validated and we fell back to a plain render. */
  fellBack: boolean;
  /** Number of model attempts made (1 = validated on the first try). */
  attempts: number;
}

/**
 * Drive the produce → validate → (feed error back → re-ask) loop. Pure w.r.t.
 * the model: the caller supplies `produce`, so this is fully unit-testable with
 * a fake producer that fails N times then succeeds (or always fails → fallback).
 */
export async function produceStructured(
  produce: StructuredProducer,
  opts: ProduceOptions = {},
): Promise<StructureResult> {
  const maxRetries = opts.maxRetries ?? MAX_STRUCTURE_RETRIES;
  let feedback: string | undefined;
  let lastError = "no attempts made";

  for (let attempt = 1; attempt <= maxRetries + 1; attempt++) {
    let raw: unknown;
    try {
      raw = await produce(feedback);
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
      feedback = reAskFeedback(`the previous attempt threw: ${lastError}`);
      continue;
    }

    const parsed = parseStructured(raw);
    if (parsed.ok) return { message: parsed.message, fellBack: false, attempts: attempt };

    lastError = parsed.error;
    feedback = reAskFeedback(parsed.error);
  }

  opts.onWarn?.(
    `structured output failed validation after ${maxRetries + 1} attempt(s) (${lastError}); ` +
      `falling back to plain text`,
  );
  return { message: fallbackMessage(opts.fallbackText ?? ""), fellBack: true, attempts: maxRetries + 1 };
}

/** Accept either a JSON string (parse it) or an already-parsed value, then
 *  zod-validate. A JSON parse error is reported like a validation error so the
 *  same feedback path corrects it. */
export function parseStructured(
  raw: unknown,
): { ok: true; message: StructuredMessage } | { ok: false; error: string } {
  let value = raw;
  if (typeof raw === "string") {
    try {
      value = JSON.parse(stripJsonFence(raw));
    } catch (err) {
      return { ok: false, error: `not valid JSON: ${err instanceof Error ? err.message : String(err)}` };
    }
  }
  return validateStructuredMessage(value);
}

/** Tolerate a model that wraps JSON in a ```json … ``` fence despite being told
 *  not to — strip a single leading/trailing fence before parsing. Shared with
 *  the memory reflection parser (same JSON-only-reply contract). */
export function stripJsonFence(text: string): string {
  const trimmed = text.trim();
  const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(trimmed);
  return fenced ? fenced[1] : trimmed;
}

/** The correction message fed back to the model on a re-ask. */
function reAskFeedback(error: string): string {
  return (
    `Your previous output was not valid: ${error}. ` +
    `Reply again with ONLY a JSON object matching the required schema — no prose, no code fence.`
  );
}

// ---- provider-backed producer ----------------------------------------------

/** Instruction that turns a free-form agent answer into the structured schema.
 *  Kept here (not in an agent prompt) so structuring is deterministic and
 *  channel-agnostic. */
export const STRUCTURING_SYSTEM = [
  "You convert an assistant's answer into a channel-agnostic structured message.",
  "Return ONLY a JSON object of the form:",
  '{"blocks":[ ... ]} where each block is one of:',
  '  {"type":"heading","text":"..."}',
  '  {"type":"paragraph","text":"..."}',
  '  {"type":"bullets","items":["...","..."]}',
  '  {"type":"code","code":"...","language":"optional"}',
  '  {"type":"link","url":"https://...","text":"optional label"}',
  '  {"type":"status","state":"ok|warn|error|info","text":"..."}',
  "Rules: at least one block; do not invent content; do not emit Slack/Discord/Markdown",
  "syntax inside text (the channel formatter adds it); output raw JSON with no code fence.",
].join("\n");

/**
 * A StructuredProducer backed by a real provider: it asks the model to convert
 * `answer` into the structured schema, appending the validation feedback on each
 * re-ask. Isolated here so the dispatcher wires provider/model/answer and the
 * retry loop stays provider-agnostic and testable.
 */
export function providerProducer(deps: {
  provider: Provider;
  model: string;
  answer: string;
  maxTokens: number;
}): StructuredProducer {
  return async (feedback) => {
    const user = feedback
      ? `${feedback}\n\nThe answer to convert:\n\n${deps.answer}`
      : `Convert this answer into the structured message JSON:\n\n${deps.answer}`;
    const result = await deps.provider.complete({
      model: deps.model,
      system: STRUCTURING_SYSTEM,
      messages: [{ role: "user", content: [{ type: "text", text: user }] }],
      maxTokens: deps.maxTokens,
    });
    return result.content
      .filter((p): p is Extract<typeof p, { type: "text" }> => p.type === "text")
      .map((p) => p.text)
      .join("")
      .trim();
  };
}
