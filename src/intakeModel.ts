// The intake gate's model at the process composition root. It resolves the
// verdict model and `intake.effort` together so the effort decision cannot be
// lost between config and the completion the gate receives.

import { settingsForAgent } from "./config/agents.js";
import { intakeModelRef, type AppConfig } from "./config.js";
import { providerStructuredModel, type RouteModel } from "./core/dispatch/route.js";
import { turnEffort } from "./core/dispatch/turnEffort.js";
import { decideIntake, type IntakeDeps } from "./core/intake.js";
import type { IntakeExperimentMeasurement } from "./core/runLedger/types.js";
import type { CompletionResult, Provider } from "./core/provider.js";
import { parseModelPrices, priceTurn } from "./core/modelPricing.js";
import { intakeArm, jevIntakeModel } from "./intakeExperiment.js";
import { processSecrets, type Secrets } from "./secrets.js";
import type { ProviderTable } from "./core/harness/piAi.js";
import { installedModelRegistry } from "./core/installedModelRegistry.js";
import { resolveModelCard } from "./core/modelCard.js";
import { parseModelRef } from "./core/provider.js";

export async function probeReply(
  config: AppConfig,
  completions: ProviderTable,
  input: { id: string; subject: string; model: string; message: string; gen: number },
  deps: { ledger: NonNullable<IntakeDeps["ledger"]>; now: () => number; secrets?: Secrets; fetch?: typeof fetch },
): Promise<Record<string, unknown>> {
  const id = `shadow-${input.id}`;
  const key = `probe:${input.subject}:${input.id}`;
  // A private per-call configuration never changes the installed classifier.
  const cfg = { ...config, intake: { ...config.intake, experiment: { id, model: input.model, percent: 100 } } };
  let apiCalls = 0;
  const completion = intakeCompletion(cfg, completions, () => {}, {
    secrets: deps.secrets,
    fetch: async (url, options) => {
      if (++apiCalls > 1) throw new Error("reply probe permits one model request");
      return (deps.fetch ?? fetch)(url, options);
    },
  });
  if (!completion) throw new Error("reply classifier unavailable");
  const decision = await decideIntake(
    {
      key,
      threadKey: key,
      mode: "classify",
      model: completion.modelRef,
      gen: input.gen,
      message: input.message,
      turns: [],
      facts: { replierIsRequester: true, mentionsOther: false, threadStartedByBot: false },
    },
    intakeDecisionDeps(completion, deps),
  );
  const stored = await deps.ledger.readIntake(key);
  return {
    kind: "synthetic-reply-probe",
    experiment: id,
    messageKey: key,
    apiCalls,
    persisted: stored?.experiment?.id === id,
    decision,
    liveRoutingChanged: false,
  };
}

export interface IntakeCompletion {
  selectModel?: IntakeDeps["selectModel"];
  modelRef: string;
  model: RouteModel;
  /** The resolved card's output-cap field, for reasoning-aware intake sizing. */
  capField?: string;
}

/** Carry the completion root's model-card decision into the live intake deps. */
export function intakeDecisionDeps(completion: IntakeCompletion, deps: Pick<IntakeDeps, "ledger" | "now">): IntakeDeps {
  return {
    model: completion.model,
    ...(completion.selectModel ? { selectModel: completion.selectModel } : {}),
    ...(completion.capField !== undefined ? { capField: completion.capField } : {}),
    ...deps,
  };
}

/**
 * Build the intake verdict's completion seam. A configured effort is decided
 * against that verdict model's card and its tier plus applied wire word ride
 * the request. Unset sends neither field, preserving the provider's default.
 */
export function intakeCompletion(
  config: AppConfig,
  completions: ProviderTable,
  log: (line: string) => void = console.log,
  experimentOptions: { secrets?: Secrets; fetch?: typeof fetch } = {},
): IntakeCompletion | undefined {
  const modelRef = intakeModelRef(config);
  if (!modelRef) return undefined;

  const ref = parseModelRef(modelRef);
  const card = resolveModelCard(modelRef, config.providers, installedModelRegistry);
  const effort = turnEffort(modelRef, settingsForAgent(config, "intake").effort, config.providers);
  if (effort.note) log(`[intake] effort: ${effort.note}`);
  const experiment = config.intake?.experiment;
  const prices = parseModelPrices((config.costs as { prices?: unknown } | undefined)?.prices);
  const selectModel: IntakeDeps["selectModel"] = experiment
    ? (input) => {
        const arm = intakeArm(experiment.id, input.threadKey, experiment.percent);
        const selectedRef = arm === "jev" ? experiment.model : modelRef;
        const measurement: Omit<IntakeExperimentMeasurement, "elapsedMs"> = {
          id: experiment.id,
          messageKey: input.key,
          arm,
          calls: 0,
          inputTokens: 0,
          outputTokens: 0,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          knownCostUsd: 0,
          unpricedCalls: 0,
          missingUsageCalls: 0,
        };
        let recordedCalls = 0;
        const record = (result: CompletionResult) => {
          recordedCalls++;
          if (!result.usage) measurement.missingUsageCalls++;
          else {
            measurement.inputTokens += result.usage.inputTokens;
            measurement.outputTokens += result.usage.outputTokens;
            measurement.cacheReadTokens += result.usage.cacheReadTokens ?? 0;
            measurement.cacheWriteTokens += result.usage.cacheWriteTokens ?? 0;
          }
          const priced = priceTurn(
            arm === "control"
              ? { ref: modelRef, price: card.price, pricedBy: card.provenance.price }
              : { ref: selectedRef },
            undefined,
            result.usage,
            prices,
          );
          if (priced.usd === undefined) measurement.unpricedCalls++;
          else measurement.knownCostUsd += priced.usd;
        };
        const provider = completions.get(ref.provider);
        const metered: Provider = {
          name: provider.name,
          complete: async (request) => {
            measurement.calls++;
            try {
              const result = await provider.complete(request);
              record(result);
              return result;
            } catch (error) {
              measurement.unpricedCalls++;
              measurement.missingUsageCalls++;
              throw error;
            }
          },
        };
        const jev = jevIntakeModel(
          parseModelRef(experiment.model).model,
          experimentOptions.secrets ?? processSecrets,
          experimentOptions.fetch ?? fetch,
          (result, metadata) => {
            record(result);
            Object.assign(measurement, metadata);
          },
        );
        const model: RouteModel =
          arm === "control"
            ? providerStructuredModel(metered, ref.model, { ...(effort.request ? { effort: effort.request } : {}) })
            : async (prompt, options) => {
                measurement.calls++;
                const recordedBefore = recordedCalls;
                try {
                  return await jev(prompt, options);
                } catch (error) {
                  if (recordedCalls === recordedBefore) {
                    measurement.unpricedCalls++;
                    measurement.missingUsageCalls++;
                  }
                  throw error;
                }
              };
        return {
          model,
          modelRef: selectedRef,
          ...(arm === "control" ? { capField: card.capField } : {}),
          measurement: () => measurement,
        };
      }
    : undefined;
  return {
    ...(selectModel ? { selectModel } : {}),
    modelRef,
    capField: card.capField,
    model: providerStructuredModel(completions.get(ref.provider), ref.model, {
      ...(effort.request ? { effort: effort.request } : {}),
    }),
  };
}
