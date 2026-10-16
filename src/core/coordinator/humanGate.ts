import type { HumanGatePending } from "../ship/coordinator.js";

/** Called by the original report owner after its requester and full row CAS are
 * verified. A report cannot select its assignee. Replays preserve the original
 * assignment; replaying a legacy question cannot invent one. */
export function assignHumanGate(
  gate: HumanGatePending,
  trustedRequester: string,
  current?: HumanGatePending,
): HumanGatePending {
  const { assignedTo: _supplied, ...question } = gate;
  const previousAssignment = current?.assignedTo;
  const sameQuestion =
    current !== undefined &&
    current.pr.number === gate.pr.number &&
    current.round === gate.round &&
    current.askedAt === gate.askedAt &&
    current.reviewRunId === gate.reviewRunId &&
    current.headSha === gate.headSha &&
    current.verdict === gate.verdict;
  if (sameQuestion) return { ...question, ...(previousAssignment ? { assignedTo: previousAssignment } : {}) };
  if (!/^[a-z][a-z0-9-]*:[^\s]+$/i.test(trustedRequester))
    throw new Error("The original question requester is invalid.");
  return { ...question, assignedTo: trustedRequester };
}
