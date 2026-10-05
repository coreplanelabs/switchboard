import type { RouteModel } from "./core/dispatch/route.js";
import { classifyProviderFailure, ProviderFailure, type CompletionResult } from "./core/provider.js";
import type { IntakeReceipt } from "./core/runLedger/types.js";
import { percentile } from "./load/aggregate.js";
import type { Secrets } from "./secrets.js";

export function intakeArm(id: string, threadKey: string, percent: number): "control" | "jev" {
  let hash = 2166136261;
  for (const char of `${id}:${threadKey}`) hash = Math.imul(hash ^ char.charCodeAt(0), 16777619) >>> 0;
  return hash % 100 < percent ? "jev" : "control";
}

interface JevMetadata {
  servedModel: string;
  probabilities: Record<"addressed" | "silent" | "unsure", number>;
  confidence: number;
}

const probability = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= 1;
const tokens = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v) && v >= 0;
const object = (v: unknown): Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : {};

export function jevIntakeModel(
  model: string,
  secrets: Secrets,
  fetcher: typeof fetch,
  record: (result: CompletionResult, metadata: Partial<JevMetadata>) => void,
): RouteModel {
  return async (prompt, options) => {
    const key = secrets.named("TYPESAFE_API_KEY");
    if (!key) throw new ProviderFailure("key-absent", { provider: "typesafe", keyVariable: "TYPESAFE_API_KEY" });
    const response = await fetcher("https://api.typesafe.ai/v1/systemone", {
      method: "POST",
      signal: options.signal,
      headers: { authorization: `Bearer ${key.reveal()}`, "content-type": "application/json" },
      body: JSON.stringify({
        model,
        state: prompt.user,
        questions: {
          intake: {
            type: "choice",
            instructions: {
              context: prompt.system,
              question: "Is this reply addressed to the assistant and does it need a response or action?",
            },
            criteria: {
              addressed: "A request, question, correction or requested information meant for the assistant",
              silent: "Human side conversation, another addressee or an acknowledgment requiring no response",
              unsure: "The available conversation does not establish whether the assistant should respond",
            },
          },
        },
      }),
    });
    const body = object(await response.json());
    if (!response.ok)
      throw new ProviderFailure(classifyProviderFailure({ status: response.status, body }).cause, {
        provider: "typesafe",
        status: response.status,
      });
    const answer = object(object(body.answers).intake);
    const p = object(answer.probabilities);
    const usage = object(body.usage);
    const valid =
      typeof body.model === "string" &&
      body.model.startsWith("jev-") &&
      answer.type === "choice" &&
      ["addressed", "silent", "unsure"].includes(String(answer.choice)) &&
      probability(p.addressed) &&
      probability(p.silent) &&
      probability(p.unsure) &&
      Math.abs(p.addressed + p.silent + p.unsure - 1) <= 0.01 &&
      probability(answer.confidence);
    const result: CompletionResult = {
      content: [],
      stopReason: "tool_use",
      ...(tokens(usage.input_tokens) && tokens(usage.output_tokens)
        ? { usage: { inputTokens: usage.input_tokens, outputTokens: usage.output_tokens } }
        : {}),
    };
    record(
      result,
      valid
        ? {
            servedModel: `typesafe/${body.model}`,
            probabilities: { addressed: p.addressed as number, silent: p.silent as number, unsure: p.unsure as number },
            confidence: answer.confidence as number,
          }
        : {},
    );
    if (!valid) throw new Error("Jev intake response is invalid");
    return {
      tool: "intake",
      input: { answer: answer.choice, reason: "Jev selected the intake verdict from the supplied conversation." },
    };
  };
}

export function intakeExperimentReport(rows: readonly IntakeReceipt[], id: string) {
  const groups = new Map<string, IntakeReceipt[]>();
  for (const row of rows) {
    if (row.experiment?.id !== id) continue;
    const key = `${row.experiment.arm}:${row.model}`;
    const group = groups.get(key) ?? [];
    group.push(row);
    groups.set(key, group);
  }
  return [...groups.values()].map((group) => {
    const measurements = group.map((r) => r.experiment!);
    const latencies = measurements.map((m) => m.elapsedMs).sort((a, b) => a - b);
    const sum = (
      field:
        | "calls"
        | "inputTokens"
        | "outputTokens"
        | "cacheReadTokens"
        | "cacheWriteTokens"
        | "knownCostUsd"
        | "unpricedCalls"
        | "missingUsageCalls",
    ) => measurements.reduce((total, m) => total + m[field], 0);
    return {
      arm: group[0]!.experiment!.arm,
      model: group[0]!.model,
      servedModels: [...new Set(measurements.flatMap((m) => (m.servedModel ? [m.servedModel] : [])))],
      events: group.length,
      threads: new Set(group.map((r) => r.threadKey)).size,
      addressed: group.filter((r) => r.verdict === "addressed").length,
      silent: group.filter((r) => r.verdict === "silent").length,
      timeouts: group.filter((r) => r.source === "timeout").length,
      errors: group.filter((r) => r.source === "error").length,
      p50Ms: percentile(latencies, 50),
      p90Ms: percentile(latencies, 90),
      p95Ms: percentile(latencies, 95),
      calls: sum("calls"),
      inputTokens: sum("inputTokens"),
      outputTokens: sum("outputTokens"),
      cacheReadTokens: sum("cacheReadTokens"),
      cacheWriteTokens: sum("cacheWriteTokens"),
      knownCostUsd: sum("knownCostUsd"),
      unpricedCalls: sum("unpricedCalls"),
      missingUsageCalls: sum("missingUsageCalls"),
      estimatedUsdPer1000: sum("unpricedCalls") === 0 ? (sum("knownCostUsd") * 1000) / group.length : null,
    };
  });
}
