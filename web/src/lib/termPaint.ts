import type { PrintedTerm } from "@core/core/trace/partition.js";
import type { Phase } from "./runPageModel";

// The ONE mapping from a word of the bar to its paint — a global CSS class
// (web/src/assets/main.css, `.paint-*`) so the bar's segments, the legend's
// swatches and the phase heads' markers can never disagree. Each counted
// bucket has its own hue from the theme's status tokens, with contrast in
// both themes: getting ready blue (`--sb-info`), thinking the data green
// (`--sb-ok`), in tools violet (`--sb-skill`), finishing up muted
// (`--ui-text-dimmed`); the residual is hatched grey and the two loss terms
// are striped amber or hollow — visibly "not work".

export const TERM_PAINT: Record<PrintedTerm, string> = {
  "getting ready": "paint-ready",
  thinking: "paint-thinking",
  "in tools": "paint-tools",
  "finishing up": "paint-finishing",
  "Switchboard overhead": "paint-overhead",
  "not recorded": "paint-lost",
  "not loaded": "paint-elided",
};

/** The bar's word for a phase head, so the head wears the bar's paint. */
export const PHASE_TERM: Record<Phase, PrintedTerm> = {
  getting_ready: "getting ready",
  finishing_up: "finishing up",
};

export function phasePaint(phase: Phase): string {
  return TERM_PAINT[PHASE_TERM[phase]];
}
