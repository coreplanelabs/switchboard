import { workspaceBindingFor, type ExecutorSelection, type WorkspaceBinding } from "../../execution/factory.js";
import type { MachineClass } from "../../agents/registry.js";
import type { LedgerRun } from "../runLedger/writeThrough.js";

/** A queued binding patch cannot authorize continuation: the next generation
 * must first be able to read the same reattached workspace and repair receipt
 * from the ledger. */
export function resumedPilotBindingFor(
  selection: ExecutorSelection,
  machine: MachineClass,
  recorded: WorkspaceBinding,
): WorkspaceBinding | undefined {
  const rebound = workspaceBindingFor(selection, machine, recorded);
  if (!rebound) return undefined;
  // Reattach can return a verified seeded checkout without repeating its
  // original physical identity. Keep the recorded owner for the next retry.
  return rebound.backend === recorded.backend
    ? {
        ...rebound,
        ...(rebound.container === undefined && recorded.container ? { container: recorded.container } : {}),
        ...(rebound.sandboxKey === undefined && recorded.sandboxKey ? { sandboxKey: recorded.sandboxKey } : {}),
      }
    : rebound;
}

export async function commitResumedPilotBinding(
  run: Pick<LedgerRun, "commitState"> | undefined,
  selection: ExecutorSelection,
  machine: MachineClass,
  recorded: WorkspaceBinding,
): Promise<boolean> {
  const binding = resumedPilotBindingFor(selection, machine, recorded);
  if (!binding || !run) return false;
  try {
    return (await run.commitState({ binding })) === "ok";
  } catch {
    return false;
  }
}
