import { prepareStorageRequest } from "../storeResponse.js";
import { storageTransport } from "../storageTransport.js";
import { residentRouteOf } from "../../execution/residentRoute.js";
import { RUN_STORE_TIMEOUT_MS } from "../runStoreConstants.js";
import { GEN_PATTERN, type LiveRunRow } from "./types.js";
import type { RunRecord } from "../runRecord.js";
import { RUN_ID_PATTERN } from "../runIdentity.js";

export interface CancellationActor {
  kind: "chat" | "access" | "cli" | "mcp";
  id: string;
}
/** Physical namespaces frozen by the original native review admission. */
export interface NativeReviewStopTargets {
  version: 1;
  repo: string;
  threadKey: string;
  sandboxKey: string;
}
export function nativeReviewStopTargetsOf(value: unknown, runId: string): NativeReviewStopTargets | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return;
  const v = value as Record<string, unknown>;
  if (
    Object.keys(v).some((key) => !["version", "repo", "threadKey", "sandboxKey"].includes(key)) ||
    v.version !== 1 ||
    typeof v.repo !== "string" ||
    !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(v.repo) ||
    typeof v.threadKey !== "string" ||
    !v.threadKey ||
    v.threadKey.length > 512 ||
    !/^[A-Za-z0-9_-]{1,56}$/.test(runId) ||
    v.sandboxKey !== `review:${runId}`
  )
    return;
  return structuredClone(v) as unknown as NativeReviewStopTargets;
}
export function sameNativeReviewStopTargets(
  a: NativeReviewStopTargets | undefined,
  b: NativeReviewStopTargets | undefined,
): boolean {
  return a === undefined
    ? b === undefined
    : b !== undefined &&
        a.version === b.version &&
        a.repo === b.repo &&
        a.threadKey === b.threadKey &&
        a.sandboxKey === b.sandboxKey;
}
export function unboundNativeReview(row: LiveRunRow): boolean {
  return (
    row.state.binding === undefined &&
    !row.meta.hosted &&
    row.meta.residentExecution === "native-v1" &&
    row.meta.nativeReviewIsolation === true &&
    row.meta.agent === "review" &&
    row.meta.readonly === true &&
    row.meta.profile?.identity === "read" &&
    row.meta.profile.machine === "repo-resident" &&
    typeof row.meta.repo === "string" &&
    /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(row.meta.repo)
  );
}
export interface RunCancellation {
  version: 1;
  id: string;
  runId: string;
  /** The ledger controller; the binding retains the original runtime owner. */
  ownerGen: string;
  threadKey: string;
  startedAt: number;
  repo?: string;
  actor: CancellationActor;
  targets?: NativeReviewStopTargets;
}
export type CancellationDisposition =
  "workspace-discarded" | "processes-stopped" | "runtime-retired" | "no-workspace" | "isolated-targets-stopped";
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
/** A closed local target check is valid only on its prepare-stage refusal. */
export type CancellationRefusal =
  | { phase: CancellationPhase; cause: (typeof CANCELLATION_REFUSAL_CAUSES)[number]; custody?: never }
  | { phase: "prepare"; cause: "custody-unverified"; custody: CancellationCustodyFailure };
const CANCELLATION_CUSTODY_FAILURES = [
  "hosted",
  "binding-unrecorded",
  "binding-invalid",
  "backend-unsupported",
  "sandbox-target-unverified",
  "resident-route-unverified",
  "resident-identity-incomplete",
  "owner-generation-mismatch",
  "owner-generation-invalid",
  "owner-fence-invalid",
  "resident-repository-missing",
  "host-process",
] as const;
export type CancellationCustodyFailure = (typeof CANCELLATION_CUSTODY_FAILURES)[number];
export interface CancellationObservation {
  step: "initial-kill" | "final-kill";
  phase: "guard" | "launch" | "exit";
  cause: "target-unverified" | "runtime-unavailable" | "timeout" | "exit-unconfirmed" | "native-exec-failed";
  exitCode?: number;
  retirement?: RetirementBlock;
}
const RETIREMENT_BLOCKS = [
  "destroying",
  "hydration-unconfirmed",
  "runtime-unavailable",
  "lifecycle-transition",
  "recreate-held",
  "operations-busy",
  "operation-uid-active",
  "uid-owner-unverified",
  "native-outcome-unknown",
  "boot-unconfirmed",
  "boot-read-unconfirmed",
  "original-runtime-present",
  "uid-presence-unconfirmed",
  "native-observation-unconfirmed",
  "timeout",
  "native-exec-failed",
] as const;
export type RetirementBlock = (typeof RETIREMENT_BLOCKS)[number];
export type RuntimeStopResult =
  | { stopped: true; disposition: CancellationDisposition }
  | { stopped: false; refusal?: CancellationRefusal; observation?: CancellationObservation };

export function cancellationObservationOf(value: unknown): CancellationObservation | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return;
  const v = value as Record<string, unknown>;
  if (
    Object.keys(v).some((key) => !["step", "phase", "cause", "exitCode", "retirement"].includes(key)) ||
    !["initial-kill", "final-kill"].includes(v.step as string) ||
    !["guard", "launch", "exit"].includes(v.phase as string) ||
    !["target-unverified", "runtime-unavailable", "timeout", "exit-unconfirmed", "native-exec-failed"].includes(
      v.cause as string,
    ) ||
    (v.exitCode !== undefined && (typeof v.exitCode !== "number" || !Number.isSafeInteger(v.exitCode))) ||
    (v.retirement !== undefined && !RETIREMENT_BLOCKS.includes(v.retirement as RetirementBlock))
  )
    return;
  return {
    step: v.step as CancellationObservation["step"],
    phase: v.phase as CancellationObservation["phase"],
    cause: v.cause as CancellationObservation["cause"],
    ...(v.exitCode !== undefined ? { exitCode: v.exitCode as number } : {}),
    ...(v.retirement !== undefined ? { retirement: v.retirement as RetirementBlock } : {}),
  };
}

/** Only the closed diagnostic crosses the runtime boundary, never its body. */
export function cancellationRefusalOf(value: unknown): CancellationRefusal | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return;
  const v = value as Record<string, unknown>;
  if (
    Object.keys(v).some((key) => !["phase", "cause", "custody"].includes(key)) ||
    typeof v.phase !== "string" ||
    !["prepare", "sandbox", "resident"].includes(v.phase) ||
    !CANCELLATION_REFUSAL_CAUSES.includes(v.cause as CancellationRefusal["cause"]) ||
    (v.custody !== undefined &&
      (v.phase !== "prepare" ||
        v.cause !== "custody-unverified" ||
        !CANCELLATION_CUSTODY_FAILURES.includes(v.custody as CancellationCustodyFailure)))
  )
    return;
  return v.custody === undefined
    ? { phase: v.phase as CancellationPhase, cause: v.cause as CancellationRefusal["cause"] }
    : { phase: "prepare", cause: "custody-unverified", custody: v.custody as CancellationCustodyFailure };
}

export function cancellationFailureMessage(
  refusal?: CancellationRefusal,
  observation?: CancellationObservation,
): string {
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
      if (refusal.custody === "owner-generation-invalid")
        return "The recorded workspace owner could not be verified. Shutdown is not confirmed.";
      if (refusal.custody === "owner-generation-mismatch")
        return "The recorded workspace owner does not match the run owner. Shutdown is not confirmed.";
      if (refusal.custody === "owner-fence-invalid")
        return "The workspace ownership fence could not be verified. Shutdown is not confirmed.";
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
      if (observation?.phase === "exit" && observation.cause === "exit-unconfirmed" && observation.exitCode === 2)
        return "The original machine's identity could not be confirmed.";
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
      (k) => !["version", "id", "runId", "ownerGen", "threadKey", "startedAt", "actor", "repo", "targets"].includes(k),
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
  if (v.targets !== undefined) {
    const targets = nativeReviewStopTargetsOf(v.targets, v.runId);
    if (!targets || targets.repo !== v.repo || targets.threadKey !== v.threadKey) return;
  }
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
    a.actor.id === b.actor.id &&
    sameNativeReviewStopTargets(a.targets, b.targets)
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

export function cancellationRecordMatches(
  record: Pick<RunRecord, "id" | "startedAt" | "threadKey" | "repo" | "status" | "provisional" | "cancellation">,
  cancellation: RunCancellation,
): boolean {
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
    [
      "workspace-discarded",
      "processes-stopped",
      "runtime-retired",
      "no-workspace",
      "isolated-targets-stopped",
    ].includes(receipt.disposition) &&
    (cancellation.targets !== undefined
      ? receipt.disposition === "isolated-targets-stopped"
      : receipt.disposition !== "isolated-targets-stopped") &&
    sameCancellation(cancellationOf(receipt.cancellation), cancellation)
  );
}

/** Compare the actual runtime target, rather than a caller's display name. */
export function cancellationBindingMatches(actual: unknown, requested: unknown): boolean {
  if (!actual || !requested || typeof actual !== "object" || typeof requested !== "object") return false;
  const a = actual as Record<string, unknown>,
    b = requested as Record<string, unknown>;
  return [
    "backend",
    "ref",
    "workspace",
    "container",
    "user",
    "ownerGen",
    "ownerFence",
    "sandboxKey",
    "residentId",
    "placementId",
  ].every((key) => Object.is(a[key] ?? null, b[key] ?? null));
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
    const request = await prepareStorageRequest("/runs/cancellation/read", {
      storeKey: "runs:default",
      cancellation,
      binding,
    });
    return await storageTransport(
      request,
      {
        url: new URL("/runs/cancellation/read", url),
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        signal: AbortSignal.timeout(RUN_STORE_TIMEOUT_MS),
        timeoutMs: RUN_STORE_TIMEOUT_MS,
        fetch: fetchImpl,
        exceptionDetails: false,
      },
      async (response) => {
        if (!response.ok) return cancellationFailure(cancellation, "prepare", "state-http-refusal");
        const result = (await response.json()) as Record<string, unknown>;
        if (result.prepared !== true) return cancellationFailure(cancellation, "prepare", "state-not-prepared");
        if (result.cancellationId !== cancellation.id)
          return cancellationFailure(cancellation, "prepare", "ticket-mismatch");
        return { prepared: true as const };
      },
    );
  } catch {
    return cancellationFailure(cancellation, "prepare", "state-unreachable");
  }
}

/** A cancellation fence is irreversible by ordinary execution; select only a scoped runtime. */
export function cancellationRuntimeSupported(row: LiveRunRow): boolean {
  return cancellationRuntimeCustodyFailure(row) === undefined;
}

/** The support predicate and its refusal use the same original-target checks. */
export function cancellationRuntimeCustodyFailure(row: LiveRunRow): CancellationCustodyFailure | undefined {
  const b = row.state.binding;
  if (b === undefined)
    return row.meta.profile?.machine === "none" ||
      unboundNativeReview(row) ||
      (!row.meta.hosted &&
        row.meta.selection === "resident" &&
        typeof row.meta.repo === "string" &&
        row.meta.repo.length > 0)
      ? undefined
      : "binding-unrecorded";
  if (!b || typeof b !== "object" || Array.isArray(b)) return "binding-invalid";
  const binding = b as Record<string, unknown>;
  if (binding.backend === "sandbox")
    return typeof binding.sandboxKey === "string" && binding.sandboxKey.endsWith(`:${row.runId}`)
      ? undefined
      : "sandbox-target-unverified";
  if (binding.backend !== "resident") return "backend-unsupported";
  if (residentRouteOf(binding) === null) return "resident-route-unverified";
  if (
    typeof binding.user !== "string" ||
    binding.user.length === 0 ||
    typeof binding.container !== "string" ||
    binding.container.length === 0 ||
    typeof binding.workspace !== "string" ||
    binding.workspace.length === 0
  )
    return "resident-identity-incomplete";
  // Reclaim changes the controller, not the original physical target. The
  // runtime checks this saved owner and fence against its own registration.
  if (typeof binding.ownerGen !== "string" || !GEN_PATTERN.test(binding.ownerGen)) return "owner-generation-invalid";
  if (typeof binding.ownerFence !== "number" || !Number.isSafeInteger(binding.ownerFence) || binding.ownerFence <= 0)
    return "owner-fence-invalid";
}

/** Null explicitly requests discovery; absence never bypasses a stored target. */
export function cancellationTargetMatches(row: LiveRunRow, requested: unknown): boolean {
  const ticket = cancellationOf(row.state.cancellation);
  if (row.state.binding === undefined && ticket?.targets) {
    if (requested === null) return true;
    if (requested && typeof requested === "object" && !Array.isArray(requested)) {
      const target = requested as Record<string, unknown>;
      return (
        Object.keys(target).every((key) => ["backend", "sandboxKey"].includes(key)) &&
        target.backend === "sandbox" &&
        target.sandboxKey === ticket.targets.sandboxKey
      );
    }
    return false;
  }
  if (requested === null)
    return (
      row.state.binding === undefined &&
      !row.meta.hosted &&
      row.meta.selection === "resident" &&
      typeof row.meta.repo === "string" &&
      row.meta.repo.length > 0
    );
  return cancellationBindingMatches(row.state.binding, requested);
}

export function prepareCancellation(
  row: LiveRunRow,
  actor: CancellationActor,
  id: string,
  originalTargets?: NativeReviewStopTargets,
): CancellationPreparation {
  if (row.meta.hosted) return { ok: false, reason: "unsupported" };
  const existing = row.state.cancellation;
  if (existing !== undefined) {
    const cancellation = cancellationOf(existing);
    return cancellation &&
      cancellationMatches(row, cancellation) &&
      (cancellation.targets === undefined || sameNativeReviewStopTargets(cancellation.targets, originalTargets))
      ? { ok: true, row: structuredClone(row), cancellation }
      : { ok: false, reason: "fenced" };
  }
  if (!cancellationRuntimeSupported(row)) return { ok: false, reason: "unsupported" };
  const targets = unboundNativeReview(row) ? nativeReviewStopTargetsOf(originalTargets, row.runId) : undefined;
  if (targets && (targets.repo !== row.meta.repo || targets.threadKey !== row.threadKey))
    return { ok: false, reason: "fenced" };
  if (unboundNativeReview(row) && !targets && row.meta.selection !== "resident")
    return { ok: false, reason: "unsupported" };
  const cancellation = cancellationOf({
    version: 1,
    id,
    runId: row.runId,
    ownerGen: row.ownerGen,
    threadKey: row.threadKey,
    startedAt: row.startedAt,
    ...(row.meta.repo ? { repo: row.meta.repo } : {}),
    actor,
    ...(targets ? { targets } : {}),
  });
  if (!cancellation || row.stop !== "hard") return { ok: false, reason: "fenced" };
  row.state = { ...row.state, cancellation };
  return { ok: true, row: structuredClone(row), cancellation };
}
