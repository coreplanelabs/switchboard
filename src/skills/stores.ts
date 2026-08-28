import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { Skill, SkillMeta, SkillStore } from "./types.js";
import { parseSkillMarkdown } from "./frontmatter.js";

// Two implementations of the SkillStore seam (AGENTS.md invariant 2). The
// durable DO-backed upload store is PR2, behind this same interface — the core
// never changes.

/** In-memory store: the skills it is constructed with, scoped by each skill's
 *  `agents` set. Serves tests and dev, and is the serving engine `BundledSkillStore`
 *  composes over its loaded skills. In-process only (never treated as durable —
 *  bundled skills re-load from disk on restart, AGENTS.md invariant 6). */
export class InMemorySkillStore implements SkillStore {
  private readonly byName = new Map<string, Skill>();

  constructor(skills: Skill[] = []) {
    for (const s of skills) this.byName.set(s.name, s);
  }

  list(agent: string): SkillMeta[] {
    return [...this.byName.values()]
      .filter((s) => s.agents.includes(agent))
      .map((s) => ({ name: s.name, description: s.description }));
  }

  get(name: string): Skill | undefined {
    return this.byName.get(name);
  }
}

/** Read every `<dir>/<slug>/SKILL.md`, parsing frontmatter + body. A directory
 *  with no SKILL.md is skipped; a missing `dir` yields [] (the feature simply
 *  offers no skills rather than crashing the bot). A malformed SKILL.md throws
 *  with the offending path — a bundled skill is shipped in the image, so a parse
 *  failure is a build bug to surface, not swallow. */
export function loadBundledSkills(dir: string): Skill[] {
  if (!existsSync(dir)) return [];
  const skills: Skill[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const file = join(dir, entry.name, "SKILL.md");
    if (!existsSync(file)) continue;
    try {
      skills.push(parseSkillMarkdown(readFileSync(file, "utf8")));
    } catch (err) {
      throw new Error(`failed to load skill from ${file}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return skills;
}

/** Bundled store: loads the seeded skills from a `skills/` directory at
 *  construction (the second SkillStore implementation, invariant 2). Serving is
 *  delegated to an InMemorySkillStore over the loaded set. */
export class BundledSkillStore implements SkillStore {
  private readonly inner: InMemorySkillStore;

  constructor(dir: string) {
    this.inner = new InMemorySkillStore(loadBundledSkills(dir));
  }

  list(agent: string): SkillMeta[] {
    return this.inner.list(agent);
  }

  get(name: string): Skill | undefined {
    return this.inner.get(name);
  }
}
