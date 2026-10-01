import { UNKNOWN_CONTEXT_DEPENDENCIES } from "../references/contextDependencies.js";
import { sourceHash } from "../references/receipts.js";
import type { RunLedger } from "../runLedger/ledger.js";
import { contextThreadSessionKey, storedTurnRow } from "../runLedger/sessionLog.js";

export type CoordinatorReportLedger = Pick<RunLedger, "appendSession" | "readSessionEntry">;
import {
  isCoordinatorReportAdmission,
  type CoordinatorReportOwner,
  type CoordinatorReportAdmission,
} from "./reportAdmission.js";
export {
  isCoordinatorReportAdmission,
  type CoordinatorReportOwner,
  type CoordinatorReportAdmission,
} from "./reportAdmission.js";
const canonicalOwner = (o: CoordinatorReportOwner): CoordinatorReportOwner => ({
  instanceId: o.instanceId,
  unit: o.unit,
  attempt: o.attempt,
  requester: o.requester,
  channelId: o.channelId,
  threadKey: o.threadKey,
  deliveryId: o.deliveryId,
});
export async function coordinatorReportAdmission(
  owner: CoordinatorReportOwner,
  proposed: { text: string; threadText: string },
): Promise<CoordinatorReportAdmission> {
  const identity = canonicalOwner(owner);
  return {
    version: 1,
    owner: identity,
    proposalHash: await sourceHash({ owner: identity, text: proposed.text, threadText: proposed.threadText }),
  };
}
export async function sameCoordinatorReportAdmission(
  a: CoordinatorReportAdmission | undefined,
  b: CoordinatorReportAdmission,
): Promise<boolean> {
  return (
    isCoordinatorReportAdmission(a) &&
    a.proposalHash === b.proposalHash &&
    (await sourceHash(canonicalOwner(a.owner))) === (await sourceHash(canonicalOwner(b.owner)))
  );
}
export function sameCoordinatorReportOwner(a: CoordinatorReportOwner, b: CoordinatorReportOwner): boolean {
  return JSON.stringify(canonicalOwner(a)) === JSON.stringify(canonicalOwner(b));
}
export async function freezeAdmittedCoordinatorReport(
  ledger: CoordinatorReportLedger,
  admission: CoordinatorReportAdmission | undefined,
  owner: CoordinatorReportOwner,
  proposed: { text: string; threadText: string },
): Promise<{ text: string; threadText: string }> {
  if (!(await sameCoordinatorReportAdmission(admission, await coordinatorReportAdmission(owner, proposed))))
    throw new Error("coordinator report proposal was not admitted");
  const saved = await freezeCoordinatorReport(ledger, owner, proposed);
  if (!(await sameCoordinatorReportAdmission(admission, await coordinatorReportAdmission(owner, saved))))
    throw new Error("coordinator report conflicts with its canonical admission");
  return saved;
}

export async function readCoordinatorReport(
  ledger: CoordinatorReportLedger,
  owner: CoordinatorReportOwner,
): Promise<{ text: string; threadText: string } | undefined> {
  const key = contextThreadSessionKey(owner.threadKey);
  const rowId = `coordinator-report:${await sourceHash(owner)}`;
  const rows = await ledger.readSessionEntry(key, rowId);
  if (rows === undefined) return undefined;
  if (rows.length !== 1 || rows[0]!.part !== 0) throw new Error("coordinator report snapshot is invalid");
  const row = JSON.parse(rows[0]!.json);
  if (
    row.role !== "assistant" ||
    row.part?.type !== "text" ||
    typeof row.part.text !== "string" ||
    row.coordinatorReport?.version !== 1 ||
    typeof row.coordinatorReport.threadText !== "string" ||
    (await sourceHash(row.coordinatorReport.owner)) !== (await sourceHash(owner)) ||
    (await sourceHash(row.context)) !== (await sourceHash(UNKNOWN_CONTEXT_DEPENDENCIES))
  )
    throw new Error("coordinator report snapshot does not match its original delivery");
  return { text: row.part.text as string, threadText: row.coordinatorReport.threadText as string };
}

/** Coordinator prose is not a source receipt. Keep it intact for diagnostics,
 * with unknown provenance, until a typed producer can prove every input. */
export async function freezeCoordinatorReport(
  ledger: CoordinatorReportLedger,
  owner: CoordinatorReportOwner,
  proposed: { text: string; threadText: string },
): Promise<{ text: string; threadText: string }> {
  const key = contextThreadSessionKey(owner.threadKey);
  const rowId = `coordinator-report:${await sourceHash(owner)}`;
  const previous = await readCoordinatorReport(ledger, owner);
  if (previous) return previous;
  const json = JSON.stringify({
    ...JSON.parse(
      storedTurnRow({ role: "assistant", text: proposed.text, folded: true, context: UNKNOWN_CONTEXT_DEPENDENCIES }),
    ),
    coordinatorReport: { version: 1, owner, threadText: proposed.threadText },
  });
  const appended = await ledger.appendSession(key, rowId, [{ part: 0, json }], UNKNOWN_CONTEXT_DEPENDENCIES);
  if (!appended.ok) throw new Error("coordinator report persistence was not acknowledged");
  const saved = await readCoordinatorReport(ledger, owner);
  // A concurrent writer may win with another rendering. Its durable bytes are
  // the only replayable delivery; unavailable or trimmed bytes never regenerate.
  if (!saved) throw new Error("coordinator report could not be saved");
  return saved;
}
