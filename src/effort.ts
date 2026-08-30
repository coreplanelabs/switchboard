// Model effort: how hard the model thinks per turn (Anthropic
// `output_config.effort`; skipped for models without support). A first-class
// config dimension resolved through the SAME layers as the model ref
// (features/routing-and-config.md item 2): request directive > thread-sticky
// > user scope > channel scope > defaults > the agent definition > the
// provider's own default. Lower effort = much faster turns; the wall clock is
// the real budget, so effort is what decides how much of it goes to thinking.

export const EFFORT_LEVELS = ["low", "medium", "high"] as const;
export type Effort = (typeof EFFORT_LEVELS)[number];

export function isEffort(value: unknown): value is Effort {
  return typeof value === "string" && (EFFORT_LEVELS as readonly string[]).includes(value);
}

/** The valid levels, for error messages: `low, medium, high`. */
export const EFFORT_LEVELS_HINT = EFFORT_LEVELS.join(", ");
