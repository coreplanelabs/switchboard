/** One deploy's durable progress for a resident container. A repeated
 *  reconcile may retry a deferred stop or collect an inactive container's
 *  report, but must not stop a replacement that is still hydrating. */
export interface DeployImageReconcileState {
  build: string;
  cycleIssued: boolean;
  cycleStoppedAt?: string;
  containerBeforeCycle?: string;
}

export type DeployImageReconcileAction = "start" | "retry-cycle" | "await-report" | "verified";

export function nextDeployImageReconcile(
  build: string,
  stored: unknown,
  reportPending: boolean,
): DeployImageReconcileAction {
  if (!stored || typeof stored !== "object") return "start";
  const state = stored as Record<string, unknown>;
  if (state.build !== build || typeof state.cycleIssued !== "boolean") return "start";
  if (!reportPending) return "verified";
  return state.cycleIssued ? "await-report" : "retry-cycle";
}

/** A fresh boot after the requested stop can finish hydration and report. */
export function replacementContainerStarted(before: string | undefined, current: string | undefined): boolean {
  return before !== undefined && current !== undefined && before !== current;
}
