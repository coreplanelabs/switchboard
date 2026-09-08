import { describe, expect, it } from "vitest";
import { InMemorySkillStore } from "../skills/index.js";
import type { Skill } from "../skills/index.js";
import { listSkillsTool, useSkillTool } from "./skills.js";
import { TOOLSETS, type ToolContext } from "./workspace.js";

// Feature: docs/reference/specs/skills.md — the read-only list_skills/use_skill tools:
// scoped to the calling agent, present in BOTH the readonly (review) and full
// (coding) toolsets, and unavailable-graceful when no store is injected.

function skill(over: Partial<Skill> = {}): Skill {
  return { name: "s", description: "d", body: "b", agents: ["review"], ...over };
}

function ctx(agentName?: string): ToolContext {
  const skills = new InMemorySkillStore([
    skill({
      name: "code-review-and-quality",
      description: "review it",
      agents: ["review"],
      body: "REVIEW BODY",
      source: "https://example.com/cr",
      upstream: {
        repo: "https://github.com/addyosmani/agent-skills",
        commit: "d".repeat(40),
        path: "skills/code-review-and-quality/SKILL.md",
        bodySha256: "0".repeat(64),
      },
    }),
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

  // docs/reference/specs/skills.md — a load is a first-class fact in the run data: the tool
  // publishes a typed `skill_use` event with the skill's metadata (the generic
  // tool_call only says `use_skill <name>`).
  it("publishes a `skill_use` event with the skill's metadata on a successful load", async () => {
    const published: unknown[] = [];
    const c = { ...ctx("review"), publish: (e: unknown) => published.push(e) };
    await useSkillTool.run({ name: "code-review-and-quality" }, c);
    expect(published).toEqual([
      {
        type: "skill_use",
        skill: "code-review-and-quality",
        description: "review it",
        agent: "review",
        source: "https://example.com/cr",
        // Structured vendoring provenance: repo + commit only — the
        // file path is in `source`, the body digest is a check-time concern.
        upstream: { repo: "https://github.com/addyosmani/agent-skills", commit: "d".repeat(40) },
        bodyBytes: Buffer.byteLength("REVIEW BODY", "utf8"),
      },
    ]);
  });

  it("a skill without vendoring provenance publishes no `upstream` (and no `source` when absent)", async () => {
    const published: Array<Record<string, unknown>> = [];
    const c = { ...ctx("coding"), publish: (e: object) => published.push(e as Record<string, unknown>) };
    await useSkillTool.run({ name: "test-driven-development" }, c);
    expect(published).toHaveLength(1);
    expect(published[0]).not.toHaveProperty("upstream");
    expect(published[0]).not.toHaveProperty("source");
  });

  it("publishes nothing on a refused load, and works without a publisher", async () => {
    const published: unknown[] = [];
    const c = { ...ctx("coding"), publish: (e: unknown) => published.push(e) };
    await useSkillTool.run({ name: "code-review-and-quality" }, c); // out of scope
    await useSkillTool.run({ name: "nope" }, c); // unknown
    expect(published).toEqual([]);
    // No `publish` on the context (CLI, most tests): the load still succeeds.
    const out = await useSkillTool.run({ name: "test-driven-development" }, ctx("coding"));
    expect(out).toContain("CODING BODY");
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
