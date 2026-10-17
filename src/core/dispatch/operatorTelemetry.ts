import { MultiToolCallError, type RouteModelObservation, type RouteToolCall } from "./route.js";
import { typedProviderFailureOf } from "../provider.js";
import { oneLine, redactAndCap } from "../redact.js";
import { prepareToolInput, prepareToolOutput } from "../runEvents.js";
import { newTraceId } from "../trace/ids.js";

import type { RoutingPhase, RoutingStep, RoutingTelemetry, RoutingToolCall } from "../routingTelemetry.js";
export type { RoutingTelemetry } from "../routingTelemetry.js";

const safe = (value: string, cap = 300) => redactAndCap(oneLine(value), cap);
const MAX_STEPS = 32;
const MAX_CALLS = 16;
const MAX_TELEMETRY_BYTES = 24 * 1024;

/** Evidence for the shared routing deadline and redacted tool exchanges.
 * No prompts, provider bodies or reasoning enter this record. A finished snapshot cannot
 * acquire a late provider callback after cancellation. */
export class RoutingRecorder {
  private id = newTraceId();
  private ignoredObservations = 0;
  private steps: RoutingStep[] = [];
  private active?: RoutingStep;
  private timeout?: RoutingTelemetry["timeout"];
  private droppedSteps = 0;
  private sealed = false;
  private usage: import("../runUsage.js").RunUsage = { turns: 0, byModel: {} };
  private usageModelOverflow = false;
  private lostInterval?: { from: number; to: number };
  private onAbort = () => {
    if (this.active) this.timeout ??= { phase: this.active.phase, step: this.active.index, at: this.now() };
  };

  constructor(
    private now: () => number,
    readonly startedAt: number,
    readonly deadlineAt: number,
    private signal: AbortSignal,
    private log?: (
      step: RoutingStep & {
        receiptId: string;
        ignoredObservations?: number;
        ignoredReason?: "sealed" | "phase_ended";
        ignoredAt?: number;
      },
    ) => void,
  ) {
    signal.addEventListener("abort", this.onAbort, { once: true });
  }

  private logStep(step: RoutingStep, ignoredReason?: "sealed" | "phase_ended"): void {
    try {
      this.log?.({
        ...step,
        receiptId: this.id,
        ...(this.ignoredObservations ? { ignoredObservations: this.ignoredObservations } : {}),
        ...(ignoredReason ? { ignoredReason, ignoredAt: this.now() } : {}),
        proposal: undefined,
        question: undefined,
        validation: undefined,
        calls: undefined,
      });
    } catch {
      /* Diagnostics cannot change routing. */
    }
  }

  async during<T>(
    phase: RoutingPhase,
    fn: (observe: (value: RouteModelObservation) => void) => Promise<T>,
    tool?: string,
    input?: unknown,
  ): Promise<T> {
    const start = this.now();
    const step: RoutingStep = {
      index: this.steps.length + this.droppedSteps + 1,
      phase,
      startedAt: start,
      finishedAt: start,
      durationMs: 0,
      remainingMs: Math.max(0, this.deadlineAt - start),
      outcome: "completed",
      ...(tool ? { tool: safe(tool) } : {}),
    };
    if (this.steps.length >= MAX_STEPS) {
      const removed = this.steps.splice(Math.floor(this.steps.length / 2), 1)[0]!;
      this.lostInterval = {
        from: Math.min(this.lostInterval?.from ?? removed.startedAt, removed.startedAt),
        to: Math.max(this.lostInterval?.to ?? removed.finishedAt, removed.finishedAt),
      };
      this.droppedSteps++;
    }
    this.steps.push(step);
    if (tool) this.recordCalls(step, [{ tool, input }]);
    this.active = step;
    let open = true;
    const observe = (value: RouteModelObservation) => {
      if (this.sealed || !open) {
        this.ignoredObservations++;
        this.logStep(step, this.sealed ? "sealed" : "phase_ended");
        return;
      }
      if (value.toolCalls) this.recordCalls(step, value.toolCalls);
      for (const key of ["provider", "model", "effort", "effortWord", "requestId", "stopReason"] as const) {
        if (value[key] !== undefined) step[key] = safe(value[key], 128);
      }
      if (
        value.usage &&
        Number.isFinite(value.usage.inputTokens) &&
        value.usage.inputTokens >= 0 &&
        Number.isFinite(value.usage.outputTokens) &&
        value.usage.outputTokens >= 0
      ) {
        step.usage = { inputTokens: value.usage.inputTokens, outputTokens: value.usage.outputTokens };
        for (const key of ["cacheReadTokens", "cacheWriteTokens"] as const) {
          const count = value.usage[key];
          if (count !== undefined && Number.isFinite(count) && count >= 0) step.usage[key] = count;
        }
      }
      for (const key of ["usd", "feeUsd"] as const) {
        const cost = value[key];
        if (cost !== undefined && Number.isFinite(cost) && cost >= 0) step[key] = cost;
      }
      if (value.priceSource && ["provider", "operator", "registry", "none"].includes(value.priceSource))
        step.priceSource = value.priceSource;
    };
    try {
      const result = await fn(observe);
      if (phase === "model" || phase === "command_fulfillment") {
        if (
          result &&
          typeof result === "object" &&
          "tool" in result &&
          "input" in result &&
          typeof result.tool === "string"
        ) {
          if (!step.calls) this.recordCalls(step, [{ tool: result.tool, input: result.input }]);
          if (phase === "command_fulfillment") this.finishCalls(step, "completed", result.input);
        }
      } else if (tool) this.finishCalls(step, "completed", result);
      return result;
    } catch (error) {
      if (error instanceof MultiToolCallError) {
        if (!step.calls) this.recordCalls(step, error.calls);
        this.finishCalls(
          step,
          "rejected",
          `the answer carried ${error.calls.length} tool calls; one tool call per turn`,
        );
      } else if (step.calls)
        this.finishCalls(step, "error", error instanceof Error ? error.message : "tool call failed");
      step.errorClass = error instanceof Error ? safe(error.name) : "unknown";
      const failure = typedProviderFailureOf(error);
      if (failure) {
        step.failureCause = failure.cause;
        if (failure.diagnostic?.requestId) step.requestId = safe(failure.diagnostic.requestId);
      }
      step.outcome = this.signal.aborted || this.now() >= this.deadlineAt ? "timeout" : "error";
      throw error;
    } finally {
      open = false;
      step.finishedAt = this.now();
      step.durationMs = Math.max(0, step.finishedAt - step.startedAt);
      step.remainingMs = Math.max(0, this.deadlineAt - step.finishedAt);
      if (this.signal.aborted || step.finishedAt >= this.deadlineAt) {
        step.outcome = "timeout";
        this.timeout ??= { phase, step: step.index, at: step.finishedAt };
        if (step.calls) this.finishCalls(step, "timeout", "routing deadline expired; no action admitted");
      }
      this.active = undefined;
      if (phase === "model" || phase === "command_fulfillment") {
        let model = step.model ?? "unknown";
        if (!this.usage.byModel[model] && Object.keys(this.usage.byModel).length >= 8) {
          model = "unknown";
          this.usageModelOverflow = true;
        }
        const usage = (this.usage.byModel[model] ??= {
          turns: 0,
          inputTokens: 0,
          outputTokens: 0,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          usd: 0,
        });
        usage.turns++;
        this.usage.turns++;
        for (const key of ["inputTokens", "outputTokens", "cacheReadTokens", "cacheWriteTokens"] as const)
          usage[key] += step.usage?.[key] ?? 0;
        if (step.usd !== undefined) usage.usd = usage.usd === null ? null : (usage.usd ?? 0) + step.usd;
        else if (step.usage && Object.values(step.usage).some((count) => count > 0)) usage.usd = null;
        if (step.feeUsd !== undefined) usage.feeUsd = (usage.feeUsd ?? 0) + step.feeUsd;
        if (step.priceSource)
          usage.priceSources = [...new Set([...(usage.priceSources ?? []), step.priceSource])].sort();
      }
      this.logStep(step);
    }
  }

  latestModel(): RoutingStep | undefined {
    return [...this.steps].reverse().find((step) => step.phase === "model" || step.phase === "command_fulfillment");
  }

  private recordCalls(step: RoutingStep, calls: readonly (RouteToolCall & { id?: string })[]): void {
    step.calls = calls.slice(0, MAX_CALLS).map((call) => ({
      ...(call.id ? { id: safe(call.id, 128) } : {}),
      tool: safe(call.tool),
      input: prepareToolInput(call.input),
      outcome: "proposed",
    }));
    if (calls.length > MAX_CALLS) step.omittedCalls = calls.length - MAX_CALLS;
  }

  finishCalls(
    step: RoutingStep | undefined,
    outcome: RoutingToolCall["outcome"],
    result: unknown,
    answer?: RouteToolCall | string,
  ): void {
    if (!step || this.sealed) return;
    const target =
      typeof answer === "object" ? { tool: safe(answer.tool), input: prepareToolInput(answer.input) } : undefined;
    const output = typeof result === "string" ? prepareToolOutput(result) : prepareToolInput(result);
    for (const call of step.calls ?? []) {
      if (answer !== undefined && (target === undefined || call.tool !== target.tool || call.input !== target.input))
        continue;
      call.outcome = outcome;
      call.result = output;
    }
  }

  annotate(
    step: RoutingStep | undefined,
    answer: RouteToolCall | string,
    validation?: string,
    validationCode?: string,
  ): void {
    if (!step) return;
    if (this.sealed) {
      this.ignoredObservations++;
      this.logStep(step, "sealed");
      return;
    }
    if (typeof answer !== "string") {
      step.tool = safe(answer.tool);
      if (!step.calls) this.recordCalls(step, [answer]);
      if (answer.tool === "ask" && typeof answer.input === "object" && answer.input !== null) {
        const fields = answer.input as Record<string, unknown>;
        if (typeof fields.text === "string") step.question = safe(fields.text);
        if (typeof fields.proposal === "string") step.proposal = safe(fields.proposal);
      }
    }
    if (validation !== undefined) step.validation = safe(validation);
    if (validation !== undefined) this.finishCalls(step, "rejected", validation, answer);
    if (validationCode !== undefined) step.validationCode = safe(validationCode);
    if (validation !== undefined) {
      this.logStep(step);
    }
  }

  snapshot(): RoutingTelemetry {
    const finishedAt = this.now();
    if (!this.timeout && (this.signal.aborted || finishedAt >= this.deadlineAt) && this.active)
      this.timeout = { phase: this.active.phase, step: this.active.index, at: finishedAt };
    this.sealed = true;
    this.signal.removeEventListener("abort", this.onAbort);
    const snapshot: RoutingTelemetry = structuredClone({
      schema: 1,
      id: this.id,
      startedAt: this.startedAt,
      deadlineAt: this.deadlineAt,
      finishedAt,
      steps: this.steps,
      usage: this.usage,
      ...(this.usageModelOverflow ? { usageModelOverflow: true as const } : {}),
      ...(this.lostInterval ? { lostInterval: this.lostInterval } : {}),
      ...(this.timeout ? { timeout: this.timeout } : {}),
      ...(this.droppedSteps ? { droppedSteps: this.droppedSteps } : {}),
      ...(this.ignoredObservations ? { ignoredObservations: this.ignoredObservations } : {}),
    });
    for (const step of snapshot.steps) {
      for (const call of step.calls ?? []) call.result ??= "No tool execution or selection result was recorded.";
    }
    // Keep the first decision and terminal call when wide Unicode diagnostics
    // consume the record budget. Missing middle steps remain explicit.
    while (
      new TextEncoder().encode(JSON.stringify(snapshot)).byteLength > MAX_TELEMETRY_BYTES &&
      snapshot.steps.length > 2
    ) {
      const removed = snapshot.steps.splice(Math.floor(snapshot.steps.length / 2), 1)[0]!;
      snapshot.lostInterval = {
        from: Math.min(snapshot.lostInterval?.from ?? removed.startedAt, removed.startedAt),
        to: Math.max(snapshot.lostInterval?.to ?? removed.finishedAt, removed.finishedAt),
      };
      snapshot.droppedSteps = (snapshot.droppedSteps ?? 0) + 1;
    }
    // A single parallel answer can exceed the receipt cap. Keep its call
    // identities and mark any additional payload loss before omitting calls.
    while (new TextEncoder().encode(JSON.stringify(snapshot)).byteLength > MAX_TELEMETRY_BYTES) {
      const fields = snapshot.steps
        .flatMap((step) =>
          (step.calls ?? []).flatMap((call) =>
            (["input", "result"] as const).map((key) => ({ call, key, length: call[key]?.length ?? 0 })),
          ),
        )
        .sort((a, b) => b.length - a.length);
      const largest = fields[0];
      if (largest && largest.length > 100) {
        largest.call[largest.key] =
          `${largest.call[largest.key]!.slice(0, Math.floor(largest.length / 2))}…[evidence truncated]`;
        continue;
      }
      const widest = [...snapshot.steps].sort((a, b) => (b.calls?.length ?? 0) - (a.calls?.length ?? 0))[0];
      if (!widest?.calls?.length) break;
      widest.calls.pop();
      widest.omittedCalls = (widest.omittedCalls ?? 0) + 1;
    }
    return snapshot;
  }
}
