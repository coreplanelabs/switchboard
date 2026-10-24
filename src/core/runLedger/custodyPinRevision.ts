/** Leaf codec shared by storage readers without importing workspace recovery. */
const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const natural = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) >= 0;

export interface CustodyPinRevision {
  version: 1;
  revision: number;
  guarded: boolean;
}
export function custodyPinRevisionOf(value: unknown): CustodyPinRevision | undefined {
  if (
    !object(value) ||
    Object.keys(value).some((k) => !["version", "revision", "guarded"].includes(k)) ||
    value.version !== 1 ||
    !natural(value.revision) ||
    typeof value.guarded !== "boolean" ||
    (value.guarded && value.revision === 0)
  )
    return;
  return { version: 1, revision: value.revision, guarded: value.guarded };
}
