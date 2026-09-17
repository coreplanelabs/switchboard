import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { PR_DESCRIPTION_CAPS } from "../core/prDescription.js";
import { parseSkillMarkdown } from "./frontmatter.js";

// Feature: docs/reference/specs/agent-coding.md item 3 (shape: docs/decisions/0050) —
// the description's CRAFT lives in the first-party `pr-description` skill
// (loaded on demand via use_skill, so every load is a visible skill_use
// event), while the prompt keeps only the field list and the mandatory-load
// instruction. These tests pin the rules on the skill body: the map's fields
// and caps, how to choose the pointers, the mechanical anchor rules, the
// inline-link rule, the fold, the repush rule.
describe("the pr-description skill carries the PR description contract", () => {
  const raw = readFileSync(fileURLToPath(new URL("../../skills/pr-description/SKILL.md", import.meta.url)), "utf8");
  const skill = parseSkillMarkdown(raw);

  it("is a first-party coding skill (no upstream block)", () => {
    expect(skill.name).toBe("pr-description");
    expect(skill.agents).toEqual(["coding"]);
    expect(skill.upstream).toBeUndefined();
  });

  it("names the map's fields in order with the schema's caps, and says caps count visible characters with link targets excluded", () => {
    const order = [
      `\`title\` (${PR_DESCRIPTION_CAPS.title})`,
      `\`tldr\` (${PR_DESCRIPTION_CAPS.tldr})`,
      `\`why\` (${PR_DESCRIPTION_CAPS.why})`,
      `\`pointers\` (1 to ${PR_DESCRIPTION_CAPS.pointers})`,
      `\`feedbackWanted\` (${PR_DESCRIPTION_CAPS.feedbackWanted})`,
      `\`risk\` (${PR_DESCRIPTION_CAPS.risk})`,
      `\`verified\` (${PR_DESCRIPTION_CAPS.verified})`,
    ];
    const positions = order.map((f) => skill.body.indexOf(f));
    expect(positions.every((p) => p >= 0)).toBe(true);
    expect([...positions].sort((a, b) => a - b)).toEqual(positions);
    expect(skill.body).toContain(`\`tldr\` (${PR_DESCRIPTION_CAPS.tldr})`);
    expect(skill.body).toContain(`\`why\` (${PR_DESCRIPTION_CAPS.why})`);
    expect(skill.body).toContain(`\`pointers\` (1 to ${PR_DESCRIPTION_CAPS.pointers})`);
    expect(skill.body).toContain(`\`label\` (${PR_DESCRIPTION_CAPS.pointerLabel})`);
    expect(skill.body).toContain(`\`text\` (${PR_DESCRIPTION_CAPS.pointerText})`);
    expect(skill.body).toContain(`\`risk\` (${PR_DESCRIPTION_CAPS.pointerRisk})`);
    expect(skill.body).toContain(`\`feedbackWanted\` (${PR_DESCRIPTION_CAPS.feedbackWanted})`);
    expect(skill.body).toContain(`\`risk\` (${PR_DESCRIPTION_CAPS.risk})`);
    expect(skill.body).toContain(`\`verified\` (${PR_DESCRIPTION_CAPS.verified})`);
    expect(skill.body).toMatch(/visible characters/);
    expect(skill.body).toMatch(/link'?s target is not counted/i);
  });

  it("tells the author how to choose the pointers: the files a reviewer opens first, one per idea, never stuffed to beat the cap", () => {
    expect(skill.body).toMatch(/files a reviewer would open first/i);
    expect(skill.body).toMatch(/entry point/i);
    expect(skill.body).toMatch(/one pointer per idea, never per file/i);
    expect(skill.body).toMatch(/never stuff/i);
    expect(skill.body).toMatch(/400 changed lines/);
  });

  it("pins the anchor rules: a (path, from, to) range at the pushed head, ≲25 lines, the FULL 40-char sha supplied by the renderer, never a URL written by hand", () => {
    expect(skill.body).toMatch(/\{ path, from, to \}/);
    expect(skill.body).toMatch(/blob\/<head sha>\/<path>#L<from>-L<to>/);
    expect(skill.body).toMatch(/FULL 40-char/);
    expect(skill.body).toMatch(/25 lines/);
    expect(skill.body).toMatch(/you never write a URL or a sha/i);
  });

  it("pins anchor verification: derived from the pushed tree and checked, never written from memory", () => {
    expect(skill.body).toMatch(/[Nn]ever write an anchor from memory/);
    expect(skill.body).toMatch(/git rev-parse HEAD/);
    expect(skill.body).toMatch(/git show <sha>:<path>/);
    expect(skill.body).toMatch(/sed -n '<from>,<to>p'/);
    expect(skill.body).toMatch(/fix the range, not the prose/i);
    expect(skill.body).toMatch(/git cat-file -e <sha>:<path>/);
  });

  it("forbids embedding: pointers are links, a bare permalink is what GitHub embeds, no code in any prose field", () => {
    expect(skill.body).toMatch(/[Nn]ever embed/);
    expect(skill.body).toMatch(/bare permalink on its own line/i);
    expect(skill.body).toMatch(/\[label\]\(permalink\)/);
    expect(skill.body).toMatch(/[Dd]o not paste code or permalinks into any prose field/);
  });

  it("puts decisions, validation criteria and agent notes below the fold with their caps, and asks for an explicit feedback request", () => {
    expect(skill.body).toMatch(/[Bb]elow the fold/);
    expect(skill.body).toContain(`\`decisions\` (0 to ${PR_DESCRIPTION_CAPS.decisions}`);
    expect(skill.body).toContain(`\`validation.criteria\` (1 to ${PR_DESCRIPTION_CAPS.criteria}`);
    expect(skill.body).toContain(`\`agentNotes\` (2,000`);
    expect(skill.body).toMatch(/explicit ask gets engagement/i);
  });

  it("pins the repush rule and what not to write: no file catalog, no per-hunk walkthrough", () => {
    expect(skill.body).toMatch(/every push that changes the head/i);
    expect(skill.body).toMatch(/stale anchors are a lie/i);
    expect(skill.body).toMatch(/[Nn]ever edit the PR body directly/);
    expect(skill.body).toMatch(/no file catalog, no per-hunk walkthrough/i);
  });
});
