import {
  capThreadEvent,
  mainTaskClaimMatches,
  isHumanGatePending,
  type CoordinatorInstance,
  type CoordinatorUnit,
  type ThreadEvent,
} from "./contract.js";
import { sha256Hex, type HumanGatePending } from "../ship/coordinator.js";
export interface QuestionAnswerGuard {
  expectedQuestion: HumanGatePending;
}
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, entry]) => entry !== undefined)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, entry]) => [key, canonical(entry)]),
    );
  return value;
}
function same(a: unknown, b: unknown) {
  return JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));
}
/** One full-question key for canonical answer admission and read projections. */
export function questionDigestOf(question: HumanGatePending): string {
  return sha256Hex(JSON.stringify(canonical(question)));
}
function eventBody(event: ThreadEvent) {
  const { seq: _seq, consumedBy: _consumed, questionDigest: _claim, ...body } = event;
  return body;
}

/** Only a previously guarded answer can be acknowledged after its question
 * clears. Arrival time and current wake/steer state cannot change that event. */
export function isQuestionAnswerRetry(saved: ThreadEvent, input: Omit<ThreadEvent, "seq">): boolean {
  return (
    saved.questionDigest !== undefined &&
    same(eventBody(saved), eventBody(capThreadEvent({ ...input, at: saved.at, mode: saved.mode, seq: saved.seq })))
  );
}

/** Runs inside the original unit store transaction. A saved event is evidence
 * of admission; only an identical retry may read its sequence after the
 * question changes. Every new answer must match the complete current question. */
export function admitQuestionAnswer(
  instance: CoordinatorInstance | undefined,
  unit: CoordinatorUnit | undefined,
  event: Omit<ThreadEvent, "seq">,
  guard: QuestionAnswerGuard,
  events: readonly ThreadEvent[],
):
  | { kind: "new"; humanHold: boolean; questionDigest: string }
  | { kind: "replay"; event: ThreadEvent }
  | { kind: "refused"; reason: "stale" | "ended" } {
  const refused = { kind: "refused" as const, reason: "stale" as const };
  if (!instance || !unit || !event.id || !isHumanGatePending(guard?.expectedQuestion)) return refused;
  const expected = guard.expectedQuestion;
  const questionDigest = questionDigestOf(expected);
  if (
    unit.workBrief &&
    (!mainTaskClaimMatches(
      { mainThreadKey: unit.workBrief.mainThreadKey, actId: unit.workBrief.actId },
      instance,
      unit,
    ) ||
      expected.assignedTo !== unit.workBrief.requesterId)
  )
    return refused;
  if (event.sender !== (expected.assignedTo ?? instance.userId)) return refused;
  const prior = events.find((saved) => saved.id === event.id);
  if (prior)
    return prior.questionDigest === questionDigest &&
      same(
        eventBody(prior),
        eventBody(capThreadEvent({ ...event, questionDigest: prior.questionDigest, seq: prior.seq })),
      )
      ? { kind: "replay", event: prior }
      : refused;
  // Consumption and question updates do not erase the original accepted answer.
  // This slot belongs to the canonical unit, shared by every intake source.
  if (events.some((saved) => saved.questionDigest === questionDigest)) return refused;
  const humanHold = unit.recoveryHold?.cause === "human";
  const current = unit.idle?.humanGate ?? (unit.recoveryHold?.cause === "human" ? unit.recoveryHold.gate : undefined);
  if (!current || !same(current, expected)) return refused;
  if (
    instance.stop ||
    unit.recovery ||
    (unit.ending && !(humanHold && unit.ending.kind === "held")) ||
    (unit.recoveryHold && !humanHold)
  )
    return { kind: "refused", reason: "ended" };
  return { kind: "new", humanHold, questionDigest };
}
