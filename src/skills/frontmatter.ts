import YAML from "yaml";
import type { Skill } from "./types.js";

// Parse a SKILL.md file (YAML frontmatter + markdown body) into a Skill. The
// frontmatter is the same `---\n…\n---` block convention the addyosmani skills
// use; we reuse the repo's existing `yaml` dependency (as config.ts does) so an
// `agents: [review]` array parses cleanly.

const FRONTMATTER_RE = /^﻿?---\r?\n([\s\S]*?)\r?\n---\r?\n?/;

/** Parse a raw SKILL.md string into a Skill. Throws with a precise message when
 *  the frontmatter is missing or a required field is absent/mistyped — a
 *  malformed bundled skill is a build-time bug we want to fail loudly on, not a
 *  silently-dropped skill. */
export function parseSkillMarkdown(raw: string): Skill {
  const m = raw.match(FRONTMATTER_RE);
  if (!m) {
    throw new Error("skill file has no YAML frontmatter (expected a leading `---` block)");
  }
  let fm: unknown;
  try {
    fm = YAML.parse(m[1]);
  } catch (err) {
    throw new Error(`skill frontmatter is not valid YAML: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (!fm || typeof fm !== "object" || Array.isArray(fm)) {
    throw new Error("skill frontmatter is not a YAML mapping");
  }
  const record = fm as Record<string, unknown>;

  const name = record.name;
  if (typeof name !== "string" || name.trim() === "") {
    throw new Error("skill frontmatter is missing a non-empty string `name`");
  }
  const description = record.description;
  if (typeof description !== "string" || description.trim() === "") {
    throw new Error(`skill "${name}" frontmatter is missing a non-empty string \`description\``);
  }
  const agents = record.agents;
  if (!Array.isArray(agents) || agents.length === 0 || !agents.every((a) => typeof a === "string" && a.trim() !== "")) {
    throw new Error(`skill "${name}" frontmatter needs a non-empty \`agents\` array of strings (e.g. [review])`);
  }
  const source = typeof record.source === "string" ? record.source.trim() : undefined;

  return {
    name: name.trim(),
    description: description.trim(),
    agents: (agents as string[]).map((a) => a.trim()),
    source,
    body: raw.slice(m[0].length).trim(),
  };
}
