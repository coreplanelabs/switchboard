import { describe, expect, it } from "vitest";
import {
  FALLBACK_WORDS,
  LOST_WORDS,
  RESIDENT_REFUSAL_CODES,
  isLostWord,
  requestedWorkspaceOf,
  residentRefusalCodeOf,
  runSetupOf,
  type RunSetup,
} from "./runSetup.js";

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

describe("requestedWorkspaceOf", () => {
  it("reads the machine class the way the factory provisions it", () => {
    expect(requestedWorkspaceOf("none", "o/r", true)).toBeUndefined();
    expect(requestedWorkspaceOf("blank", "o/r", true)).toBe("blank");
    expect(requestedWorkspaceOf("repo-cold", "o/r", true)).toBe("cold");
    expect(requestedWorkspaceOf("repo-resident", "o/r", true)).toBe("resident");
    // No repository or no resident backend: cold by configuration, not a fallback.
    expect(requestedWorkspaceOf("repo-resident", undefined, true)).toBe("cold");
    expect(requestedWorkspaceOf("repo-resident", "o/r", false)).toBe("cold");
  });
});

describe("runSetupOf", () => {
  it("round-trips every shape the appendix lists", () => {
    const shapes: RunSetup[] = [
      { version: 1, requested: "resident" },
      { version: 1, requested: "resident", restored: true },
      { version: 1, requested: "resident", seeding: "snapshot", reason: "workload_unverified" },
      { version: 1, requested: "resident", seeding: "fresh_after_seed_failure", reason: "fleet_draining" },
      { version: 1, requested: "resident", seeding: "fresh_no_snapshot", reason: "not_resident" },
      { version: 1, requested: "resident", seeding: "snapshot", reason: "workload_full", reallocated: true },
      { version: 1, requested: "cold" },
      { version: 1, requested: "blank" },
      { version: 1, requested: "resident", reason: "sandbox_start_timeout" },
      { version: 1, requested: "cold", reason: "lost_other" },
      { version: 1, requested: "cold", backend: "local" },
      { version: 1, requested: "resident", seeding: "fresh_no_snapshot", reason: "workload_full", backend: "e2b" },
    ];
    for (const shape of shapes) expect(runSetupOf(structuredClone(shape))).toEqual(shape);
  });

  it("refuses shapes whose fields disagree, unknown words and extra keys", () => {
    for (const bad of [
      null,
      [],
      { requested: "resident" },
      { version: 2, requested: "resident" },
      { version: 1, requested: "warm" },
      { version: 1, requested: "resident", reason: "uid_exhausted" },
      { version: 1, requested: "cold", reason: "workload_full" },
      { version: 1, requested: "resident", seeding: "snapshot" },
      { version: 1, requested: "resident", seeding: "snapshot", reason: "lost_other" },
      { version: 1, requested: "resident", seeding: "seeded", reason: "workload_full" },
      { version: 1, requested: "resident", restored: true, reason: "workload_full" },
      { version: 1, requested: "resident", restored: false },
      { version: 1, requested: "resident", reallocated: "yes" },
      { version: 1, requested: "cold", backend: "sandbox" },
      { version: 1, requested: "resident", restored: true, backend: "local" },
      { version: 1, requested: "resident", note: "resident full — using fresh sandbox" },
    ])
      expect(runSetupOf(bad), JSON.stringify(bad)).toBeUndefined();
  });

  it("tells a lost word from a fallback word", () => {
    expect(isLostWord("ref_unresolved")).toBe(true);
    expect(isLostWord("workload_full")).toBe(false);
    expect(isLostWord(undefined)).toBe(false);
  });
});
