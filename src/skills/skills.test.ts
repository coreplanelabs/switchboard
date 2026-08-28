import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseSkillMarkdown } from "./frontmatter.js";
import { BundledSkillStore, InMemorySkillStore, loadBundledSkills } from "./stores.js";
import { skillGuidanceBlock } from "./index.js";
import type { Skill } from "./types.js";

// Feature: features/skills.md — the SkillStore seam, frontmatter parsing,
// per-agent scoping, and the progressive-disclosure prompt block (#100).

const REVIEW_SKILL = `---
name: code-review-and-quality
description: Conducts multi-axis code review.
agents: [review]
source: https://example.com/code-review
---

# Code Review and Quality

Body line one.
Body line two.
`;

const CODING_SKILL = `---
name: test-driven-development
description: Drives development with tests.
agents: [coding]
---

# TDD

Write the test first.
`;

function skill(over: Partial<Skill> = {}): Skill {
  return { name: "s", description: "d", body: "b", agents: ["review"], ...over };
}

describe("parseSkillMarkdown", () => {
  it("parses name/description/agents/source and strips the frontmatter from the body", () => {
    const s = parseSkillMarkdown(REVIEW_SKILL);
    expect(s.name).toBe("code-review-and-quality");
    expect(s.description).toBe("Conducts multi-axis code review.");
    expect(s.agents).toEqual(["review"]);
    expect(s.source).toBe("https://example.com/code-review");
    // The body is the markdown AFTER the frontmatter — no leading `---`.
    expect(s.body.startsWith("# Code Review and Quality")).toBe(true);
    expect(s.body).toContain("Body line two.");
    expect(s.body).not.toContain("name:");
  });

  it("source is optional", () => {
    expect(parseSkillMarkdown(CODING_SKILL).source).toBeUndefined();
  });

  it("throws when there is no frontmatter", () => {
    expect(() => parseSkillMarkdown("# just a body, no frontmatter")).toThrow(/frontmatter/i);
  });

  it("throws when `agents` is missing or empty", () => {
    const noAgents = `---\nname: x\ndescription: y\n---\nbody`;
    expect(() => parseSkillMarkdown(noAgents)).toThrow(/agents/i);
    const emptyAgents = `---\nname: x\ndescription: y\nagents: []\n---\nbody`;
    expect(() => parseSkillMarkdown(emptyAgents)).toThrow(/agents/i);
  });

  it("throws when `name` or `description` is missing", () => {
    expect(() => parseSkillMarkdown(`---\ndescription: y\nagents: [review]\n---\nb`)).toThrow(/name/i);
    expect(() => parseSkillMarkdown(`---\nname: x\nagents: [review]\n---\nb`)).toThrow(/description/i);
  });
});

describe("InMemorySkillStore scoping", () => {
  const store = new InMemorySkillStore([
    skill({ name: "code-review-and-quality", description: "review it", agents: ["review"] }),
    skill({ name: "test-driven-development", description: "test it", agents: ["coding"] }),
    skill({ name: "shared", description: "both", agents: ["review", "coding"] }),
  ]);

  it("list(review) returns review skills and excludes coding-only skills", () => {
    const names = store.list("review").map((m) => m.name);
    expect(names).toContain("code-review-and-quality");
    expect(names).toContain("shared");
    expect(names).not.toContain("test-driven-development");
  });

  it("list(coding) returns coding skills and excludes review-only skills", () => {
    const names = store.list("coding").map((m) => m.name);
    expect(names).toContain("test-driven-development");
    expect(names).toContain("shared");
    expect(names).not.toContain("code-review-and-quality");
  });

  it("list returns name+description metadata only (no body)", () => {
    const meta = store.list("review").find((m) => m.name === "code-review-and-quality");
    expect(meta).toEqual({ name: "code-review-and-quality", description: "review it" });
    expect(meta).not.toHaveProperty("body");
  });

  it("get returns the full skill including its body, scope-agnostically", () => {
    const s = store.get("test-driven-development");
    expect(s?.body).toBe("b");
    expect(s?.agents).toEqual(["coding"]);
  });

  it("get returns undefined for an unknown skill", () => {
    expect(store.get("nope")).toBeUndefined();
  });
});

describe("BundledSkillStore (loads from a skills/ dir)", () => {
  function seedDir(): string {
    const dir = mkdtempSync(join(tmpdir(), "swb-skills-"));
    mkdirSync(join(dir, "code-review-and-quality"), { recursive: true });
    writeFileSync(join(dir, "code-review-and-quality", "SKILL.md"), REVIEW_SKILL);
    mkdirSync(join(dir, "test-driven-development"), { recursive: true });
    writeFileSync(join(dir, "test-driven-development", "SKILL.md"), CODING_SKILL);
    // A stray directory with no SKILL.md must be skipped, not error.
    mkdirSync(join(dir, "not-a-skill"), { recursive: true });
    return dir;
  }

  it("reads every <slug>/SKILL.md, parses it, and scopes by agent", () => {
    const store = new BundledSkillStore(seedDir());
    expect(store.list("review").map((m) => m.name)).toEqual(["code-review-and-quality"]);
    expect(store.list("coding").map((m) => m.name)).toEqual(["test-driven-development"]);
    expect(store.get("code-review-and-quality")?.body).toContain("Body line two.");
  });

  it("loadBundledSkills returns [] for a missing directory (no crash)", () => {
    expect(loadBundledSkills(join(tmpdir(), "swb-skills-does-not-exist-xyz"))).toEqual([]);
  });

  it("loadBundledSkills throws with the offending path on a malformed SKILL.md", () => {
    const dir = mkdtempSync(join(tmpdir(), "swb-skills-bad-"));
    mkdirSync(join(dir, "broken"), { recursive: true });
    writeFileSync(join(dir, "broken", "SKILL.md"), "no frontmatter here");
    expect(() => loadBundledSkills(dir)).toThrow(/broken.*SKILL\.md/);
  });
});

describe("skillGuidanceBlock (progressive disclosure)", () => {
  const store = new InMemorySkillStore([
    skill({ name: "code-review-and-quality", description: "review desc", agents: ["review"], body: "BODY_MARKER_REVIEW" }),
    skill({ name: "test-driven-development", description: "coding desc", agents: ["coding"], body: "BODY_MARKER_CODING" }),
  ]);

  it("review's block lists the review skill's description and NOT a coding skill", () => {
    const block = skillGuidanceBlock(store, "review")!;
    expect(block).toContain("code-review-and-quality");
    expect(block).toContain("review desc");
    expect(block).not.toContain("test-driven-development");
    expect(block).toContain("use_skill"); // tells the model how to load
  });

  it("returns undefined for an agent with no scoped skills (e.g. general)", () => {
    expect(skillGuidanceBlock(store, "general")).toBeUndefined();
  });

  it("does NOT include skill bodies (bodies load on demand)", () => {
    const block = skillGuidanceBlock(store, "review")!;
    expect(block).not.toContain("BODY_MARKER_REVIEW"); // the body is never dumped
  });
});
