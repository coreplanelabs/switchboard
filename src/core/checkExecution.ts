import { CheckCapacityError, type CheckOperation } from "../execution/checkOperation.js";
import { createHash } from "node:crypto";
import {
  STREAM_CAP,
  COMMAND_CAP,
  RECEIPT_CAP,
  sha,
  resultSchema,
  checkExecutionStateOf,
  checkOperationSeed,
  checkMetadataOperationSeed,
} from "./checkExecutionSchema.js";
import {
  execDeadline,
  ExecInfraError,
  EXEC_INFRA_REASONS,
  annotateExecutionDiagnostic,
  type Executor,
  type ExecResult,
} from "../execution/executor.js";
import { bashBudgetWithinRun, clampBashTimeout, EXEC_CALL_MARGIN_MS } from "../execution/bashTimeout.js";
import { shellQuote } from "../execution/shellQuote.js";
import { FIRST_TEST_PREFLIGHT_MS } from "./budgets.js";
import { typedExecutionDiagnosticOf, type TypedExecutionDiagnostic } from "../execution/typedExecutionDiagnostic.js";
import { redactAndCap } from "./redact.js";
import type {
  CheckExecutionCapability,
  CheckMetadataFailure,
  CheckExecutionControl,
  CheckExecutionInput,
  CheckExecutionOwner,
  CheckExecutionReceipt,
  CheckExecutionResponse,
  CheckExecutionState,
} from "./checkExecutionTypes.js";

const hash = (value: string): string => createHash("sha256").update(value).digest("hex");
export { checkExecutionReceiptSchema } from "./checkExecutionSchema.js";

export interface CheckExecutionBinding {
  executor: () => Pick<Executor, "execResult" | "inspectCheckResult">;
  workspace: () => string | undefined;
  /** Owned run scratch, supplied by the harness rather than model input. */
  temporaryDirectory?: () => string | undefined;
  /** Initial capability absence is distinct from a later failed durable write. */
  recordingAvailable: boolean;
  owner: CheckExecutionOwner;
  /** The existing harness shell policy, supplied by the runner rather than copied here. */
  authorizeCommand: (command: string, timeoutMs: number) => boolean | Promise<boolean>;
  previous?: unknown;
  save: (state: CheckExecutionState) => Promise<boolean>;
  remainingMs: () => number;
  signal: AbortSignal;
  clock: () => number;
}

/** Only the actual typed cause supplies an allowlisted infrastructure reason.
 * Diagnostic prose and class names are not classifiers. */
function infrastructureReasonOf(error: unknown): CheckMetadataFailure["infrastructureReason"] {
  const seen = new Set<unknown>();
  let current = error;
  while (current instanceof Error && !seen.has(current)) {
    seen.add(current);
    if (current instanceof ExecInfraError && EXEC_INFRA_REASONS.includes(current.reason)) return current.reason;
    current = current.cause;
  }
  return undefined;
}

/** Keep existing operation hashes when the original quoting fits. Double
 * quoting bounds expansion to two characters per input character otherwise. */
function checkCommand(workspace: string, command: string): string {
  const prefix = `cd -- ${shellQuote(workspace)} && bash -c `;
  const quoted = shellQuote(command);
  if (prefix.length + quoted.length <= 64_000) return prefix + quoted;
  return prefix + '"' + command.replace(/["\\$`]/g, "\\$&") + '"';
}

/** Fixed metadata only. Git output is a structural observation, never a control instruction. */
function metadataCommand(workspace: string): string {
  const git = "git --no-optional-locks -c core.fsmonitor=false";
  return [
    "set -eu -o pipefail",
    `cd -- ${shellQuote(workspace)}`,
    "check_cwd=$(pwd -P)",
    `check_head=$(${git} rev-parse --verify HEAD)`,
    `check_fingerprint=$({ ${git} diff --no-ext-diff --no-textconv --binary HEAD; ${git} status --porcelain=v1 -z --untracked-files=all; ${git} ls-files --others --exclude-standard -z | while IFS= read -r -d '' file; do ${git} hash-object -- "$file"; done; } | ${git} hash-object --stdin)`,
    'printf "%s\\n%s\\n%s\\n" "$check_cwd" "$check_head" "$check_fingerprint"',
  ].join("\n");
}

function boundedResult(value: unknown): ExecResult | undefined {
  const parsed = resultSchema.safeParse(value);
  if (!parsed.success) return undefined;
  const r = parsed.data;
  const stdout = redactAndCap(r.stdout, STREAM_CAP);
  const stderr = redactAndCap(r.stderr, STREAM_CAP);
  return {
    stdout: stdout.slice(0, STREAM_CAP),
    stderr: stderr.slice(0, STREAM_CAP),
    exitCode: r.exitCode,
    truncated:
      r.truncated ||
      stdout.length > STREAM_CAP ||
      stderr.length > STREAM_CAP ||
      r.stdout.length > STREAM_CAP ||
      r.stderr.length > STREAM_CAP,
  };
}

/** A thin ledger/executor adapter. This records selected commands; it does not
 * certify their relevance, test collection, side effects or ordering before edits. */
export function createCheckExecution(binding: CheckExecutionBinding): CheckExecutionCapability {
  const owner = { ...binding.owner };
  const parsed = checkExecutionStateOf(binding.previous ?? { version: 1, receipts: [] }, owner);
  const valid = parsed !== undefined;
  const state: CheckExecutionState = parsed ? structuredClone(parsed) : { version: 1, receipts: [] };
  let persistenceFailed = false;
  let queue: Promise<unknown> = Promise.resolve();
  const unavailable = (
    reason: Extract<CheckExecutionResponse, { kind: "unavailable" }>["reason"],
    metadataFailure?: CheckMetadataFailure,
  ): CheckExecutionResponse => ({ kind: "unavailable", reason, ...(metadataFailure ? { metadataFailure } : {}) });
  const persist = async (): Promise<boolean> => {
    try {
      if (await binding.save(structuredClone(state))) return true;
    } catch {
      /* Never dispatch or credit an unrecorded result. */
    }
    persistenceFailed = true;
    return false;
  };
  const authorized = async (command: string, timeoutMs: number): Promise<boolean> => {
    try {
      return (await binding.authorizeCommand(command, timeoutMs)) === true;
    } catch {
      return false;
    }
  };

  const operationKey = (callId: string, inputHash: string) => hash(checkOperationSeed(owner, callId, inputHash));

  async function inspectResult(
    operation: CheckOperation,
    signal: AbortSignal,
    control: CheckExecutionControl,
  ): Promise<ExecResult | undefined> {
    if (signal.aborted || !binding.recordingAvailable) return undefined;
    const budget = bashBudgetWithinRun(
      FIRST_TEST_PREFLIGHT_MS,
      Math.min(binding.remainingMs(), control.remainingMs?.() ?? Infinity),
    );
    if (budget.kind === "exhausted") return undefined;
    try {
      const timeoutMs = budget.kind === "clipped" ? budget.timeoutMs : FIRST_TEST_PREFLIGHT_MS;
      const result = boundedResult(
        await binding
          .executor()
          .inspectCheckResult?.(operation, { signal: execDeadline(timeoutMs, signal), timeoutMs }),
      );
      return signal.aborted ? undefined : result;
    } catch {
      return undefined;
    }
  }

  async function inspect(
    receipt: CheckExecutionReceipt,
    signal: AbortSignal,
    control: CheckExecutionControl,
  ): Promise<boolean> {
    if (!receipt.checkOperation) return false;
    const result = await inspectResult(receipt.checkOperation, signal, control);
    if (!result || [124, 137, 143].includes(result.exitCode)) return false;
    receipt.outcome = { kind: "completed", ...result };
    receipt.completedAt = binding.clock();
    return true;
  }

  async function run(
    input: CheckExecutionInput,
    callId: string,
    signal: AbortSignal,
    control: CheckExecutionControl,
  ): Promise<CheckExecutionResponse> {
    if (!valid) return unavailable("invalid_state");
    if (persistenceFailed) return unavailable("persistence_failed");
    if (
      !input ||
      typeof input.command !== "string" ||
      !input.command.trim() ||
      input.command.length > COMMAND_CAP ||
      input.command.includes("\0") ||
      !["baseline", "verification"].includes(input.purpose) ||
      (input.timeoutMs !== undefined && (!Number.isInteger(input.timeoutMs) || input.timeoutMs <= 0)) ||
      typeof callId !== "string" ||
      !callId ||
      callId.length > 200
    )
      return unavailable("invalid_input");
    const requestedTimeout = clampBashTimeout(input.timeoutMs);
    const inputHash = hash(JSON.stringify([input.command, input.purpose, input.timeoutMs]));
    const prior = state.receipts.find((receipt) => receipt.callId === callId);
    if (prior) {
      if (prior.inputHash !== inputHash) return unavailable("call_mismatch");
      if (
        prior.checkOperation &&
        (prior.checkOperation.key !== operationKey(callId, inputHash) ||
          prior.checkOperation.commandHash !== hash(checkCommand(prior.workspace.cwd, input.command)))
      )
        return unavailable("invalid_state");
      if (["pending", "unknown"].includes(prior.outcome.kind) && (await inspect(prior, signal, control))) {
        if (!(await persist())) return unavailable("persistence_failed");
      }
      return { kind: "recorded", receipt: structuredClone(prior), replayed: true };
    }
    if (state.metadata && (state.metadata.callId !== callId || state.metadata.inputHash !== inputHash))
      return unavailable("reconciliation_required");
    const commandHash = hash(input.command);
    // A new tool id is not permission to retry a command whose response was lost.
    // Do not grow a second recovery loop: existing executor recovery owns quiescence.
    if (
      state.receipts.some(
        (receipt) => receipt.commandHash === commandHash && ["pending", "unknown"].includes(receipt.outcome.kind),
      )
    )
      return unavailable("reconciliation_required");
    if (!binding.recordingAvailable) return unavailable("recording_unavailable");
    const workspace = binding.workspace();
    if (!workspace || !workspace.startsWith("/") || workspace.length > 4096 || /[\r\n\0]/.test(workspace))
      return unavailable("workspace_unavailable");
    if (state.receipts.length >= RECEIPT_CAP) return unavailable("receipt_limit");
    // Keep check state within half the ledger request fence. Reserve the full
    // result before effects: JSON can use six bytes per output character, and
    // the fixed allowance covers the checkout path, hashes and phase metadata.
    const receiptBytes = Buffer.byteLength(
      JSON.stringify({ command: redactAndCap(input.command, COMMAND_CAP).slice(0, COMMAND_CAP), callId, owner }),
    );
    const reserveBytes = receiptBytes + 12 * STREAM_CAP + 32 * 1024;
    if (Buffer.byteLength(JSON.stringify(state)) + reserveBytes > 256 * 1024) return unavailable("capacity");
    if (signal.aborted) return unavailable("stopped");
    const executor = binding.executor();
    if (!executor.execResult) return unavailable("unsupported_executor");
    const budget = (wantedMs = requestedTimeout) => {
      const remainingMs = Math.min(binding.remainingMs(), control.remainingMs?.() ?? Infinity);
      return bashBudgetWithinRun(wantedMs, Number.isFinite(remainingMs) ? remainingMs : 0);
    };
    const firstBudget = budget();
    if (firstBudget.kind === "exhausted") return unavailable("budget_exhausted");
    if (!(await authorized(input.command, firstBudget.kind === "clipped" ? firstBudget.timeoutMs : requestedTimeout)))
      return unavailable("command_refused");
    if (signal.aborted) return unavailable("stopped");
    const metadataBudget = budget(FIRST_TEST_PREFLIGHT_MS);
    if (metadataBudget.kind === "exhausted") return unavailable("budget_exhausted");
    const metadataTimeout = metadataBudget.kind === "clipped" ? metadataBudget.timeoutMs : FIRST_TEST_PREFLIGHT_MS;
    const command = metadataCommand(workspace);
    const retainedMetadata = state.metadata;
    if (
      retainedMetadata &&
      (retainedMetadata.workspace !== workspace ||
        retainedMetadata.checkOperation.key !== hash(checkMetadataOperationSeed(operationKey(callId, inputHash))) ||
        retainedMetadata.checkOperation.commandHash !== hash(command))
    )
      return unavailable("invalid_state");
    if (executor.inspectCheckResult && !retainedMetadata) {
      state.metadata = {
        callId,
        inputHash,
        owner: { ...owner },
        workspace,
        checkOperation: {
          key: hash(checkMetadataOperationSeed(operationKey(callId, inputHash))),
          commandHash: hash(command),
        },
      };
      if (!(await persist())) return unavailable("persistence_failed");
    }
    let observed: ExecResult | undefined;
    let metadataSignal: AbortSignal | undefined;
    try {
      if (retainedMetadata) {
        observed = retainedMetadata.result ?? (await inspectResult(retainedMetadata.checkOperation, signal, control));
        if (!observed) return unavailable("metadata_unavailable", { phase: "execute", kind: "thrown" });
      } else {
        const dispatchBudget = budget(metadataTimeout);
        if (signal.aborted || dispatchBudget.kind === "exhausted") {
          delete state.metadata;
          if (!(await persist())) return unavailable("persistence_failed");
          return unavailable(signal.aborted ? "stopped" : "budget_exhausted");
        }
        const timeoutMs = dispatchBudget.kind === "clipped" ? dispatchBudget.timeoutMs : metadataTimeout;
        metadataSignal = execDeadline(timeoutMs, signal);
        observed = boundedResult(
          await executor.execResult(command, {
            timeoutMs,
            signal: metadataSignal,
            ...(state.metadata ? { checkOperation: state.metadata.checkOperation } : {}),
          }),
        );
      }
    } catch (error) {
      if (error instanceof CheckCapacityError && !retainedMetadata) {
        // The receiver refused before admitting this new preflight. Clear only
        // this known-unstarted intent; older uncertain commands stay held.
        delete state.metadata;
        if (!(await persist())) return unavailable("persistence_failed");
        return unavailable("capacity");
      }
      if (state.metadata) observed = await inspectResult(state.metadata.checkOperation, signal, control);
      if (!observed) {
        annotateExecutionDiagnostic(error, { caller: "check", operation: "metadata" });
        const executionDiagnostic = typedExecutionDiagnosticOf(error);
        const infrastructureReason = infrastructureReasonOf(error);
        let abortSource: CheckMetadataFailure["abortSource"];
        if (infrastructureReason === "aborted") {
          abortSource = "unknown";
          try {
            if (metadataSignal?.aborted) {
              const runAborted = binding.signal.aborted;
              const callAborted = control.signal?.aborted === true;
              if (!runAborted && !callAborted) abortSource = "metadata_deadline";
              else if (runAborted && callAborted) abortSource = "ambiguous";
              else {
                const parent = runAborted ? binding.signal : control.signal;
                abortSource =
                  metadataSignal.reason === parent?.reason
                    ? runAborted
                      ? "run_control"
                      : "call_control"
                    : "ambiguous";
              }
            }
          } catch {
            // Optional signal observation cannot replace the original failure.
          }
        }
        return {
          ...unavailable("metadata_unavailable", {
            phase: "execute",
            kind: "thrown",
            ...(infrastructureReason ? { infrastructureReason } : {}),
            ...(abortSource ? { abortSource, effectiveTimeoutMs: metadataTimeout } : {}),
          }),
          ...(executionDiagnostic ? { executionDiagnostic } : {}),
        };
      }
    }
    if (state.metadata && observed) {
      state.metadata.result = observed;
      if (!(await persist())) return unavailable("persistence_failed");
    }
    if (!observed) return unavailable("metadata_unavailable", { phase: "result", kind: "invalid_result" });
    if (observed.exitCode !== 0 || observed.truncated)
      return unavailable("metadata_unavailable", {
        phase: "result",
        kind: observed.exitCode !== 0 ? "nonzero_exit" : "truncated",
        exitCode: observed.exitCode,
        truncated: observed.truncated,
      });
    const fields = observed.stdout.split("\n");
    if (
      fields.length !== 4 ||
      fields[3] !== "" ||
      !fields[0]?.startsWith("/") ||
      !sha.safeParse(fields[1]).success ||
      !sha.safeParse(fields[2]).success
    )
      return unavailable("metadata_unavailable", {
        phase: "framing",
        kind: "invalid_fields",
        lineCount: fields.length,
        cwdAbsolute: fields[0]?.startsWith("/") === true,
        headValid: sha.safeParse(fields[1]).success,
        fingerprintValid: sha.safeParse(fields[2]).success,
      });
    if (signal.aborted) return unavailable("stopped");
    // A retained observation says where the old preflight ran, not what is at
    // that path now. Keep its result without starting a command against a
    // potentially replaced checkout; only this invocation's observation may proceed.
    if (retainedMetadata) return unavailable("metadata_revalidation_required");
    const nextBudget = budget();
    if (nextBudget.kind === "exhausted") return unavailable("budget_exhausted");
    const timeoutMs = nextBudget.kind === "clipped" ? nextBudget.timeoutMs : requestedTimeout;
    const receipt: CheckExecutionReceipt = {
      callId,
      inputHash,
      commandHash,
      command: redactAndCap(input.command, COMMAND_CAP).slice(0, COMMAND_CAP),
      purpose: input.purpose,
      owner: { ...owner },
      workspace: { cwd: fields[0]!, head: fields[1]!, fingerprint: fields[2]! },
      timeoutMs,
      startedAt: binding.clock(),
      outcome: { kind: "pending" },
      ...(executor.inspectCheckResult
        ? {
            checkOperation: {
              key: operationKey(callId, inputHash),
              commandHash: hash(checkCommand(fields[0]!, input.command)),
            },
          }
        : {}),
    };
    state.receipts.push(receipt);
    delete state.metadata;
    if (!(await persist())) return unavailable("persistence_failed");
    const dispatchAllowed = await authorized(input.command, timeoutMs);
    let executionDiagnostic: TypedExecutionDiagnostic | undefined;
    const dispatchBudget = budget(receipt.timeoutMs + EXEC_CALL_MARGIN_MS);
    // A known pre-dispatch refusal is different from a command whose response
    // was lost. Recording that difference avoids an unnecessary recovery hold.
    if (signal.aborted || dispatchBudget.kind === "exhausted") {
      receipt.outcome = { kind: "not_started", reason: signal.aborted ? "stopped" : "budget_exhausted" };
    } else if (!dispatchAllowed) {
      receipt.outcome = { kind: "not_started", reason: "command_refused" };
    } else {
      receipt.timeoutMs = Math.min(
        timeoutMs,
        dispatchBudget.kind === "clipped" ? dispatchBudget.timeoutMs : requestedTimeout,
      );
      // The executor enforces the process timeout; its response can arrive later.
      const commandSignal = execDeadline(
        dispatchBudget.kind === "clipped" ? dispatchBudget.timeoutMs : receipt.timeoutMs + EXEC_CALL_MARGIN_MS,
        signal,
      );
      try {
        const temporaryDirectory = binding.temporaryDirectory?.();
        const result = boundedResult(
          await executor.execResult(checkCommand(receipt.workspace.cwd, input.command), {
            timeoutMs: receipt.timeoutMs,
            signal: commandSignal,
            ...(receipt.checkOperation ? { checkOperation: receipt.checkOperation } : {}),
            ...(temporaryDirectory ? { env: { TMPDIR: temporaryDirectory } } : {}),
          }),
        );
        receipt.outcome = !result
          ? { kind: "unknown", reason: "invalid_result" }
          : commandSignal.aborted || [124, 137, 143].includes(result.exitCode)
            ? { kind: "unknown", reason: "interrupted", result }
            : { kind: "completed", ...result };
      } catch (error) {
        annotateExecutionDiagnostic(error, { caller: "check", operation: "command" });
        executionDiagnostic = typedExecutionDiagnosticOf(error);
        const infrastructureReason = infrastructureReasonOf(error);
        receipt.outcome =
          error instanceof CheckCapacityError
            ? { kind: "not_started", reason: "capacity" }
            : {
                kind: "unknown",
                reason: commandSignal.aborted ? "interrupted" : "transport",
                ...(infrastructureReason ? { infrastructureReason } : {}),
              };
      }
    }
    if (receipt.outcome.kind === "unknown" && !receipt.outcome.result) await inspect(receipt, signal, control);
    receipt.completedAt = binding.clock();
    if (!(await persist())) return unavailable("persistence_failed");
    return {
      kind: "recorded",
      receipt: structuredClone(receipt),
      ...(executionDiagnostic ? { executionDiagnostic } : {}),
    };
  }

  return {
    run(input, callId, control = {}) {
      const signal = control.signal ? AbortSignal.any([binding.signal, control.signal]) : binding.signal;
      const selected = { ...input };
      const pending = queue.then(() => run(selected, callId, signal, control));
      queue = pending.catch(() => undefined);
      return pending;
    },
  };
}
