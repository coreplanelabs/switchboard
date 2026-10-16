/** Complete control assessment for explicit, valid operator test inputs. */
export function operatorSettingsEvidence(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    effort: { intent: "unrequested" },
    budget: { intent: "unrequested" },
    severity: { intent: "unrequested" },
    renewals: { intent: "unrequested" },
    verbosity: { intent: "unrequested" },
    ...overrides,
  };
}
