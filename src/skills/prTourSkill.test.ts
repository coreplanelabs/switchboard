import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parseSkillMarkdown } from "./frontmatter.js";

// Feature: features/agent-coding.md item 3 — the Tour's CRAFT lives in the
// first-party `pr-tour` skill (loaded on demand via use_skill, so every load is
// a visible skill_use event), while the template keeps only the section list
// and the mandatory-load instruction. These tests pin the rules that used to be
// pinned on the template text (#329), now on the skill body.
describe("the pr-tour skill carries the Tour contract", () => {
  const raw = readFileSync(fileURLToPath(new URL("../../skills/pr-tour/SKILL.md", import.meta.url)), "utf8");
  const skill = parseSkillMarkdown(raw);

  it("is a first-party coding skill (no upstream block)", () => {
    expect(skill.name).toBe("pr-tour");
    expect(skill.agents).toEqual(["coding"]);
    expect(skill.upstream).toBeUndefined();
  });

  it("defines the reader-first step shape: heading → description → optional Look for → permalink last", () => {
    expect(skill.body).toMatch(/### N\. <what this change is>/);
    expect(skill.body).toMatch(/\*\*Look for:\*\*/);
    expect(skill.body).toMatch(/permalink .*LAST/i);
    expect(skill.body).toMatch(/reading order/i);
  });

  it("pins the anchor rules: exact permalink shape, full 40-char sha from git rev-parse HEAD, ≲25-line anchors", () => {
    expect(skill.body).toMatch(/blob\/<head sha>\/<path>#L<from>-L<to>/);
    expect(skill.body).toMatch(/FULL 40-char/);
    expect(skill.body).toMatch(/git rev-parse HEAD/);
    expect(skill.body).toMatch(/25 lines/);
  });

  it("pins the catch-all step and the repush regeneration rule", () => {
    expect(skill.body).toMatch(/Remaining changes/);
    expect(skill.body).toMatch(/every push that changes the head/i);
    expect(skill.body).toMatch(/stale anchors are a lie/i);
  });

  it("keeps the markdown-IA rule (headings, bold labels, lists — never a wall of prose)", () => {
    expect(skill.body).toMatch(/headings for steps, bold labels/);
  });
});
