import type { ExecutionConfig } from "./factory.js";
import { workspaceBindingOf } from "./factory.js";
import { processSecrets, type Secrets } from "../secrets.js";
import type { LiveRunRow } from "../core/runLedger/types.js";
import {
  cancellationRuntimeSupported,
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
  const target = (binding: ReturnType<typeof workspaceBindingOf>) => {
    const resident = binding?.backend === "resident";
    return {
      url: resident ? execution?.resident?.baseUrl : execution?.url,
      token: secrets.named(
        resident
          ? (execution?.resident?.tokenEnv ?? "RESIDENT_OPERATOR_TOKEN")
          : (execution?.apiKeyEnv ?? "SANDBOX_TOKEN"),
      ),
    };
  };
  const stop = async (row: LiveRunRow, cancellation: RunCancellation): Promise<RuntimeStopResult> => {
    const binding = workspaceBindingOf(row.state.binding);
    if (!binding)
      return row.state.binding === undefined && cancellationRuntimeSupported(row)
        ? { stopped: true, disposition: "no-workspace" }
        : { stopped: false };
    const resident = binding.backend === "resident";
    if (!resident && binding.backend !== "sandbox") return { stopped: false };
    const { url, token } = target(binding);
    if (!url || !token) return { stopped: false };
    const response = await fetchImpl(new URL("/cancel-run", url), {
      method: "POST",
      headers: {
        authorization: `Bearer ${token.reveal()}`,
        "content-type": "application/json",
        ...(!resident && binding.sandboxKey ? { "x-thread-key": binding.sandboxKey } : {}),
      },
      body: JSON.stringify({ cancellation, binding, ...(resident ? { resource: `repo:${row.meta.repo}` } : {}) }),
      signal: AbortSignal.timeout(RUN_STORE_TIMEOUT_MS),
    });
    if (!response.ok) return { stopped: false };
    const result = (await response.json()) as Record<string, unknown>;
    return result.stopped === true &&
      result.cancellationId === cancellation.id &&
      result.disposition === (resident ? "processes-stopped" : "workspace-discarded")
      ? { stopped: true, disposition: resident ? "processes-stopped" : "workspace-discarded" }
      : { stopped: false };
  };
  return Object.assign(stop, {
    supports: (row: LiveRunRow) => {
      if (!cancellationRuntimeSupported(row)) return false;
      if (row.state.binding === undefined) return true;
      const binding = workspaceBindingOf(row.state.binding);
      if (!binding || (binding.backend === "resident" && !row.meta.repo)) return false;
      const { url, token } = target(binding);
      return Boolean(url && token);
    },
  });
}
