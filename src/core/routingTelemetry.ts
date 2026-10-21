import type { TokenUsage } from "./provider.js";
import type { SpanEndEvent } from "./runEvents.js";

export interface RoutingModelObservation {
  /** Transient provider transport events; the recorder stamps them with its clock. */
  transport?: "request_send" | "response_headers";
  status?: number;
  provider?: string;
  model?: string;
  effort?: string;
  effortWord?: string;
  requestId?: string;
  stopReason?: string;
  usage?: TokenUsage;
  usd?: number;
  feeUsd?: number;
  priceSource?: "provider" | "operator" | "registry" | "none";
  /** Raw provider proposals, consumed and redacted by the recorder before retention. */
  toolCalls?: readonly { id?: string; tool: string; input: unknown }[];
}

export type RoutingPhase = "model" | "command_fulfillment" | "context" | "helper" | "catalogue";

export interface RoutingToolCall {
  id?: string;
  tool: string;
  input: string;
  outcome: "proposed" | "selected" | "rejected" | "completed" | "error" | "timeout";
  result?: string;
}

export interface RoutingStep extends Omit<RoutingModelObservation, "toolCalls" | "transport" | "status"> {
  index: number;
  phase: RoutingPhase;
  startedAt: number;
  finishedAt: number;
  durationMs: number;
  remainingMs: number;
  outcome: "completed" | "timeout" | "error";
  /** Count and last-attempt stage, including SDK retries. */
  transportAttempts?: number;
  requestSentAt?: number;
  responseHeadersAt?: number;
  responseStatus?: number;
  tool?: string;
  question?: string;
  proposal?: string;
  validation?: string;
  validationCode?: string;
  failureCause?: string;
  errorClass?: string;
  calls?: RoutingToolCall[];
  omittedCalls?: number;
}

export interface RoutingTelemetry {
  schema: 1;
  /** Unique per routing request; legacy receipts use their start timestamp. */
  id?: string;
  startedAt: number;
  deadlineAt: number;
  finishedAt: number;
  steps: RoutingStep[];
  timeout?: { phase: RoutingPhase; step: number; at: number };
  droppedSteps?: number;
  /** Measured counters before diagnostic trimming. Estimates never enter this aggregate. */
  usage?: import("./runUsage.js").RunUsage;
  usageModelOverflow?: true;
  lostInterval?: { from: number; to: number };
  ignoredObservations?: number;
}

/** Node-free reconstruction shared by timing and usage readers. */
export function routingPhaseSpans(telemetry: RoutingTelemetry | undefined): SpanEndEvent[] {
  if (telemetry?.schema !== 1 || !Array.isArray(telemetry.steps)) return [];
  return telemetry.steps.flatMap((step): SpanEndEvent[] => {
    if (
      !step ||
      !Number.isFinite(step.startedAt) ||
      !Number.isFinite(step.finishedAt) ||
      step.finishedAt < step.startedAt
    )
      return [];
    return [
      {
        type: "span_end",
        spanId: `routing:${telemetry.id ?? telemetry.startedAt}:${step.index}`,
        name: step.phase === "model" || step.phase === "command_fulfillment" ? "model.turn" : "dispatch.route",
        startedAt: step.startedAt,
        durationMs: step.finishedAt - step.startedAt,
        status: step.outcome === "completed" ? "ok" : "error",
        attrs: {
          ...(step.model ? { model: step.model } : {}),
          ...(step.usage ? { ...step.usage } : {}),
          ...(step.usd === undefined ? {} : { usd: step.usd }),
          ...(step.feeUsd === undefined ? {} : { feeUsd: step.feeUsd }),
          ...(step.priceSource === undefined ? {} : { priceSource: step.priceSource }),
        },
        at: step.finishedAt,
      },
    ];
  });
}
