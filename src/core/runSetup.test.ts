import { describe, expect, it } from "vitest";
import { FALLBACK_WORDS, LOST_WORDS, RESIDENT_REFUSAL_CODES, residentRefusalCodeOf } from "./runSetup.js";

describe("run setup words", () => {
  it("keeps the fallback and lost sets disjoint, each with its own unknown word", () => {
    const fallback = new Set<string>(FALLBACK_WORDS);
    expect(LOST_WORDS.filter((w) => fallback.has(w))).toEqual([]);
    expect(FALLBACK_WORDS).toContain("fallback_other");
    expect(LOST_WORDS).toContain("lost_other");
    expect(new Set(FALLBACK_WORDS).size).toBe(FALLBACK_WORDS.length);
    expect(new Set(LOST_WORDS).size).toBe(LOST_WORDS.length);
  });

  it("reads every code the resident answers as itself", () => {
    for (const code of RESIDENT_REFUSAL_CODES) expect(residentRefusalCodeOf(code)).toBe(code);
  });

  it("reads an absent, unknown or bot-only code as fallback_other, never a guess", () => {
    for (const code of [undefined, null, 7, "", "workload-full", "lost_other", "not_resident", "reattach_refused"])
      expect(residentRefusalCodeOf(code)).toBe("fallback_other");
  });
});
