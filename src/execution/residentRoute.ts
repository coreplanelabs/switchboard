/** Stable resident address and its immutable thread-placement identity.
 * Neither field replaces the run owner, attachment fence or VM boot identity. */
export interface ResidentRoute {
  residentId: string;
  placementId: string;
}

/** Undefined is a legacy binding. Null is malformed and must never be
 * stripped into a legacy fallback to the primary resident. */
export function residentRouteOf(value: unknown): ResidentRoute | null | undefined {
  if (!value || typeof value !== "object") return undefined;
  const row = value as Record<string, unknown>;
  if (!Object.hasOwn(row, "residentId") && !Object.hasOwn(row, "placementId")) return undefined;
  if (
    typeof row.residentId !== "string" ||
    !/^[a-zA-Z0-9][a-zA-Z0-9_:/.-]{0,62}$/.test(row.residentId) ||
    typeof row.placementId !== "string" ||
    !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(row.placementId)
  )
    return null;
  return { residentId: row.residentId, placementId: row.placementId };
}

export function sameResidentRoute(a: ResidentRoute, b: ResidentRoute): boolean {
  return a.residentId === b.residentId && a.placementId === b.placementId;
}
