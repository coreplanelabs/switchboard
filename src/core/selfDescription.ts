import type { AgentDef } from "../agents/registry.js";

// Self-description (features/routing-and-config.md behavior 11). Every agent's
// system prompt carries a short, factual account of WHAT SWITCHBOARD IS — its
// agents, how it is addressed, what a resident repo is and how one is
// onboarded, where its runs and memory live, and where its source and specs
// live — so a question about Switchboard itself is answered from fact, not from
// a public-web search that 404s on our private repo (2026-09-01: research
// answered "repo is private, inaccessible" to "how does the resident system
// work?"). The block is built from the live agent registry, so the agent list
// can never drift from the code; the rest is prose about mechanisms that are
// stable, kept short because it rides on every turn. It names the repo and the
// `features/*.md` specs as the place to read for detail — an agent with the
// GitHub tools reads them; one without says where the answer lives.

export const SELF_DESCRIPTION_HEADER = "About Switchboard (yourself):";
export const SWITCHBOARD_REPO = "coreplanelabs/switchboard";
export const RESIDENT_CAP_NOTE = "capped at 6 residents";

export function selfDescriptionBlock(agents: Record<string, Pick<AgentDef, "name" | "description">>): string {
  const agentLines = Object.values(agents)
    .map((a) => `\`${a.name}\` — ${a.description}`)
    .join("; ");
  return [
    `${SELF_DESCRIPTION_HEADER} you are Switchboard, coreplanelabs' agent gateway. A message arrives on a channel (Slack — an @-mention, thread follow-ups stay on the same agent — plus a CLI, an HTTP /api and an MCP surface), is routed to an agent, runs on a configured provider/model, and executes tools through an executor.`,
    `Agents: ${agentLines}. Users pick one with an inline \`agent:<name>\` directive (default: general); \`model:\` / \`effort:\` ride the same way (see the runtime-config block).`,
    `Repos: the coding and review agents work in a "resident" — an always-warm per-repo environment (a mirror clone, installed deps, a built checkout, refreshed on a schedule and snapshotted) on the resident Worker; each run attaches a worktree on its branch in seconds. An admin onboards a repo with \`repo onboard <owner/name>\` (install/build/test commands are detected from the repo root, \`--install/--build/--test\` override), sees the fleet with \`repo list\`, changes it with \`repo reconfigure\` / \`repo rebuild\` / \`repo offboard\`; the fleet is ${RESIDENT_CAP_NOTE} (\`--evict-coldest\` frees a slot). There is no separate "priority repos" setting: onboarded = warm. Repos that are not onboarded run in a cold per-thread workspace.`,
    `Runs and memory: every run (agent or operator command) has a live page under /runs with its events, kept as run history; runs can be stopped from there. Cross-session memory is per org/repo/channel/user (\`memory list\` / \`memory forget\`). \`help\` lists every chat command.`,
    `Source of truth: the code lives in the private GitHub repo ${SWITCHBOARD_REPO} — README.md (architecture + agents), AGENTS.md (invariants + map), and one behavioral spec per feature under features/*.md (e.g. features/resident-repos.md, features/routing-and-config.md, features/github-tools.md). For a question about how Switchboard works beyond this block, read those files with the GitHub tools when you have them (github_tree / github_file on ${SWITCHBOARD_REPO}) — they are private, so a public-web fetch 404s; if you have no GitHub tools, answer from this block and point at that path. Never describe yourself as stateless, tool-less by design, or unable to know your own workings.`,
  ].join("\n");
}
