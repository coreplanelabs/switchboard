// The roster (docs/reference/specs/harness.md item 8): every harness a process
// can drive a run on, keyed by the name each object declares. That name is the
// configuration word — `harness: { <preset>: pi | opencode }` at the
// deployment's block or under a channel's or a user's scope — so the
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

/** Where a preset's word is set — `user`, `channel`, `defaults` — defined in a
 *  module of its own (`scope.ts`) because the run record and the timeline fold
 *  read it from programs the harness objects must not enter; offered here too,
 *  where the word's other readers already look. */
export { HARNESS_SCOPES, isHarnessScope, type HarnessScope } from "./scope.js";

/** The roster's object for the word the scopes resolved for a preset
 *  (`ResolvedRequest.harness`), or the default when no scope named it: what a
 *  fresh run opens on and what `run_meta` names. A resumed row is not picked
 *  here — its facts name the harness that judges and drives it
 *  (`roster[facts.harness]`), whatever the scopes say now. */
export function harnessNamed(roster: HarnessRoster, word: HarnessName | undefined): Harness {
  return roster[word ?? DEFAULT_HARNESS];
}

/** The pick for one layer's words alone — `harness.<preset>` off a single
 *  block, else the default: `harnessNamed` over that block's entry, so the two
 *  agree by construction. */
export function harnessForPreset(
  roster: HarnessRoster,
  words: Readonly<Record<string, HarnessName>> | undefined,
  preset: string,
): Harness {
  return harnessNamed(roster, words?.[preset]);
}
