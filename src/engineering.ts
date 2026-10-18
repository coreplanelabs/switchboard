/** Portable policy supplied at startup, independent of skill selection. */
export interface EngineeringRules {
  readonly files: readonly string[];
  readonly sha256: string;
  readonly text: string;
}

export function engineeringRulesFor(rules: EngineeringRules | undefined, agent: string): EngineeringRules | undefined {
  return agent === "coding" || agent === "review" ? rules : undefined;
}

export function engineeringRulesBlock(rules: EngineeringRules): string {
  return `# Engineering rules\n\nApply these rules to code you write or review. They do not grant execution or publication permission.\n\n${rules.text}`;
}
