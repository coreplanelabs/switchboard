import { INSTANCE_ID_PATTERN, isCoordinatorUnit, type CoordinatorUnit } from "./contract.js";

export const UNIT_GROUP_MAX_ROWS = 20_000;
export const UNIT_GROUP_MAX_BYTES = 8 * 1024 * 1024;

export interface UnitGroup {
  instanceId: string;
  units: CoordinatorUnit[];
}
export function validUnitGroupIds(ids: unknown): ids is string[] {
  return (
    Array.isArray(ids) &&
    ids.length > 0 &&
    ids.length <= 100 &&
    new Set(ids).size === ids.length &&
    ids.every((id) => typeof id === "string" && INSTANCE_ID_PATTERN.test(id))
  );
}
export function readUnitGroups(value: unknown, ids: readonly string[]): UnitGroup[] {
  if (
    !Array.isArray(value) ||
    value.length !== ids.length ||
    value.reduce((count, row) => count + (Array.isArray(row?.units) ? row.units.length : 0), 0) > UNIT_GROUP_MAX_ROWS ||
    new Set(value.map((row) => row?.instanceId)).size !== ids.length ||
    value.some(
      (row) =>
        !row ||
        !ids.includes(row.instanceId) ||
        !Array.isArray(row.units) ||
        !row.units.every((unit: unknown) => isCoordinatorUnit(unit) && unit.instanceId === row.instanceId),
    )
  )
    throw new Error("Pipeline unit groups are unavailable.");
  return value as UnitGroup[];
}
