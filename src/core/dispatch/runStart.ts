import type { ChannelIO } from "../types.js";
import type { RunControl } from "../runRegistry/runControl.js";
import type { RunRegistry } from "../runRegistry.js";

/** A registered run must still belong to its channel delivery before it acts.
 * Keep registration intact on failure so each caller can finish or discard it
 * through its ordinary stop path, without leaking an unfinished registry row. */
export async function awaitChannelAdmission(io: ChannelIO, registry: RunRegistry, runId: string): Promise<void> {
  try {
    await io.runStarted?.({ id: runId });
  } catch {
    registry.requestStopById(runId, "hard", { kind: "chat", id: "channel:admission-lost" });
  }
}

/** Inline runs have no model loop to carry a stop outcome to the dispatcher. */
export class RunAdmissionStopped extends Error {
  constructor(readonly control: RunControl) {
    super("Run stopped before execution.");
    this.name = "RunAdmissionStopped";
  }
}
