import type { ExecutionConfig, WorkspaceBinding } from "./factory.js";
import { workspaceBindingOf } from "./factory.js";
import { processSecrets, type Secrets } from "../secrets.js";
import type { LiveRunRow } from "../core/runLedger/types.js";
import {
  cancellationRuntimeSupported,
  unboundNativeReview,
  cancellationRefusalOf,
  cancellationObservationOf,
  type CancellationRefusal,
  type RunCancellation,
  type RuntimeStopResult,
} from "../core/runLedger/cancellation.js";
import { RUN_STORE_TIMEOUT_MS } from "../core/runStoreConstants.js";

/** Stop the store-fenced target without attaching or launching a replacement. */
export function createRunStop(
  execution: ExecutionConfig | undefined,
  secrets: Secrets = processSecrets,
  fetchImpl = fetch,
) {
  if (execution?.type !== "cloudflare" && !execution?.resident) return undefined;
  const target = (resident: boolean) => {
    return {
      url: resident ? execution?.resident?.baseUrl : execution?.url,
      token: secrets.named(
        resident
          ? (execution?.resident?.tokenEnv ?? "RESIDENT_OPERATOR_TOKEN")
          : (execution?.apiKeyEnv ?? "SANDBOX_TOKEN"),
      ),
    };
  };
  const unavailable = (row: LiveRunRow): CancellationRefusal | undefined => {
    if (row.meta.hosted) return { phase: "prepare", cause: "custody-unverified" };
    const binding = workspaceBindingOf(row.state.binding);
    if (!cancellationRuntimeSupported(row) || (binding?.backend === "resident" && !row.meta.repo))
      return { phase: "prepare", cause: "custody-unverified" };
    if (row.state.binding === undefined && row.meta.profile?.machine === "none")
      return { phase: "prepare", cause: "custody-unverified" };
    if (unboundNativeReview(row)) {
      for (const resident of [true, false]) {
        const { url, token } = target(resident);
        if (!url || !token)
          return {
            phase: resident ? ("resident" as const) : ("sandbox" as const),
            cause: "runtime-unavailable" as const,
          };
      }
      return;
    }
    if (
      (!binding && row.meta.selection !== "resident") ||
      (binding && binding.backend !== "resident" && binding.backend !== "sandbox")
    )
      return { phase: "prepare", cause: "custody-unverified" };
    const { url, token } = target(binding?.backend === "resident" || (!binding && row.meta.selection === "resident"));
    if (!url || !token)
      return {
        phase: binding?.backend === "resident" || row.meta.selection === "resident" ? "resident" : "sandbox",
        cause: "runtime-unavailable",
      };
  };
  const stopTarget = async (
    row: LiveRunRow,
    cancellation: RunCancellation,
    resident: boolean,
    binding: WorkspaceBinding | undefined,
  ): Promise<RuntimeStopResult> => {
    const { url, token } = target(resident);
    if (!url || !token) return { stopped: false, refusal: { phase: "prepare", cause: "state-unconfigured" } };
    const phase = resident ? "resident" : "sandbox";
    const unconfirmed = (): RuntimeStopResult => ({
      stopped: false as const,
      refusal: { phase, cause: "runtime-unconfirmed" as const },
    });
    try {
      const response = await fetchImpl(new URL(resident ? "/native/cancel-run" : "/cancel-run", url), {
        method: "POST",
        headers: {
          authorization: `Bearer ${token.reveal()}`,
          "content-type": "application/json",
          ...(!resident && binding?.sandboxKey ? { "x-thread-key": binding.sandboxKey } : {}),
        },
        body: JSON.stringify({
          cancellation,
          binding: binding ?? null,
          ...(resident ? { resource: `repo:${row.meta.repo}` } : {}),
        }),
        signal: AbortSignal.timeout(RUN_STORE_TIMEOUT_MS),
      });
      const result = (await response.json().catch(() => null)) as Record<string, unknown> | null;
      if (result?.cancellationId === cancellation.id && result.stopped === false) {
        const refusal = cancellationRefusalOf(result.refusal);
        if (refusal && (refusal.phase === "prepare" || refusal.phase === phase)) {
          const observation =
            phase === "resident" && refusal.cause === "kill-unconfirmed"
              ? cancellationObservationOf(result.observation)
              : undefined;
          return { stopped: false, refusal, ...(observation ? { observation } : {}) };
        }
      }
      if (!response.ok) return { stopped: false, refusal: { phase, cause: "runtime-http-refusal" } };
      if (!result || result.cancellationId !== cancellation.id || result.stopped !== true) return unconfirmed();
      if (resident && (result.disposition === "processes-stopped" || result.disposition === "runtime-retired"))
        return { stopped: true, disposition: result.disposition };
      if (resident && cancellation.targets && result.disposition === "no-workspace")
        return { stopped: true, disposition: "no-workspace" };
      if (!resident && result.disposition === "workspace-discarded")
        return { stopped: true, disposition: "workspace-discarded" };
      return unconfirmed();
    } catch {
      return unconfirmed();
    }
  };
  const stop = async (row: LiveRunRow, cancellation: RunCancellation): Promise<RuntimeStopResult> => {
    const refusal = unavailable(row);
    if (refusal) return { stopped: false, refusal };
    const binding = workspaceBindingOf(row.state.binding);
    if (!binding && cancellation.targets) {
      const [resident, sandbox] = await Promise.all([
        stopTarget(row, cancellation, true, undefined),
        stopTarget(row, cancellation, false, { backend: "sandbox", sandboxKey: cancellation.targets.sandboxKey }),
      ]);
      if (!resident.stopped) return resident;
      if (!sandbox.stopped) return sandbox;
      return { stopped: true, disposition: "isolated-targets-stopped" };
    }
    return stopTarget(
      row,
      cancellation,
      binding?.backend === "resident" || (!binding && row.meta.selection === "resident"),
      binding,
    );
  };
  return Object.assign(stop, {
    supports: (row: LiveRunRow) => unavailable(row) === undefined,
    unavailable,
  });
}
