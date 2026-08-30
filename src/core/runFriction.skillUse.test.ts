import { describe, expect, it } from "vitest";
import type { RunEvent } from "./runEvents.js";
import { analyzeRunFriction } from "./runFriction.js";

// features/skills.md — `skill_use` is a fact about a use_skill call that already
// produced its own tool_call/tool_result pair; the analyzer must not count it as
// a step, a tool call, or a turn boundary.
describe("analyzeRunFriction — skill_use is invisible to friction", () => {
  const T0 = 1_700_000_000_000;
  const base: RunEvent[] = [
    { type: "input", text: "review it", at: T0 },
    { type: "tool_call", tool: "use_skill", summary: "use_skill code-review-and-quality", callId: "c1", at: T0 + 1000 },
    { type: "tool_result", tool: "use_skill", ok: true, summary: "# Skill: code-review-and-quality", callId: "c1", at: T0 + 1100 },
    { type: "answer", text: "LGTM", at: T0 + 5000 },
  ];
  const withSkill: RunEvent[] = [
    ...base.slice(0, 2),
    { type: "skill_use", skill: "code-review-and-quality", description: "d", agent: "review", bodyBytes: 4321, at: T0 + 1050 },
    ...base.slice(2),
  ];

  it("the diagnosis is identical with or without the skill_use event", () => {
    const a = analyzeRunFriction(base, { finished: true });
    const b = analyzeRunFriction(withSkill, { finished: true });
    expect(b.eventCount).toBe(a.eventCount);
    expect(b.toolCalls).toBe(a.toolCalls);
    expect(b.findings).toEqual(a.findings);
    expect(b.runMs).toBe(a.runMs);
  });
});
