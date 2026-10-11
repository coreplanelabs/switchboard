import { describe, expect, it } from "vitest";
import type { ResearchBrief } from "../core/research/brief.js";
import { submitResearchTool } from "./research.js";
import type { ToolContext } from "./runnableTool.js";

const brief: ResearchBrief = {
  version: 1,
  goal: "Keep the login session after a restart",
  headSha: "a".repeat(40),
  complexity: "simple",
  decision: "ready",
  evidence: [{ source: "src/session.ts", ref: "a".repeat(40), summary: "Session IDs survive in the store" }],
  assumptions: [],
  unknowns: [],
  approach: ["Restore the stored session before asking for a new one"],
  verification: ["Restart with an existing session and assert its ID stays the same"],
};
const context = (sink?: ToolContext["onResearchBrief"]) => ({ onResearchBrief: sink }) as ToolContext;

describe("submit_research", () => {
  it("records a valid brief after durable acknowledgment and reports a blocked decision", async () => {
    const stored: ResearchBrief[] = [];
    const ctx = context(async (value) => {
      stored.push(value);
      return true;
    });
    expect(await submitResearchTool.run({ ...brief }, ctx)).toBe(
      "Research brief recorded (simple); source claims remain advisory.",
    );
    expect(stored).toEqual([brief]);
    const blocked = {
      ...brief,
      complexity: "complex" as const,
      decision: "blocked" as const,
      blockedReason: "Retention policy is unknown",
    };
    expect(await submitResearchTool.run(blocked, ctx)).toBe(
      "Research brief recorded; implementation is blocked: Retention policy is unknown",
    );
    expect(stored).toEqual([brief, blocked]);
  });

  it("refuses an incomplete brief and missing or failed durable storage", async () => {
    const stored: ResearchBrief[] = [];
    const ctx = context(async (value) => {
      stored.push(value);
      return true;
    });
    expect(await submitResearchTool.run({ ...brief }, ctx)).toContain("Research brief recorded");
    expect(await submitResearchTool.run({ ...brief, evidence: [] }, ctx)).toContain("error: invalid research brief");
    expect(stored).toEqual([brief]);
    expect(await submitResearchTool.run({ ...brief }, context())).toBe(
      "error: this run has no research brief recorder",
    );
    expect(
      await submitResearchTool.run(
        { ...brief },
        context(async () => false),
      ),
    ).toBe("error: research brief retention was not confirmed");
    expect(
      await submitResearchTool.run(
        { ...brief },
        context(async () => {
          throw new Error("private storage detail");
        }),
      ),
    ).toBe("error: research brief retention was not confirmed");
  });
});
