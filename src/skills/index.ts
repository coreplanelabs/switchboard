import type { SkillStore } from "./types.js";

export type { Skill, SkillMeta, SkillStore } from "./types.js";
export { parseSkillMarkdown } from "./frontmatter.js";
export { InMemorySkillStore, BundledSkillStore, loadBundledSkills } from "./stores.js";

/** Default location of the bundled `skills/` directory, relative to the process
 *  cwd (repo root in dev, `/app` in the container). Overridable with
 *  SWITCHBOARD_SKILLS_DIR. */
export const DEFAULT_SKILLS_DIR = process.env.SWITCHBOARD_SKILLS_DIR ?? "./skills";

/**
 * Progressive disclosure (#100): the calling agent's scoped skill name +
 * description list, plus a short instruction to load the relevant one with the
 * use_skill tool BEFORE doing the work. Bodies are NEVER included here — they
 * load on demand via use_skill, keeping the prompt small.
 *
 * Returns `undefined` when the agent has no scoped skills (e.g. general /
 * research), so the caller injects nothing and the prompt is unchanged.
 */
export function skillGuidanceBlock(store: SkillStore, agentName: string): string | undefined {
  const metas = store.list(agentName);
  if (metas.length === 0) return undefined;
  const list = metas.map((m) => `- \`${m.name}\`: ${m.description}`).join("\n");
  return (
    "Skills available to you — reusable methodologies you can load with the `use_skill` tool. " +
    "Call `use_skill` with a skill name to load its full instructions into your context BEFORE doing the work " +
    "(e.g. the reviewer loads `code-review-and-quality`; when coding, use spec/build/test skills as the task fits). " +
    "Load the relevant skill first; don't work from these one-line summaries alone.\n" +
    list
  );
}
