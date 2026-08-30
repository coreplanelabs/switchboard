import type { RunnableTool } from "./workspace.js";

// Skill-loading tools (#100). Both are READ-only (they add methodology text to
// the model's context; they never touch the workspace), so they live in BOTH
// the readonly (review) and full (coding) toolsets. The skill store and the
// calling agent's name ride on ToolContext (injected by the dispatcher); the
// tools scope everything to that agent so review sees only review skills and
// coding only coding skills.

export const listSkillsTool: RunnableTool = {
  sideEffectFree: true,
  name: "list_skills",
  description:
    "List the skills available to you: each is a reusable methodology you can load into context with use_skill. " +
    "Returns each skill's name and a one-line description. The same list is also in your system prompt.",
  inputSchema: {
    type: "object",
    properties: {},
  },
  async run(_input, ctx) {
    if (!ctx.skills) return "Skills are not available in this context.";
    const metas = ctx.skills.list(ctx.agentName ?? "");
    if (metas.length === 0) return "No skills are available to you.";
    return metas.map((m) => `- ${m.name}: ${m.description}`).join("\n");
  },
};

export const useSkillTool: RunnableTool = {
  sideEffectFree: true,
  name: "use_skill",
  description:
    "Load a skill's full instructions into your context by name (get names from list_skills or your system prompt). " +
    "Returns the skill body — read it and follow it for the work at hand.",
  inputSchema: {
    type: "object",
    properties: {
      name: { type: "string", description: "The skill name to load (e.g. code-review-and-quality)" },
    },
    required: ["name"],
  },
  async run(input, ctx) {
    if (!ctx.skills) return "Skills are not available in this context.";
    const name = String(input.name ?? "").trim();
    if (!name) return "use_skill: provide a skill `name` (see list_skills).";
    const skill = ctx.skills.get(name);
    // Scope enforcement (fail-closed): an agent may only load a skill scoped to
    // it. An unset agent name matches no skill's `agents` set, so it is refused
    // as if the skill did not exist — an unidentified caller gets nothing.
    const inScope = skill && skill.agents.includes(ctx.agentName ?? "");
    if (!skill || !inScope) {
      const available = ctx.skills.list(ctx.agentName ?? "").map((m) => m.name);
      return (
        `use_skill: no skill named "${name}" is available to you.` +
        (available.length > 0 ? ` Available: ${available.join(", ")}.` : "")
      );
    }
    // The load is a first-class fact in the run data (features/skills.md): the
    // generic tool_call only says `use_skill <name>`; this carries the skill's
    // metadata so runs data and the run page can show what was loaded, for
    // whom, from where, and what it cost in context.
    ctx.publish?.({
      type: "skill_use",
      skill: skill.name,
      description: skill.description,
      agent: ctx.agentName ?? "",
      ...(skill.source ? { source: skill.source } : {}),
      ...(skill.upstream ? { upstream: { repo: skill.upstream.repo, commit: skill.upstream.commit } } : {}),
      bodyBytes: Buffer.byteLength(skill.body, "utf8"),
    });
    const footer = skill.source ? `\n\n_(Skill source: ${skill.source})_` : "";
    return `# Skill: ${skill.name}\n\n${skill.body}${footer}`;
  },
};
