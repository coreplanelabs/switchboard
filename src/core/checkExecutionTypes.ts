import type { CheckOperation } from "../execution/checkOperation.js";
import type { ExecInfraReason } from "../execution/execResult.js";
import type { ExecResult } from "../execution/execResult.js";
import type { TypedExecutionDiagnostic } from "../execution/typedExecutionDiagnostic.js";

export interface CheckExecutionInput {
  command: string;
  purpose: "baseline" | "verification";
  timeoutMs?: number;
}

export interface CheckExecutionOwner {
  runId: string;
  requester: string;
  threadKey: string;
  /** Present only for an actual coordinator-owned plan unit. */
  unit?: string;
  repo: string;
}

/** An observation of the checkout before the command, not an immutable snapshot. */
export interface CheckExecutionReceipt {
  callId: string;
  checkOperation?: CheckOperation;
  inputHash: string;
  commandHash: string;
  command: string;
  purpose: CheckExecutionInput["purpose"];
  owner: CheckExecutionOwner;
  workspace: { cwd: string; head: string; fingerprint: string };
  timeoutMs: number;
  startedAt: number;
  completedAt?: number;
  outcome:
    | { kind: "pending" }
    | { kind: "not_started"; reason: "command_refused" | "budget_exhausted" | "stopped" | "capacity" }
    | ({ kind: "completed" } & ExecResult)
    | {
        kind: "unknown";
        reason: "interrupted" | "transport" | "invalid_result";
        infrastructureReason?: ExecInfraReason;
        result?: ExecResult;
      };
}

export interface CheckMetadataExecution {
  callId: string;
  inputHash: string;
  owner: CheckExecutionOwner;
  workspace: string;
  checkOperation: CheckOperation;
  result?: ExecResult;
}

export interface CheckExecutionState {
  version: 1;
  receipts: CheckExecutionReceipt[];
  /** Original preflight identity, retained until the selected command intent is saved. */
  metadata?: CheckMetadataExecution;
}

/** Safe observations of a refused metadata read, never command/ACK authority. */
export interface CheckMetadataFailure {
  phase: "execute" | "result" | "framing";
  kind: "thrown" | "invalid_result" | "nonzero_exit" | "truncated" | "invalid_fields";
  infrastructureReason?: ExecInfraReason;
  /** Signal observations identify neither remote ending nor retry authority. */
  abortSource?: "metadata_deadline" | "run_control" | "call_control" | "ambiguous" | "unknown";
  effectiveTimeoutMs?: number;
  exitCode?: number;
  truncated?: boolean;
  lineCount?: number;
  cwdAbsolute?: boolean;
  headValid?: boolean;
  fingerprintValid?: boolean;
}

export type CheckExecutionResponse =
  | {
      kind: "recorded";
      receipt: CheckExecutionReceipt;
      replayed?: true;
      executionDiagnostic?: TypedExecutionDiagnostic;
    }
  | {
      kind: "unavailable";
      metadataFailure?: CheckMetadataFailure;
      executionDiagnostic?: TypedExecutionDiagnostic;
      reason:
        | "invalid_input"
        | "command_refused"
        | "invalid_state"
        | "recording_unavailable"
        | "unsupported_executor"
        | "workspace_unavailable"
        | "metadata_unavailable"
        | "budget_exhausted"
        | "stopped"
        | "persistence_failed"
        | "call_mismatch"
        | "reconciliation_required"
        | "receipt_limit"
        | "capacity"
        | "metadata_revalidation_required";
    };

export interface CheckExecutionCapability {
  run(input: CheckExecutionInput, callId: string, control?: CheckExecutionControl): Promise<CheckExecutionResponse>;
}

/** Trusted tool-session limits can only narrow the owning run's authority. */
export interface CheckExecutionControl {
  signal?: AbortSignal;
  remainingMs?: () => number;
}
