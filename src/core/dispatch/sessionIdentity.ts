import type { CoordinatorTag } from "../coordinator/contract.js";
import type { RunSession } from "../runRecord.js";
import { contextSessionKey, sessionKey, workingSessionKey } from "../runLedger/sessionLog.js";

/** Transport threads and working lanes have different identities. The typed
 * unit came from admitted coordinator state; display/idempotency text grants
 * no association. A resumed owner retains the log it already claimed. */
export function runSessionIdentity(
  threadKey: string,
  agent: string,
  coordinator?: CoordinatorTag,
  existing?: RunSession,
): { key: string; legacyKey?: string } {
  if (existing) return { key: existing.key };
  const ordinary = sessionKey(threadKey, agent);
  if (!coordinator?.unit || (agent !== "coding" && agent !== "review"))
    return { key: contextSessionKey(ordinary), legacyKey: ordinary };
  const key = workingSessionKey(
    { id: coordinator.parentInstanceId, attempt: coordinator.instanceAttempt },
    coordinator.unit,
    agent,
  );
  return { key: contextSessionKey(key), legacyKey: ordinary };
}
