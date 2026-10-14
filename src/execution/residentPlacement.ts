export interface ResidentPlacement {
  schema: 1;
  resource: string;
  threadKey: string;
  residentId: string;
  placementId: string;
}

/** The registry passes its transaction, never an unguarded storage handle. */
interface PlacementTransaction {
  get(key: string): Promise<unknown>;
  put(key: string, value: ResidentPlacement): Promise<unknown>;
}

function placementOf(value: unknown, proposed: ResidentPlacement): ResidentPlacement | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  if (
    row.schema !== 1 ||
    row.resource !== proposed.resource ||
    row.threadKey !== proposed.threadKey ||
    typeof row.residentId !== "string" ||
    !/^[a-zA-Z0-9][a-zA-Z0-9_:/.-]{0,62}$/.test(row.residentId) ||
    typeof row.placementId !== "string" ||
    !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(row.placementId)
  )
    return null;
  return {
    schema: 1,
    resource: proposed.resource,
    threadKey: proposed.threadKey,
    residentId: row.residentId,
    placementId: row.placementId,
  };
}

/** Placement precedes attach. A failed write must not yield a destination;
 * a later read can recover the same committed row after acknowledgment loss.
 * Placement does not authorize native work or acknowledge its completion. */
export async function recordResidentPlacement(
  transaction: PlacementTransaction,
  proposed: ResidentPlacement,
): Promise<{ ok: true; placement: ResidentPlacement } | { ok: false; reason: "placement-unverified" }> {
  // Tuple encoding is unambiguous and stays outside repository enumeration.
  const key = `placement:${JSON.stringify([proposed.resource, proposed.threadKey])}`;
  const saved = await transaction.get(key);
  const placement = placementOf(saved === undefined ? proposed : saved, proposed);
  if (!placement) return { ok: false, reason: "placement-unverified" };
  if (saved === undefined) await transaction.put(key, placement);
  return { ok: true, placement };
}
