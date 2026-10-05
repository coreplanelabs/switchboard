import { UNKNOWN_CONTEXT_DEPENDENCIES } from "../references/contextDependencies.js";
import { sourceHash } from "../references/receipts.js";
import { contextThreadSessionKey, storedTurnRow } from "../runLedger/sessionLog.js";
import {
  isCoordinatorReportAdmission,
  type CoordinatorReportAdmission,
  type CoordinatorReportOwner,
} from "./reportAdmission.js";
import { coordinatorReportOwnerIdentity, type CoordinatorReportLedger } from "./reportContext.js";

/** A positive channel reply ACK, never inferred from the earlier ending CAS. */
export interface CoordinatorPublicDeliveryReference {
  version: 1;
  owner: CoordinatorReportOwner;
  proposalHash: string;
  threadHash: string;
  kind: "reply" | "empty";
}
export function isCoordinatorPublicDeliveryReference(value: unknown): value is CoordinatorPublicDeliveryReference {
  if (!value || typeof value !== "object") return false;
  const r = value as CoordinatorPublicDeliveryReference;
  return (
    Object.keys(r).length === 5 &&
    Object.keys(r).every((k) => ["version", "owner", "proposalHash", "threadHash", "kind"].includes(k)) &&
    isCoordinatorReportAdmission({ version: r.version, owner: r.owner, proposalHash: r.proposalHash }) &&
    typeof r.threadHash === "string" &&
    /^[a-f0-9]{64}$/.test(r.threadHash) &&
    (r.kind === "reply" || r.kind === "empty")
  );
}
export async function coordinatorPublicDeliveryReference(
  admission: CoordinatorReportAdmission,
  threadText: string,
): Promise<CoordinatorPublicDeliveryReference> {
  if (!isCoordinatorReportAdmission(admission)) throw new Error("public report admission is invalid");
  return {
    version: 1,
    owner: coordinatorReportOwnerIdentity(admission.owner),
    proposalHash: admission.proposalHash,
    threadHash: await sourceHash(threadText),
    kind: threadText.length === 0 ? "empty" : "reply",
  };
}
const rowIdOf = async (owner: CoordinatorReportOwner) =>
  `coordinator-public-delivery:${await sourceHash(coordinatorReportOwnerIdentity(owner))}`;

/** Absence permits the original frozen reply. Malformed or conflicting ACK
 * bytes remain held: an unreadable ACK never authorizes replacement. */
export async function readCoordinatorPublicDelivery(
  ledger: Pick<CoordinatorReportLedger, "readSessionEntry">,
  ref: CoordinatorPublicDeliveryReference,
): Promise<CoordinatorPublicDeliveryReference | undefined> {
  if (!isCoordinatorPublicDeliveryReference(ref)) throw new Error("public report delivery reference is invalid");
  const rows = await ledger.readSessionEntry(contextThreadSessionKey(ref.owner.threadKey), await rowIdOf(ref.owner));
  if (rows === undefined) return undefined;
  if (rows.length !== 1 || rows[0]!.part !== 0) throw new Error("public report delivery ACK is invalid");
  const saved = JSON.parse(rows[0]!.json);
  if (
    !saved ||
    typeof saved !== "object" ||
    Object.keys(saved).length !== 6 ||
    saved.role !== "assistant" ||
    saved.silent !== true ||
    saved.folded !== true ||
    saved.part?.type !== "text" ||
    saved.part.text !== "" ||
    !isCoordinatorPublicDeliveryReference(saved.coordinatorPublicDelivery) ||
    saved.coordinatorPublicDelivery.proposalHash !== ref.proposalHash ||
    saved.coordinatorPublicDelivery.threadHash !== ref.threadHash ||
    saved.coordinatorPublicDelivery.kind !== ref.kind ||
    (await sourceHash(coordinatorReportOwnerIdentity(saved.coordinatorPublicDelivery.owner))) !==
      (await sourceHash(coordinatorReportOwnerIdentity(ref.owner))) ||
    (await sourceHash(saved.context)) !== (await sourceHash(UNKNOWN_CONTEXT_DEPENDENCIES))
  )
    throw new Error("public report delivery ACK does not match its original bytes");
  return saved.coordinatorPublicDelivery;
}

/** Call only after a positive reply, or when the admitted thread copy is empty.
 * A lost append ACK may repeat the same frozen reply; a readable ACK suppresses it. */
export async function appendCoordinatorPublicDelivery(
  ledger: CoordinatorReportLedger,
  ref: CoordinatorPublicDeliveryReference,
): Promise<CoordinatorPublicDeliveryReference | undefined> {
  const previous = await readCoordinatorPublicDelivery(ledger, ref);
  if (previous) return previous;
  const json = JSON.stringify({
    ...JSON.parse(
      storedTurnRow({ role: "assistant", text: "", silent: true, folded: true, context: UNKNOWN_CONTEXT_DEPENDENCIES }),
    ),
    coordinatorPublicDelivery: ref,
  });
  const result = await ledger.appendSession(
    contextThreadSessionKey(ref.owner.threadKey),
    await rowIdOf(ref.owner),
    [{ part: 0, json }],
    UNKNOWN_CONTEXT_DEPENDENCIES,
  );
  if (!result.ok) return undefined;
  return readCoordinatorPublicDelivery(ledger, ref);
}
