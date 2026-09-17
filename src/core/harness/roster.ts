// The roster (docs/reference/specs/harness.md item 8): every harness a process
// can drive a run on, keyed by the name each object declares. That name is the
// configuration word — `harness: { <preset>: pi | opencode }` — so the
// validator, the loop's pick for a fresh run and a resumed row's judge all read
// one list, and no second spelling of the harness names exists to drift. The
// roster's objects are constructed in the process wiring (`src/index.ts`,
// `src/cli.ts`), never here and never in the agent registry: this module is
// light enough for the configuration validator to import.

import type { Harness, HarnessName } from "./contract.js";

/** The roster's words, in the order the documentation lists them. `satisfies`
 *  holds every word to the facts' discriminator; the roster test holds the
 *  discriminator to this list, so a facts shape without a word, or a word
 *  without a shape, fails to build. */
export const HARNESS_NAMES = ["pi", "opencode"] as const satisfies readonly HarnessName[];

/** The harness a preset runs on when the configuration names none: pi. Nothing
 *  defaults to OpenCode — a deployment puts a preset on it by name. */
export const DEFAULT_HARNESS = "pi" satisfies HarnessName;

/** Every harness the process wires, by name — exhaustive by type, so the wiring
 *  cannot miss one the words admit. */
export type HarnessRoster = Readonly<Record<HarnessName, Harness>>;

/** Whether a configuration value is one of the roster's words: the validator's
 *  test, and the type guard the word's readers narrow on. */
export function isHarnessName(word: unknown): word is HarnessName {
  return typeof word === "string" && (HARNESS_NAMES as readonly string[]).includes(word);
}

/** The harness a preset's fresh runs open on under a configuration: the word
 *  `harness.<preset>` names, else the default. A resumed row is not picked
 *  here — its facts name the harness that judges and drives it
 *  (`roster[facts.harness]`), whatever the preset's word says now. */
export function harnessForPreset(
  roster: HarnessRoster,
  words: Readonly<Record<string, HarnessName>> | undefined,
  preset: string,
): Harness {
  return roster[words?.[preset] ?? DEFAULT_HARNESS];
}
