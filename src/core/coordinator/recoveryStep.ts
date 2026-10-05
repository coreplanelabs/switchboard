/** Recovery executions and children are scoped to the immutable admission,
 * rather than the source run that more than one request can recover. */
export const RECOVERY_ACTION_ID_PATTERN = /^r_[a-f0-9]{64}$/;

export function recoveryWorkflowId(actionId: string): string {
  if (!RECOVERY_ACTION_ID_PATTERN.test(actionId)) throw new Error("invalid recovery action id");
  return `recovery-${actionId}`;
}

export function recoveryStepPrefix(unit: string, actionId: string): string {
  if (!/^[A-Za-z0-9_-]{1,32}$/.test(unit) || !RECOVERY_ACTION_ID_PATTERN.test(actionId))
    throw new Error("invalid recovery step identity");
  return `${unit}/recovery/${actionId}`;
}

export interface RecoveryStep {
  unit: string;
  actionId: string;
  round: number;
  kind: "coding" | "review" | "findings" | "rebase";
  attempt?: number;
}

export function parseRecoveryStep(value: string): RecoveryStep | undefined {
  const match =
    /^([A-Za-z0-9_-]{1,32})\/recovery\/(r_[a-f0-9]{64})\/(0|[1-9][0-9]*)\/(coding|review|findings|rebase)(?:\/a([1-9][0-9]*))?$/.exec(
      value,
    );
  if (!match) return undefined;
  const round = Number(match[3]);
  const attempt = match[5] === undefined ? undefined : Number(match[5]);
  const kind = match[4] as RecoveryStep["kind"];
  if (
    !Number.isSafeInteger(round) ||
    (kind === "coding" ? round !== 0 : round < 1) ||
    (attempt !== undefined && !Number.isSafeInteger(attempt))
  )
    return undefined;
  return { unit: match[1]!, actionId: match[2]!, round, kind, ...(attempt === undefined ? {} : { attempt }) };
}

export function recoveryStepName(step: RecoveryStep): string {
  const name = `${recoveryStepPrefix(step.unit, step.actionId)}/${step.round}/${step.kind}${step.attempt === undefined ? "" : `/a${step.attempt}`}`;
  if (!parseRecoveryStep(name)) throw new Error("invalid recovery child step");
  return name;
}

/** The child preset is fixed by its canonical action name, including renewed and recovery executions. */
export function childPresetOfStep(value: string): "coding" | "review" | undefined {
  const recovered = parseRecoveryStep(value);
  if (recovered) return recovered.kind === "review" ? "review" : "coding";
  const match =
    /^([A-Za-z0-9_-]{1,32})(?:\/s([1-9][0-9]*))?(?:\/r([1-9][0-9]*))?\/(0|[1-9][0-9]*)\/(coding|review|findings|rebase)(?:\/a([1-9][0-9]*))?$/.exec(
      value,
    );
  if (
    !match ||
    [match[2], match[3], match[4], match[6]].some(
      (number) => number !== undefined && !Number.isSafeInteger(Number(number)),
    ) ||
    (match[2] !== undefined && Number(match[2]) < 2) ||
    (match[5] === "coding" ? Number(match[4]) !== 0 : Number(match[4]) < 1)
  )
    return undefined;
  return match[5] === "review" ? "review" : "coding";
}
