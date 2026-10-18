import { authorize } from "./authz/authorize.js";
import type { Caller, CommandDef } from "./commandRegistry.js";
import { maintenanceRefusal, MAINTENANCE_UNAVAILABLE, type MaintenanceStore } from "./maintenance.js";

export function maintenanceRecoveryCommand(
  command: Pick<CommandDef<unknown>, "id" | "action" | "effect">,
  caller: Caller,
): boolean {
  if (command.id.startsWith("maintenance.") || command.id === "status.show") return true;
  const operator = authorize(caller.actor, "maintenance:write", { type: "command", id: "maintenance.start" }).allow;
  // Repair and inspection keep their own command authorization. This exception
  // never admits an agent, steer, queued approval, merge, or deterministic build.
  return (
    operator &&
    (command.effect === "read" || ["runs.stop", "plane.stop"].includes(command.id) || command.action === "repo:write")
  );
}
export async function commandMaintenanceRefusal(
  store: MaintenanceStore | undefined,
  command: Pick<CommandDef<unknown>, "id" | "action" | "effect">,
  caller: Caller,
): Promise<string | undefined> {
  if (!store || maintenanceRecoveryCommand(command, caller)) return;
  try {
    const state = await store.read();
    if (state.episode?.scopes.includes("all")) return maintenanceRefusal(state, "agents");
    if (command.id === "steer.run" || command.id === "pulls.rebase") return maintenanceRefusal(state, "agents");
    if (command.id === "repo.test" || command.id === "repo.build") return maintenanceRefusal(state, "residents");
  } catch {
    return MAINTENANCE_UNAVAILABLE;
  }
}
