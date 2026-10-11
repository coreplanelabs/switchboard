import { describe, expect, it } from "vitest";
import { isResearchBrief, renderResearchBrief, researchBriefFromSubmission, type ResearchBrief } from "./brief.js";

const ready: ResearchBrief = {
  version: 1,
  goal: "Keep the login session after a restart",
  headSha: "a".repeat(40),
  complexity: "complex",
  decision: "ready",
  evidence: [{ source: "src/session.ts:34", ref: "a".repeat(40), summary: "Session IDs survive in the store" }],
  assumptions: ["The store remains available"],
  unknowns: ["Live provider acceptance remains untested"],
  approach: ["Restore the stored session before asking for a new one"],
  verification: ["Restart with an existing session and assert its ID stays the same"],
};

describe("research brief", () => {
  it("requires complete matching latest intent even when a contradictory blocked event says confirmed", () => {
    const blocked = { ...ready, decision: "blocked" as const, blockedReason: "Retention policy is unknown" };
    expect(researchBriefFromSubmission(ready, [{ type: "research_brief", brief: ready }], true)).toEqual(ready);
    expect(researchBriefFromSubmission(blocked, [{ type: "research_brief", brief: blocked }], true)).toEqual(blocked);
    expect(researchBriefFromSubmission(ready, [{ type: "research_brief", brief: blocked }], true)).toBeUndefined();
    expect(researchBriefFromSubmission(ready, [], true)).toBeUndefined();
    expect(researchBriefFromSubmission(ready, [{ type: "research_brief", brief: ready }], false)).toBeUndefined();
  });

  it("accepts a ready brief and renders evidence, uncertainty and planned proof as advisory context", () => {
    expect(isResearchBrief(ready)).toBe(true);
    expect(renderResearchBrief(ready)).toContain(
      "Source claims are unverified; recheck them against the current target.",
    );
    expect(renderResearchBrief(ready)).toContain("src/session.ts:34");
    expect(renderResearchBrief(ready)).toContain("Live provider acceptance remains untested");
    expect(renderResearchBrief(ready)).toContain("Restart with an existing session and assert its ID stays the same");
  });

  it("accepts a blocked brief and shows its required missing decision", () => {
    const blocked: ResearchBrief = {
      ...ready,
      decision: "blocked",
      blockedReason: "Retention policy is unknown",
      approach: [],
      verification: [],
    };
    expect(isResearchBrief(blocked)).toBe(true);
    expect(renderResearchBrief(blocked)).toContain("Blocked: Retention policy is unknown");
    expect(isResearchBrief({ ...blocked, blockedReason: "" })).toBe(false);
  });

  it("refuses readiness without evidence, source references, an approach or verification", () => {
    expect(isResearchBrief(ready)).toBe(true);
    for (const invalid of [
      { ...ready, evidence: [] },
      { ...ready, headSha: "aaaaaaa" },
      { ...ready, evidence: [{ source: "src/session.ts", summary: "Stores sessions" }] },
      { ...ready, approach: [] },
      { ...ready, verification: [] },
      { ...ready, blockedReason: "Needs a decision" },
      { ...ready, approved: true },
    ])
      expect(isResearchBrief(invalid)).toBe(false);
  });

  it("refuses an oversized or malformed brief while preserving a bounded simple brief", () => {
    expect(isResearchBrief({ ...ready, complexity: "simple", assumptions: [], unknowns: [] })).toBe(true);
    expect(isResearchBrief({ ...ready, goal: "x".repeat(8192) })).toBe(false);
    expect(isResearchBrief({ ...ready, unknowns: [null] })).toBe(false);
    expect(isResearchBrief({ ...ready, decision: "approved" })).toBe(false);
  });
});
