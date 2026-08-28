import { describe, expect, it } from "vitest";
import { InMemorySkillStore } from "../skills/index.js";
import type { Skill } from "../skills/index.js";
import { listSkillsTool, useSkillTool } from "./skills.js";
import { TOOLSETS, type ToolContext } from "./workspace.js";

// Feature: features/skills.md — the read-only list_skills/use_skill tools (#100):
// scoped to the calling agent, present in BOTH the readonly (review) and full
// (coding) toolsets, and unavailable-graceful when no store is injected.

function skill(over: Partial<Skill> = {}): Skill {
  return { name: "s", description: "d", body: "b", agents: ["review"], ...over };
}

function ctx(agentName?: string): ToolContext {
  const skills = new InMemorySkillStore([
    skill({ name: "code-review-and-quality", description: "review it", agents: ["review"], body: "REVIEW BODY", source: "https://example.com/cr" }),
    skill({ name: "test-driven-development", description: "test it", agents: ["coding"], body: "CODING BODY" }),
  ]);
  return { executor: null as never, skills, agentName };
}

describe("list_skills tool", () => {
  it("returns the calling agent's scoped skills (name + description)", async () => {
    const out = await listSkillsTool.run({}, ctx("review"));
    expect(out).toContain("code-review-and-quality");
    expect(out).toContain("review it");
    expect(out).not.toContain("test-driven-development"); // a coding skill, out of scope
  });

  it("coding sees coding skills, not review skills", async () => {
    const out = await listSkillsTool.run({}, ctx("coding"));
    expect(out).toContain("test-driven-development");
    expect(out).not.toContain("code-review-and-quality");
  });

  it("reports unavailable when no store is on the context", async () => {
    const out = await listSkillsTool.run({}, { executor: null as never });
    expect(out).toMatch(/not available/i);
  });
});

describe("use_skill tool", () => {
  it("returns the requested skill's full body into the tool result", async () => {
    const out = await useSkillTool.run({ name: "code-review-and-quality" }, ctx("review"));
    expect(out).toContain("REVIEW BODY");
    expect(out).toContain("code-review-and-quality");
    expect(out).toContain("https://example.com/cr"); // source footer
  });

  it("refuses a skill outside the calling agent's scope (coding cannot load a review skill)", async () => {
    const out = await useSkillTool.run({ name: "code-review-and-quality" }, ctx("coding"));
    expect(out).toMatch(/no skill named/i);
    expect(out).not.toContain("REVIEW BODY");
    // and it points the agent at what it CAN load
    expect(out).toContain("test-driven-development");
  });

  it("refuses an unknown skill name", async () => {
    const out = await useSkillTool.run({ name: "does-not-exist" }, ctx("review"));
    expect(out).toMatch(/no skill named/i);
  });

  it("fails closed: an unidentified caller (agentName undefined) loads nothing", async () => {
    const out = await useSkillTool.run({ name: "code-review-and-quality" }, ctx(undefined));
    expect(out).toMatch(/no skill named/i);
    expect(out).not.toContain("REVIEW BODY"); // the body is never returned
  });

  it("reports unavailable when no store is on the context", async () => {
    const out = await useSkillTool.run({ name: "x" }, { executor: null as never });
    expect(out).toMatch(/not available/i);
  });
});

describe("skill toolset wiring", () => {
  it("list_skills and use_skill are in the coding (full) and review (readonly) toolsets, not web/none", () => {
    const names = (key: string) => (TOOLSETS[key] ?? []).map((t) => t.name);
    for (const tool of ["list_skills", "use_skill"]) {
      expect(names("full")).toContain(tool);
      expect(names("readonly")).toContain(tool);
      expect(names("web")).not.toContain(tool);
      expect(names("none")).not.toContain(tool);
    }
  });
});
