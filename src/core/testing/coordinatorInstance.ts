import type { CoordinatorInstance, CoordinatorUnit } from "../coordinator/contract.js";
import type { InMemoryCoordinatorInstanceStore } from "../coordinator/instanceStore.js";

/** Seed retained inputs or an adversarial read snapshot without invoking production cleanup. */
export function seedCoordinatorInstance(store: InMemoryCoordinatorInstanceStore, instance: CoordinatorInstance): void {
  const rows = (store as unknown as { rows: Map<string, string> }).rows;
  rows.set(instance.id, JSON.stringify(instance));
}

/** Seed existing evidence; this does not assert that a new admission accepts it. */
export function seedCoordinatorUnit(store: InMemoryCoordinatorInstanceStore, unit: CoordinatorUnit): void {
  const units = (store as unknown as { units: Map<string, string> }).units;
  units.set(`${unit.instanceId}\0${unit.unit}`, JSON.stringify(unit));
}
