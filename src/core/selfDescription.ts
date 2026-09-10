import type { AgentDef } from "../agents/registry.js";
import type { Capabilities } from "./capabilities.js";

// Self-description (docs/reference/specs/routing-and-config.md behavior 11). Every agent's
// system prompt carries a short, factual account of WHAT SWITCHBOARD IS — its
// agents, how it is addressed, what a resident repo is and how one is
// onboarded, where its runs and memory live, and where its source and specs
// live — so a question about Switchboard itself is answered from fact, not from
// a public-web search: the repository may be private, and a fetch that 404s
// must never become the answer ("repo is private, inaccessible"). The block is
// built from the live agent registry, so the agent list can never drift from
// the code, and from the process's capabilities
// (src/core/capabilities.ts), so it never describes a resident fleet, a run
// history or a memory this installation does not have; the resident cap is the
// resident Worker's own answer, never a constant here. The rest is prose about
// mechanisms that are stable, kept short because it rides on every turn. It
// names the repo and the `docs/reference/specs/*.md` specs as the place to read for detail
// — an agent with the GitHub tools reads them; one without says where the
// answer lives.

export const SELF_DESCRIPTION_HEADER = "About Switchboard (yourself):";
export const SWITCHBOARD_REPO = "coreplanelabs/switchboard";

/** What the block says about the cap when the resident Worker has not answered yet. */
export const RESIDENT_CAP_UNKNOWN_NOTE = "capped (`repo list` shows the cap)";

/** The cap sentence fragment: the Worker's number, or where to read it. */
export function residentCapNote(cap: number | undefined): string {
  return cap === undefined ? RESIDENT_CAP_UNKNOWN_NOTE : `capped at ${cap} residents`;
}

/** Where a per-thread workspace lives, per `execution.type`. */
const WORKSPACE_WHERE: Readonly<Record<Capabilities["execution"], string>> = {
  local: "on the bot host",
  e2b: "in an E2B micro-VM",
  cloudflare: "in a Cloudflare sandbox",
};

/** Which build the answering process is — so "what version are you running?"
 *  is answered from fact, the same fact `status show` and `/healthz` report.
 *  `commit` is `unknown` when nothing stamped the process; the block says so. */
export interface BuildFacts {
  version: string;
  commit: string;
}

/** The build clause of the first line: the package version and the short commit, or the honest word for none. */
export function buildClause(build: BuildFacts | undefined): string {
  if (!build) return "";
  const commit = build.commit === "unknown" ? "an unstamped build" : `build ${build.commit.slice(0, 8)}`;
  return ` (version ${build.version}, ${commit} — \`status show\` reports it live)`;
}

/** `organization` is the config's — the GitHub org (or user) this installation
 *  serves; the block names it so the model knows whose gateway it is. `caps` is
 *  the process's capabilities; `residentCap` the resident Worker's last
 *  reported cap (undefined until known, and irrelevant without residents);
 *  `build` the process's own version and commit (omitted when the caller has none). */
export function selfDescriptionBlock(
  agents: Record<string, Pick<AgentDef, "name" | "description">>,
  organization: string,
  caps: Capabilities,
  residentCap: number | undefined,
  build?: BuildFacts,
): string {
  const agentLines = Object.values(agents)
    .map((a) => `\`${a.name}\` — ${a.description}`)
    .join("; ");
  const surfaces = caps.ingress ? "plus a CLI, an HTTP /api and an MCP surface" : "plus a CLI and an HTTP /api surface";
  const repos = caps.residents
    ? `Repos: the coding and review agents work in a "resident" — an always-warm per-repo environment (a mirror clone, installed deps, a built checkout, refreshed on a schedule and snapshotted) on the resident Worker; each run attaches a worktree on its branch in seconds. An admin onboards a repo with \`repo onboard <owner/name>\` (install/build/test commands are detected from the repo root, \`--install/--build/--test\` override), sees the fleet with \`repo list\`, changes it with \`repo reconfigure\` / \`repo rebuild\` / \`repo offboard\`; the fleet is ${residentCapNote(residentCap)} (\`--evict-coldest\` frees a slot). There is no separate "priority repos" setting: onboarded = warm. Repos that are not onboarded run in a cold per-thread workspace.`
    : `Repos: this installation has no resident (always-warm) repo environments — the coding and review agents clone the repository a request names (an https://github.com/owner/name URL or a PR link) into a per-thread workspace ${WORKSPACE_WHERE[caps.execution]} for the run. Nothing is kept warm between runs, and there is nothing to onboard.`;
  const history = caps.runHistory
    ? ", kept as run history"
    : " while it runs (this installation keeps no run history: a finished run's page goes away about a minute later)";
  const memory = caps.memory
    ? " Cross-session memory is per org/repo/channel/user (`memory list` / `memory forget`)."
    : " This installation has no cross-session memory: a run knows only its own thread.";
  return [
    `${SELF_DESCRIPTION_HEADER} you are Switchboard${buildClause(build)}, the agent gateway of the ${organization} organization. A message arrives on a channel (Slack — an @-mention, thread follow-ups stay on the same agent — ${surfaces}), is routed to an agent, runs on a configured provider/model, and executes tools through an executor.`,
    `Agents: ${agentLines}. Users pick one with an inline \`agent:<name>\` directive (default: general); \`model:\` / \`effort:\` ride the same way (see the runtime-config block).`,
    repos,
    `Runs${caps.memory ? " and memory" : ""}: every run (agent or operator command) has a live page under /runs with its events${history}; runs can be stopped from there.${memory} \`help\` lists every chat command.`,
    `Source of truth: the code lives in the GitHub repo ${SWITCHBOARD_REPO} — README.md (architecture + agents), AGENTS.md (invariants + map), and one behavioral spec per feature under docs/reference/specs/*.md (e.g. docs/reference/specs/resident-repos.md, docs/reference/specs/routing-and-config.md, docs/reference/specs/github-tools.md). For a question about how Switchboard works beyond this block, read those files with the GitHub tools when you have them (github_tree / github_file on ${SWITCHBOARD_REPO}) — they are private, so a public-web fetch 404s; if you have no GitHub tools, answer from this block and point at that path. Never describe yourself as stateless, tool-less by design, or unable to know your own workings.`,
  ].join("\n");
}
