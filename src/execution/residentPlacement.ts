import { residentRouteOf } from "./residentRoute.js";
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

function placementOf(
  value: unknown,
  proposed: Pick<ResidentPlacement, "resource" | "threadKey">,
): ResidentPlacement | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  const route = residentRouteOf(row);
  if (row.schema !== 1 || row.resource !== proposed.resource || row.threadKey !== proposed.threadKey || !route)
    return null;
  return {
    schema: 1,
    resource: proposed.resource,
    threadKey: proposed.threadKey,
    ...route,
  };
}

const placementKey = (resource: string, threadKey: string) => `placement:${JSON.stringify([resource, threadKey])}`;

/** Read-only routing and cancellation never allocate a replacement address. */
export async function readResidentPlacement(
  transaction: Pick<PlacementTransaction, "get">,
  resource: string,
  threadKey: string,
): Promise<ResidentPlacement | null | undefined> {
  const saved = await transaction.get(placementKey(resource, threadKey));
  return saved === undefined ? undefined : placementOf(saved, { resource, threadKey });
}

/** Placement precedes attach. A failed write must not yield a destination;
 * a later read can recover the same committed row after acknowledgment loss.
 * Placement does not authorize native work or acknowledge its completion. */
export async function recordResidentPlacement(
  transaction: PlacementTransaction,
  proposed: ResidentPlacement,
): Promise<{ ok: true; placement: ResidentPlacement } | { ok: false; reason: "placement-unverified" }> {
  // Tuple encoding is unambiguous and stays outside repository enumeration.
  const key = placementKey(proposed.resource, proposed.threadKey);
  const saved = await transaction.get(key);
  const placement = placementOf(saved === undefined ? proposed : saved, proposed);
  if (!placement) return { ok: false, reason: "placement-unverified" };
  if (saved === undefined) await transaction.put(key, placement);
  return { ok: true, placement };
}
