import type { RunWorkOwner } from "../runRecord.js";
import { isCoordinatorInstance, isCoordinatorUnit } from "./contract.js";
import type { PullOwnershipRows } from "./pullOwnership.js";

/** Exact canonical unit selection shared by ownership and its observations. */
export function initialOwnerUnits(record: RunWorkOwner, units: PullOwnershipRows["units"]): PullOwnershipRows["units"] {
  return units.filter((row) => isCoordinatorInstance(row.instance) && isCoordinatorUnit(row.unit) &&
    row.instance.id === record.parentInstanceId && row.unit.instanceId === record.parentInstanceId && row.unit.unit === record.coordinatorUnit);
}
