import type { WindDownEnding } from "./harness/windDown.js";

/** Producer facts, captured before fallback wording. Output presence proves
 * neither correctness nor task completion. Audience refusal and replyOk remain
 * the separate audience and delivery receipts on the run record. */
export interface AnswerOutcome {
  version: 1;
  ending: "answered" | "time_budget" | "turn_budget" | "interrupted" | "soft_stop" | "hard_stop" | "unknown";
  output: "present" | "absent" | "unknown";
}

/** One decoder for the live ledger, recovered state and stored record. */
export function answerOutcomeOf(value: unknown): AnswerOutcome | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const row = value as Record<string, unknown>;
  if (
    row.version !== 1 ||
    typeof row.ending !== "string" ||
    !["answered", "time_budget", "turn_budget", "interrupted", "soft_stop", "hard_stop", "unknown"].includes(
      row.ending,
    ) ||
    typeof row.output !== "string" ||
    !["present", "absent", "unknown"].includes(row.output) ||
    Object.keys(row).some((key) => !["version", "ending", "output"].includes(key))
  )
    return undefined;
  return { version: 1, ending: row.ending as AnswerOutcome["ending"], output: row.output as AnswerOutcome["output"] };
}

/** Only the typed wind-down carries the unrendered write-up. A legacy replay
 * or a normal harness answer without that artifact leaves presence unknown. */
export function captureAnswerOutcome(
  ending: WindDownEnding | undefined,
  budgetEnded: boolean,
  stopped: "soft" | "hard" | undefined,
): AnswerOutcome {
  return {
    version: 1,
    ending:
      stopped === "hard"
        ? "hard_stop"
        : stopped === "soft" || ending?.kind === "soft"
          ? "soft_stop"
          : budgetEnded || ending?.kind === "time"
            ? "time_budget"
            : ending?.kind === "turns"
              ? "turn_budget"
              : ending?.kind === "unlabelled"
                ? "interrupted"
                : "answered",
    output: stopped === "hard" ? "absent" : ending ? (ending.text.trim() ? "present" : "absent") : "unknown",
  };
}

/** A separate output line, never an invented task in the model's checklist. */
export function answerOutcomeDetail(
  outcome: AnswerOutcome | undefined,
  checklist: string | undefined,
): string | undefined {
  if (outcome?.ending !== "time_budget") return checklist;
  const output =
    outcome.output === "absent"
      ? "Answer not written."
      : outcome.output === "unknown"
        ? "Answer completion unverified."
        : undefined;
  return output ? [output, checklist].filter(Boolean).join("\n\n") : checklist;
}

/** A same-requester continuation is bound to the durable reason, never wording. */
export function isBudgetAnswer(value: unknown): boolean {
  return answerOutcomeOf(value)?.ending === "time_budget";
}
