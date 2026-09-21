// One seam for a structured answer (record 0067): every place the product
// asks a model for one structured answer — the operator, intake and replay
// verifier — asks through this loop. The tool is forced by the caller's prompt as
// before (`providerStructuredModel`); the caller's PURE parser reads each answer
// and either accepts the value or names the violation in one line; a named
// violation is re-asked of the SAME model with the model's answer and the
// violation quoted back as a user turn ("your answer was not <noun>: <why>;
// answer with the <tool> tool only"), at most `STRUCTURED_RETRIES_MAX` times;
// every attempt — the violation it named, or the acceptance — is handed back
// for the caller's event, so a flaky model is legible on the record as
// re-asks, not as silent floors. After the retries the CALLER's declared
// floor holds: the value the caller builds from the last violation — a
// configured default, disagreement or silence — never a refusal shown to the
// person. Timeouts and transport failures stay what they
// are: the model's throw propagates to the caller's existing fail-closed
// catch WITHOUT a re-ask — there is no answer to quote back, and the caller's
// one timeout covers the whole loop, so a re-ask never spends time the caller
// did not budget. A throw AFTER an attempt was collected (a violation whose
// re-ask then timed out) rides a `StructuredAskError` carrying those
// attempts, so the caller's catch can put the re-asks already made on its
// event instead of losing them.
import { STRUCTURED_RETRIES_MAX } from "../budgets.js";
import type { RouteModel, RoutePrompt, RouteToolCall } from "./route.js";

/** The caller's parser under the seam's one contract: the answer in, either
 *  the accepted value or the violation named in one line — exactly the
 *  sentences the four parsers already produce. Pure and total. */
export type StructuredParse<T> = (
  answer: RouteToolCall | string,
) => { ok: true; value: T } | { ok: false; violation: string };

/** One attempt as the caller's event records it: accepted, or the violation
 *  the parser named. */
export interface StructuredAttempt {
  outcome: "accepted" | "violation";
  violation?: string;
}

/** One structured ask: the prompt (its tool forced as ever), the caller's
 *  parser, the caller's noun and tool name for the re-ask turn, and the
 *  caller's declared floor — the value that holds when the retries run out,
 *  built from the last violation. */
export interface StructuredAsk<T> {
  prompt: RoutePrompt;
  parse: StructuredParse<T>;
  /** The caller's noun for the answer in the re-ask turn: "a decision",
   *  "a route", "a verdict". */
  noun: string;
  /** The tool the re-ask turn names — the prompt's forced tool. */
  tool: string;
  /** The declared floor: data, not a branch the caller writes. */
  floor: (violation: string) => T;
}

/** What the seam answers: the accepted value, or the floor with `floored`
 *  true — and every attempt for the caller's event either way. */
export interface StructuredAnswer<T> {
  value: T;
  floored: boolean;
  attempts: StructuredAttempt[];
}

/** A model throw after at least one answer came back: the original error's
 *  message and name kept (a caller's timeout check reads the name), the cause
 *  attached, and the attempts already collected riding it for the caller's
 *  event — the violations the seam exists to make legible. A throw before any
 *  answer propagates as itself. */
export class StructuredAskError extends Error {
  readonly attempts: StructuredAttempt[];
  constructor(cause: unknown, attempts: StructuredAttempt[]) {
    super(cause instanceof Error ? cause.message : String(cause), { cause });
    this.name = cause instanceof Error ? cause.name : "StructuredAskError";
    this.attempts = attempts;
  }
}

/** The attempts a caller's catch salvages from a mid-loop throw: the
 *  `StructuredAskError`'s list when it carries one, else none. */
export function attemptsOfThrow(err: unknown): StructuredAttempt[] | undefined {
  return err instanceof StructuredAskError && err.attempts.length > 0 ? err.attempts : undefined;
}

/** The re-ask's user turn, the violation quoted verbatim with the caller's
 *  noun and tool name interpolated (record 0067's sentence). */
export function reAskTurn(noun: string, tool: string, violation: string): string {
  return `your answer was not ${noun}: ${violation}; answer with the ${tool} tool only`;
}

/** A model's answer as the re-ask quotes it back: the text, or the forced
 *  call's tool and input as JSON — the tool named so the re-ask shows which
 *  tool was called (the parsers themselves read the input alone). */
function answerText(answer: RouteToolCall | string): string {
  return typeof answer === "string" ? answer : JSON.stringify({ tool: answer.tool, input: answer.input });
}

/**
 * The loop: ask, parse, re-ask a named violation with the violation as a user
 * turn, at most `STRUCTURED_RETRIES_MAX` retries; after them the caller's
 * floor holds, built from the last violation. The caller's one signal covers
 * every attempt — the timeout is the caller's budget for the whole loop — and
 * a model that throws (a timeout, a transport failure) propagates to the
 * caller's existing fail-closed catch: only a parsed violation earns a re-ask,
 * and a throw after a collected attempt carries the attempts with it
 * (`StructuredAskError`).
 */
export async function askStructured<T>(
  ask: StructuredAsk<T>,
  model: RouteModel,
  opts: { maxTokens: number; signal: AbortSignal },
): Promise<StructuredAnswer<T>> {
  const attempts: StructuredAttempt[] = [];
  let prompt = ask.prompt;
  let last = "";
  for (let attempt = 0; attempt <= STRUCTURED_RETRIES_MAX; attempt++) {
    let answer: RouteToolCall | string;
    try {
      answer = await model(prompt, opts);
    } catch (err) {
      // No answer to quote back, so no re-ask — but the attempts already
      // collected (the violations whose re-ask this throw ended) ride the
      // error to the caller's event.
      throw attempts.length > 0 ? new StructuredAskError(err, attempts) : err;
    }
    const parsed = ask.parse(answer);
    if (parsed.ok) {
      attempts.push({ outcome: "accepted" });
      return { value: parsed.value, floored: false, attempts };
    }
    attempts.push({ outcome: "violation", violation: parsed.violation });
    last = parsed.violation;
    if (attempt < STRUCTURED_RETRIES_MAX)
      prompt = {
        ...prompt,
        retries: [
          ...(prompt.retries ?? []),
          { answer: answerText(answer), violation: reAskTurn(ask.noun, ask.tool, parsed.violation) },
        ],
      };
  }
  return { value: ask.floor(last), floored: true, attempts };
}
