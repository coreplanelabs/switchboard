// The intake gate's model at the process composition root. It resolves the
// verdict model and `intake.effort` together so the effort decision cannot be
// lost between config and the completion the gate receives.

import { intakeModelRef, type AppConfig } from "./config.js";
import { providerStructuredModel, type RouteModel } from "./core/dispatch/route.js";
import { turnEffort } from "./core/dispatch/turnEffort.js";
import type { ProviderTable } from "./core/harness/piAi.js";
import { parseModelRef } from "./core/provider.js";

export interface IntakeCompletion {
  modelRef: string;
  model: RouteModel;
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
): IntakeCompletion | undefined {
  const modelRef = intakeModelRef(config);
  if (!modelRef) return undefined;

  const ref = parseModelRef(modelRef);
  const effort = turnEffort(modelRef, config.intake?.effort, config.providers);
  if (effort.note) log(`[intake] effort: ${effort.note}`);
  return {
    modelRef,
    model: providerStructuredModel(completions.get(ref.provider), ref.model, {
      ...(effort.request ? { effort: effort.request } : {}),
    }),
  };
}
