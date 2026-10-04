import { settingsForAgent } from "../../config/agents.js";
import type { AppConfig } from "../../config.js";
import type { ProviderTable } from "../harness/piAi.js";
import { installedModelRegistry } from "../installedModelRegistry.js";
import { resolveModelCard } from "../modelCard.js";
import { parseModelRef } from "../provider.js";
import { providerStructuredModel, type RouteModel } from "./route.js";
import { turnEffort } from "./turnEffort.js";

export interface OperatorCompletion {
  modelRef: string;
  model: RouteModel;
  /** Carry the selected card into the caller's reasoning-aware output cap. */
  capField?: string;
}

/** Production and deployment preflight resolve the same front-door settings. */
export function operatorCompletion(
  config: AppConfig,
  completions: ProviderTable,
  log: (line: string) => void = console.log,
): OperatorCompletion | undefined {
  const settings = settingsForAgent(config, "operator");
  const modelRef = settings.model;
  if (!modelRef) return undefined;
  const ref = parseModelRef(modelRef);
  const card = resolveModelCard(modelRef, config.providers, installedModelRegistry);
  const effort = turnEffort(modelRef, settings.effort, config.providers);
  if (effort.note) log(effort.note);
  return {
    modelRef,
    capField: card.capField,
    model: providerStructuredModel(completions.get(ref.provider), ref.model, {
      ...(effort.request ? { effort: effort.request } : {}),
    }),
  };
}
