import type { Backend } from "../core/trace/attrs.js";
import { modelSandboxIdentity } from "../execution/coldPublicationBoundary.js";
import type { AppState, ContainerInstance, Read } from "./sandboxLiveGate.js";
import { closedReadEvidence, type NativeReadEvidence } from "./pagingDiagnostic.js";

export interface SandboxRunTarget {
  thread: string;
  backend: Backend | null;
  sandboxKey: string | null;
}

/** Read only the original run's selected attachment, never infer a physical
 * name from its agent or conversation. Older records have no mapping. */
export function sandboxRunTargetOf(record: { threadKey: string; events?: unknown }): SandboxRunTarget {
  const attach = Array.isArray(record.events)
    ? ([...record.events].reverse().find((event: unknown) => {
        const e = event as Record<string, unknown> | null;
        return e?.type === "span_end" && e.name === "dispatch.workspace.attach";
      }) as { status?: unknown; attrs?: { backend?: unknown; sandboxKey?: unknown } } | undefined)
    : undefined;
  const selectedBackend = attach?.status === "ok" ? attach.attrs?.backend : undefined;
  const backend =
    selectedBackend === "sandbox" ||
    selectedBackend === "resident" ||
    selectedBackend === "local" ||
    selectedBackend === "e2b"
      ? selectedBackend
      : null;
  const key = attach?.attrs?.sandboxKey;
  return {
    thread: record.threadKey,
    backend,
    sandboxKey: backend === "sandbox" && typeof key === "string" ? modelSandboxIdentity("/exec", key) : null,
  };
}

export interface SandboxRunObservation {
  observedAt: number;
  finishedAt: number;
  thread: string;
  backend: Backend | null;
  sandboxKey: string | null;
  mapping: "recorded" | "unavailable" | "not-sandbox";
  application: { id: string | null; version: number; image: string | null; activeRolloutId: string | null } | null;
  instances: { id: string | null; state: string; version: number | null }[];
  inventory: "complete" | "unavailable";
  matchingInstances: number;
  truncated: boolean;
  readFailures?: { application?: NativeReadEvidence; instances?: NativeReadEvidence };
}

/** These are control-plane observations at a stated time, not a claim about
 * which version previously executed a command or whether that command ended. */
export async function observeSandboxRun(
  target: SandboxRunTarget,
  deps: {
    now(): number;
    readApp(): Promise<Read<AppState> & { diagnostic?: NativeReadEvidence }>;
    readInstances(): Promise<Read<ContainerInstance[]> & { diagnostic?: NativeReadEvidence }>;
  },
): Promise<SandboxRunObservation> {
  const observedAt = deps.now();
  const mapping =
    target.backend === null || (target.backend === "sandbox" && target.sandboxKey === null)
      ? "unavailable"
      : target.backend === "sandbox"
        ? "recorded"
        : "not-sandbox";
  if (mapping !== "recorded")
    return {
      ...target,
      mapping,
      observedAt,
      finishedAt: deps.now(),
      application: null,
      instances: [],
      inventory: "unavailable",
      matchingInstances: 0,
      truncated: false,
    };
  const [app, inventory] = await Promise.allSettled([deps.readApp(), deps.readInstances()]);
  const application = app.status === "fulfilled" && "value" in app.value ? app.value.value : undefined;
  const instances = inventory.status === "fulfilled" && "value" in inventory.value ? inventory.value.value : undefined;
  const matching = (instances ?? []).filter((instance) => instance.name === target.sandboxKey);
  const readFailure = (result: PromiseSettledResult<{ diagnostic?: NativeReadEvidence }>, stage: string) =>
    closedReadEvidence(
      result.status === "fulfilled"
        ? (result.value.diagnostic ?? { stage })
        : { stage, reason: "native-request-error" },
    );
  return {
    observedAt,
    finishedAt: deps.now(),
    ...target,
    mapping,
    application: application
      ? {
          id: application.id ?? null,
          version: application.version,
          image: application.image,
          activeRolloutId: application.activeRolloutId ?? null,
        }
      : null,
    instances: matching.slice(0, 4).map((instance) => ({
      id: instance.id ?? null,
      state: instance.state,
      version: instance.version,
    })),
    inventory: instances ? "complete" : "unavailable",
    matchingInstances: matching.length,
    truncated: matching.length > 4,
    ...(!application || !instances
      ? {
          readFailures: {
            ...(!application ? { application: readFailure(app, "application-info") } : {}),
            ...(!instances ? { instances: readFailure(inventory, "instances") } : {}),
          },
        }
      : {}),
  };
}
