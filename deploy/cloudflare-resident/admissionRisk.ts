import {
  abandonmentAuditSchema,
  maintenanceRecordSchema,
  releaseWindowSchema,
  liveMaintenanceWindow,
} from "../../src/deploy/residentMaintenance.js";
import { admissionRecordHash } from "./admissionRecovery.js";
export * from "../../src/deploy/residentMaintenance.js";

/** One calculation for every global gate. Missing evidence never qualifies
 * an exception, even when the required original row has disappeared. */
export async function deployObligations(input: {
  rows: ReadonlyMap<string, unknown>;
  maintenance: unknown;
  audit: unknown;
  window: unknown;
  drain: unknown;
  now: number;
  purpose?: "deploy" | "release";
}) {
  const result = { stored: input.rows.size, excluded: 0, blocking: input.rows.size, qualified: false };
  const held = maintenanceRecordSchema.safeParse(input.maintenance);
  const audit = abandonmentAuditSchema.safeParse(input.audit);
  const window = releaseWindowSchema.safeParse(input.window);
  if (!held.success || held.data.state !== "held" || !audit.success || !window.success) return result;
  const hold = held.data;
  const policy = hold.policy;
  const deadline = policy.attempt.deadline;
  const drain = input.drain as { since?: unknown; until?: unknown; swapVersion?: unknown } | null;
  if (
    !Number.isSafeInteger(input.now) ||
    input.now < hold.installedAt ||
    (input.purpose !== "release" && !liveMaintenanceWindow(hold, input.now)) ||
    JSON.stringify(audit.data.policy) !== JSON.stringify(policy) ||
    audit.data.decidedAt < hold.installedAt ||
    audit.data.decidedAt > input.now ||
    window.data.recordId !== audit.data.id ||
    window.data.holdId !== policy.holdId ||
    window.data.generation !== policy.generation ||
    window.data.attemptId !== policy.attempt.id ||
    (input.purpose !== "release" &&
      (drain?.since !== window.data.drain.since ||
        drain.until !== window.data.drain.until ||
        deadline > Date.parse(window.data.drain.until) ||
        input.now >= Date.parse(window.data.drain.until) ||
        (window.data.state !== "claimed" && drain.swapVersion !== window.data.drain.versionId)))
  )
    return result;
  const original = input.rows.get(`deploy:admission:${audit.data.id}`);
  if (
    audit.data.originalRecord.startedAt !== (original as { startedAt?: unknown } | undefined)?.startedAt ||
    (await admissionRecordHash(audit.data.originalRecord)) !== audit.data.originalRecordSha256 ||
    (await admissionRecordHash(original)) !== audit.data.originalRecordSha256
  )
    return result;
  return { stored: input.rows.size, excluded: 1, blocking: input.rows.size - 1, qualified: true };
}
