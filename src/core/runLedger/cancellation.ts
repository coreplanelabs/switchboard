import { RUN_STORE_TIMEOUT_MS } from "../runStoreConstants.js";
import type { LiveRunRow } from "./types.js";
import type { RunRecord } from "../runRecord.js";
import { RUN_ID_PATTERN } from "../runIdentity.js";

export interface CancellationActor {
  kind: "chat" | "access" | "cli" | "mcp";
  id: string;
}
export interface RunCancellation {
  version: 1;
  id: string;
  runId: string;
  ownerGen: string;
  threadKey: string;
  startedAt: number;
  repo?: string;
  actor: CancellationActor;
}
export type CancellationDisposition = "workspace-discarded" | "processes-stopped" | "runtime-retired" | "no-workspace";
export type CancellationPhase = "prepare" | "sandbox" | "resident";
const CANCELLATION_REFUSAL_CAUSES = [
  "state-unconfigured",
  "state-http-refusal",
  "state-not-prepared",
  "ticket-mismatch",
  "state-unreachable",
  "target-mismatch",
  "ticket-conflict",
  "custody-unverified",
  "destroy-unconfirmed",
  "invalid-request",
  "kill-unconfirmed",
  "operations-busy",
  "native-outcome-unknown",
  "runtime-unavailable",
  "native-observation-unconfirmed",
  "target-changed",
  "runtime-unconfirmed",
  "runtime-http-refusal",
] as const;
export interface CancellationRefusal {
  phase: CancellationPhase;
  cause: (typeof CANCELLATION_REFUSAL_CAUSES)[number];
}
export type RuntimeStopResult =
  { stopped: true; disposition: CancellationDisposition } | { stopped: false; refusal?: CancellationRefusal };

/** Only the closed diagnostic crosses the runtime boundary, never its body. */
export function cancellationRefusalOf(value: unknown): CancellationRefusal | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return;
  const v = value as Record<string, unknown>;
  if (
    Object.keys(v).some((key) => !["phase", "cause"].includes(key)) ||
    typeof v.phase !== "string" ||
    !["prepare", "sandbox", "resident"].includes(v.phase) ||
    !CANCELLATION_REFUSAL_CAUSES.includes(v.cause as CancellationRefusal["cause"])
  )
    return;
  return { phase: v.phase as CancellationPhase, cause: v.cause as CancellationRefusal["cause"] };
}

export function cancellationFailureMessage(refusal?: CancellationRefusal): string {
  switch (refusal?.cause) {
    case "state-unconfigured":
      return "The shutdown service is unavailable.";
    case "state-http-refusal":
      return "The shutdown check was refused.";
    case "state-unreachable":
      return "The shutdown check did not answer.";
    case "ticket-mismatch":
    case "ticket-conflict":
      return "The shutdown request does not match the recorded stop.";
    case "target-mismatch":
      return "The shutdown target could not be confirmed.";
    case "target-changed":
      return "The shutdown target changed before confirmation.";
    case "state-not-prepared":
      return "The recorded stop could not be verified.";
    case "custody-unverified":
      return "The run's workspace could not be verified.";
    case "operations-busy":
      return "The run still has operations in progress.";
    case "native-outcome-unknown":
      return "An earlier operation has an unknown outcome.";
    case "runtime-unavailable":
      return "The run's runtime is unavailable.";
    case "runtime-http-refusal":
      return "The runtime refused the shutdown request.";
    case "kill-unconfirmed":
      return "Process shutdown was not confirmed.";
    case "destroy-unconfirmed":
      return "Workspace shutdown was not confirmed.";
    case "native-observation-unconfirmed":
      return "Runtime shutdown could not be verified.";
    case "runtime-unconfirmed":
      return "The shutdown operation has an unknown outcome.";
    default:
      return "Shutdown is not confirmed.";
  }
}
export type CancellationPreparation =
  | { ok: true; row: LiveRunRow; cancellation: RunCancellation }
  | { ok: false; reason: "unknown-run" | "fenced" | "unsupported" };

export function cancellationOf(value: unknown): RunCancellation | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return;
  const v = value as Record<string, unknown>;
  const actor = v.actor as CancellationActor | undefined;
  if (
    Object.keys(v).some(
      (k) => !["version", "id", "runId", "ownerGen", "threadKey", "startedAt", "actor", "repo"].includes(k),
    ) ||
    v.version !== 1 ||
    typeof v.id !== "string" ||
    !RUN_ID_PATTERN.test(v.id) ||
    typeof v.runId !== "string" ||
    !RUN_ID_PATTERN.test(v.runId) ||
    typeof v.ownerGen !== "string" ||
    !v.ownerGen ||
    v.ownerGen.length > 128 ||
    typeof v.threadKey !== "string" ||
    !v.threadKey ||
    v.threadKey.length > 512 ||
    typeof v.startedAt !== "number" ||
    !Number.isFinite(v.startedAt) ||
    (v.repo !== undefined && (typeof v.repo !== "string" || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(v.repo))) ||
    !actor ||
    typeof actor !== "object" ||
    Object.keys(actor).some((k) => !["kind", "id"].includes(k)) ||
    !["chat", "access", "cli", "mcp"].includes(actor.kind) ||
    typeof actor.id !== "string" ||
    !actor.id ||
    actor.id.length > 128
  )
    return;
  return structuredClone(v) as unknown as RunCancellation;
}

export function sameCancellation(a: RunCancellation | undefined, b: RunCancellation): boolean {
  return (
    !!a &&
    a.id === b.id &&
    a.runId === b.runId &&
    a.ownerGen === b.ownerGen &&
    a.threadKey === b.threadKey &&
    a.startedAt === b.startedAt &&
    a.repo === b.repo &&
    a.actor.kind === b.actor.kind &&
    a.actor.id === b.actor.id
  );
}

export function cancellationMatches(row: LiveRunRow, cancellation: RunCancellation): boolean {
  return (
    row.runId === cancellation.runId &&
    row.ownerGen === cancellation.ownerGen &&
    row.threadKey === cancellation.threadKey &&
    row.startedAt === cancellation.startedAt &&
    row.stop === "hard" &&
    sameCancellation(cancellationOf(row.state.cancellation), cancellation)
  );
}

export function cancellationRecordMatches(record: RunRecord, cancellation: RunCancellation): boolean {
  const receipt = record.cancellation;
  return (
    record.id === cancellation.runId &&
    record.startedAt === cancellation.startedAt &&
    record.threadKey === cancellation.threadKey &&
    record.repo === cancellation.repo &&
    record.status === "stopped_hard" &&
    !record.provisional &&
    !!receipt &&
    !!receipt.actor &&
    receipt.version === 1 &&
    receipt.actor.kind === cancellation.actor.kind &&
    receipt.actor.id === cancellation.actor.id &&
    ["workspace-discarded", "processes-stopped", "runtime-retired", "no-workspace"].includes(receipt.disposition) &&
    sameCancellation(cancellationOf(receipt.cancellation), cancellation)
  );
}

/** Compare the actual runtime target, rather than a caller's display name. */
export function cancellationBindingMatches(actual: unknown, requested: unknown): boolean {
  if (!actual || !requested || typeof actual !== "object" || typeof requested !== "object") return false;
  const a = actual as Record<string, unknown>,
    b = requested as Record<string, unknown>;
  return ["backend", "ref", "workspace", "container", "user", "ownerGen", "ownerFence", "sandboxKey"].every((key) =>
    Object.is(a[key] ?? null, b[key] ?? null),
  );
}

/** Only closed causes and validated identity enter this operator diagnostic. */
export function cancellationRefusal(
  cancellation: RunCancellation | undefined,
  phase: CancellationPhase,
  cause: CancellationRefusal["cause"],
): false {
  console.warn(
    JSON.stringify({
      event: "run.cancellation.refused",
      phase,
      cause,
      ...(cancellation ? { runId: cancellation.runId, cancellationId: cancellation.id } : {}),
    }),
  );
  return false;
}

export function cancellationFailure(
  cancellation: RunCancellation | undefined,
  phase: CancellationPhase,
  cause: CancellationRefusal["cause"],
) {
  cancellationRefusal(cancellation, phase, cause);
  return {
    stopped: false as const,
    ...(cancellation ? { cancellationId: cancellation.id } : {}),
    refusal: { phase, cause },
  };
}

export async function readCancellationPreparation(
  cancellation: RunCancellation,
  binding: unknown,
  url: string | undefined,
  token: string | undefined,
  fetchImpl = fetch,
): Promise<{ prepared: true } | ReturnType<typeof cancellationFailure>> {
  if (!url || !token) return cancellationFailure(cancellation, "prepare", "state-unconfigured");
  try {
    const response = await fetchImpl(new URL("/runs/cancellation/read", url), {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ storeKey: "runs:default", cancellation, binding }),
      signal: AbortSignal.timeout(RUN_STORE_TIMEOUT_MS),
    });
    if (!response.ok) return cancellationFailure(cancellation, "prepare", "state-http-refusal");
    const result = (await response.json()) as Record<string, unknown>;
    if (result.prepared !== true) return cancellationFailure(cancellation, "prepare", "state-not-prepared");
    if (result.cancellationId !== cancellation.id)
      return cancellationFailure(cancellation, "prepare", "ticket-mismatch");
    return { prepared: true };
  } catch {
    return cancellationFailure(cancellation, "prepare", "state-unreachable");
  }
}

/** A cancellation fence is irreversible by ordinary execution; select only a scoped runtime. */
export function cancellationRuntimeSupported(row: LiveRunRow): boolean {
  const b = row.state.binding;
  if (b === undefined) return row.meta.profile?.machine === "none";
  if (!b || typeof b !== "object" || Array.isArray(b)) return false;
  const binding = b as Record<string, unknown>;
  if (binding.backend === "sandbox")
    return typeof binding.sandboxKey === "string" && binding.sandboxKey.endsWith(`:${row.runId}`);
  return (
    binding.backend === "resident" &&
    typeof binding.user === "string" &&
    binding.user.length > 0 &&
    typeof binding.container === "string" &&
    binding.container.length > 0 &&
    typeof binding.workspace === "string" &&
    binding.workspace.length > 0 &&
    binding.ownerGen === row.ownerGen &&
    typeof binding.ownerFence === "number" &&
    Number.isSafeInteger(binding.ownerFence) &&
    binding.ownerFence > 0
  );
}

export function prepareCancellation(row: LiveRunRow, actor: CancellationActor, id: string): CancellationPreparation {
  if (row.meta.hosted) return { ok: false, reason: "unsupported" };
  const existing = row.state.cancellation;
  if (existing !== undefined) {
    const cancellation = cancellationOf(existing);
    return cancellation && cancellationMatches(row, cancellation)
      ? { ok: true, row: structuredClone(row), cancellation }
      : { ok: false, reason: "fenced" };
  }
  if (!cancellationRuntimeSupported(row)) return { ok: false, reason: "unsupported" };
  const cancellation = cancellationOf({
    version: 1,
    id,
    runId: row.runId,
    ownerGen: row.ownerGen,
    threadKey: row.threadKey,
    startedAt: row.startedAt,
    ...(row.meta.repo ? { repo: row.meta.repo } : {}),
    actor,
  });
  if (!cancellation || row.stop !== "hard") return { ok: false, reason: "fenced" };
  row.state = { ...row.state, cancellation };
  return { ok: true, row: structuredClone(row), cancellation };
}
