import { createHash } from "node:crypto";
import { canonicalSeedJson } from "../runLedger/seedManifest.js";
import { RefusalError, refusalOf } from "../refusal.js";
import { TOOL_RECOVERY } from "../budgets.js";
import { redactAndCap } from "../runEvents.js";
import { ExecControlResetError, ExecInfraError, ExecSandboxRestartedError } from "../../execution/executor.js";
import { UncertainStoreError } from "../storeFailure.js";

export interface ToolFailure {
  code: "invalid_input" | "capability_unavailable" | "outcome_unknown" | "lifecycle";
  recovery: "correct" | "stop";
}

/** Translate trusted operation facts before tool output becomes model text. */
export function toolFailureOf(error: unknown, reported?: ToolFailure): ToolFailure | undefined {
  if (
    error instanceof UncertainStoreError ||
    ((error instanceof ExecInfraError ||
      error instanceof ExecControlResetError ||
      error instanceof ExecSandboxRestartedError) &&
      error.commandOutcome === "unknown")
  )
    return { code: "outcome_unknown", recovery: "stop" };
  return reported?.recovery === "stop" ? reported : undefined;
}

interface FailedOperation {
  tool: string;
  input: string;
  error: string;
  count: number;
}
export interface ToolRecoveryState {
  version: 1;
  settled: string[];
  failures: FailedOperation[];
  stopped?: {
    tool: string;
    attempts: number;
    reason: "repeated_failure" | "recovery_limit" | "unavailable" | "outcome_unknown" | "checkpoint_unavailable";
  };
}

const digest = (value: string): string => createHash("sha256").update(value).digest("hex");
const hash = (value: unknown) => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const toolName = (value: unknown) => typeof value === "string" && /^[a-zA-Z0-9_.:-]{1,120}$/.test(value);

export function toolRecoveryStateOf(value: unknown): ToolRecoveryState | undefined {
  if (!value || typeof value !== "object") return;
  const state = value as ToolRecoveryState;
  if (Object.keys(state).some((key) => !["version", "settled", "failures", "stopped"].includes(key))) return;
  if (
    state.version !== 1 ||
    !Array.isArray(state.settled) ||
    state.settled.length > TOOL_RECOVERY.receipts ||
    state.settled.some((id) => !hash(id)) ||
    new Set(state.settled).size !== state.settled.length ||
    !Array.isArray(state.failures) ||
    state.failures.length > TOOL_RECOVERY.receipts
  )
    return;
  if (
    state.failures.some(
      (f) =>
        !f ||
        Object.keys(f).some((key) => !["tool", "input", "error", "count"].includes(key)) ||
        !toolName(f.tool) ||
        !hash(f.input) ||
        !hash(f.error) ||
        !Number.isSafeInteger(f.count) ||
        f.count < 1 ||
        f.count > TOOL_RECOVERY.receipts,
    )
  )
    return;
  if (
    state.stopped !== undefined &&
    (!state.stopped ||
      typeof state.stopped !== "object" ||
      !toolName(state.stopped.tool) ||
      !Number.isSafeInteger(state.stopped.attempts) ||
      state.stopped.attempts < 1 ||
      state.stopped.attempts > TOOL_RECOVERY.receipts ||
      // The retired varied-failure bound describes historical terminal records only.
      (state.stopped.reason === "recovery_limit" && state.stopped.attempts > TOOL_RECOVERY.totalFailures) ||
      Object.keys(state.stopped).some((key) => !["tool", "attempts", "reason"].includes(key)) ||
      !["repeated_failure", "recovery_limit", "unavailable", "outcome_unknown", "checkpoint_unavailable"].includes(
        state.stopped.reason,
      ))
  )
    return;
  const attempts = state.failures.reduce((n, f) => n + f.count, 0);
  if (
    attempts > TOOL_RECOVERY.receipts ||
    (!state.stopped && state.failures.some((f) => f.count >= TOOL_RECOVERY.sameFailure))
  )
    return;
  return structuredClone(state);
}

export class ToolRecoveryStoppedError extends RefusalError {
  constructor(readonly stop: NonNullable<ToolRecoveryState["stopped"]>) {
    super(
      refusalOf(
        "tool_recovery_exhausted",
        stop.reason === "outcome_unknown"
          ? `The ${stop.tool} outcome is unknown. Further model calls were blocked; the original operation remains held.`
          : stop.reason === "checkpoint_unavailable"
            ? `The ${stop.tool} recovery checkpoint could not be confirmed. Further model calls were blocked; original work remains held.`
            : stop.reason === "unavailable"
              ? `The ${stop.tool} operation could not continue safely. Further model calls were blocked; the task remains incomplete.`
              : `Stopped after ${stop.attempts} failed tool attempts (${stop.tool}). Further model calls were blocked; the task remains incomplete.`,
      ),
    );
    this.name = "ToolRecoveryStoppedError";
  }
}

/** One run owns correction attempts, including post-turns. Persist before a
 * result can buy another model call; the bearer gate also joins pending saves.
 * Only hashes leave the tool boundary. This grants no permission to retry effects. */
export class ToolRecovery {
  private state: ToolRecoveryState;
  private pending: Promise<void> = Promise.resolve();
  private nativeDrain?: () => Promise<void>;
  private readonly unknownCalls = new Set<string>();
  private broadOutcomeHold = false;
  /** Each active harness supplies its existing native-call result barrier. */
  bindNativeDrain(drain: () => Promise<void>): void {
    this.nativeDrain = drain;
  }
  constructor(
    previous?: unknown,
    private readonly save?: (state: ToolRecoveryState, tool: string) => Promise<boolean>,
  ) {
    const restored = previous === undefined ? undefined : toolRecoveryStateOf(previous);
    this.state =
      previous === undefined
        ? { version: 1, settled: [], failures: [] }
        : (restored ?? {
            version: 1,
            settled: [],
            failures: [],
            stopped: { tool: "tool", attempts: 1, reason: "checkpoint_unavailable" },
          });
    // The durable format has no causal IDs. A successor must hold the run
    // even if a provider mirror already contains a flattened error result.
    this.broadOutcomeHold =
      this.state.stopped?.reason === "outcome_unknown" || this.state.stopped?.reason === "checkpoint_unavailable";
  }
  get hasUnconfirmedEffects(): boolean {
    return this.broadOutcomeHold || this.unknownCalls.size > 0;
  }
  /** A broad hold does not assert an unknown exit for each individual call. */
  isOutcomeHeld(callId: string): boolean {
    return this.broadOutcomeHold || this.unknownCalls.has(digest(callId));
  }
  /** Only an observation owned by this instance supplies per-call evidence.
   * A restored whole-run hold cannot rewrite another call's known result. */
  isOutcomeUnknown(callId: string): boolean {
    return this.unknownCalls.has(digest(callId));
  }
  snapshot(): ToolRecoveryState {
    return structuredClone(this.state);
  }
  get stopped(): ToolRecoveryState["stopped"] {
    return this.state.stopped ? { ...this.state.stopped } : undefined;
  }
  throwIfStopped(): void {
    if (this.state.stopped) throw new ToolRecoveryStoppedError(this.state.stopped);
  }
  async settled(joinNative = true): Promise<void> {
    if (joinNative && !this.state.stopped) {
      try {
        await this.nativeDrain?.();
      } catch {
        await this.record(
          "native-outcome-unavailable",
          "tool",
          {},
          {
            text: "native tool outcome unavailable",
            detail: { code: "outcome_unknown", recovery: "stop" },
          },
        );
      }
    }
    while (true) {
      const pending = this.pending;
      await pending;
      if (pending === this.pending) return;
    }
  }

  record(
    callId: string,
    tool: string,
    input: unknown,
    failure?: { text: string; detail?: ToolFailure },
    resolved = false,
  ): Promise<void> {
    // A known no-dispatch lifecycle refusal belongs to the existing ending.
    if (failure?.detail?.code === "lifecycle") return this.pending;
    const id = digest(callId);
    if (failure?.detail?.code === "outcome_unknown" && failure.detail.recovery === "stop") {
      if (this.unknownCalls.size < TOOL_RECOVERY.receipts) this.unknownCalls.add(id);
      else if (!this.unknownCalls.has(id)) this.broadOutcomeHold = true;
      // A late result can follow a normal receipt or a different terminal
      // error. Neither removes custody of this possibly executed operation.
      if (
        this.state.settled.includes(id) ||
        this.state.stopped ||
        this.state.settled.length >= TOOL_RECOVERY.receipts
      ) {
        if (this.state.stopped?.reason !== "checkpoint_unavailable")
          this.state.stopped = { tool: toolName(tool) ? tool : "tool", attempts: 1, reason: "outcome_unknown" };
        return this.persist(tool);
      }
    }
    if (this.state.settled.includes(id) || this.state.stopped) return this.pending;
    if (!toolName(tool)) tool = "tool";
    const inputHash = digest(canonicalSeedJson(input));
    const unresolved = this.state.failures.filter((f) => f.tool !== tool || (!resolved && f.input !== inputHash));
    if (!failure && unresolved.length === this.state.failures.length) return this.pending;
    // Keep the retained proof bounded without counting varied task failures
    // as repeated requests. A full checkpoint cannot admit another receipt.
    if (this.state.settled.length >= TOOL_RECOVERY.receipts) {
      this.state.stopped = { tool, attempts: 1, reason: "unavailable" };
      return this.persist(tool);
    }
    if (!failure) {
      this.state.failures = unresolved;
    } else {
      const errorHash = digest(failure.detail?.code ?? redactAndCap(failure.text.split("\n")[0] ?? "", 300));
      const prior = this.state.failures.find((f) => f.tool === tool && f.input === inputHash);
      if (prior) prior.count++;
      else this.state.failures.push({ tool, input: inputHash, error: errorHash, count: 1 });
      const reason =
        failure.detail?.recovery === "stop"
          ? failure.detail.code === "outcome_unknown"
            ? "outcome_unknown"
            : "unavailable"
          : prior && prior.count >= TOOL_RECOVERY.sameFailure
            ? "repeated_failure"
            : undefined;
      if (reason) this.state.stopped = { tool, attempts: prior?.count ?? 1, reason };
    }
    this.state.settled.push(id);
    return this.persist(tool);
  }

  private persist(tool: string): Promise<void> {
    const snapshot = this.snapshot();
    this.pending = this.pending
      .then(async () => {
        if (this.save && !(await this.save(snapshot, tool))) throw new Error("recovery checkpoint unavailable");
      })
      .catch(() => {
        // An unconfirmed terminal snapshot still belongs to its original owner.
        this.state.stopped = {
          ...(this.state.stopped ?? { tool, attempts: 1 }),
          reason: "checkpoint_unavailable",
        };
        this.broadOutcomeHold = true;
      });
    return this.pending;
  }
}
