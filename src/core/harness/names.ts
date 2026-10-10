/** Wire vocabulary shared by saved policy, configuration and the runtime roster. */
export const HARNESS_NAMES = ["pi", "opencode"] as const;

export function isHarnessName(word: unknown): word is (typeof HARNESS_NAMES)[number] {
  return typeof word === "string" && (HARNESS_NAMES as readonly string[]).includes(word);
}
