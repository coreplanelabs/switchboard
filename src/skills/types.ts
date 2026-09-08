// Skill-loading capability (docs/reference/specs/skills.md): methodology is LOADED as a
// skill on demand, never baked into a prompt. A skill is a reusable
// methodology (spec-driven development, code review, …) that an agent lists
// and loads into its context at run time via the list_skills/use_skill tools.
// This module is the seam; the stores (bundled, in-memory) implement it.

/** A single loadable skill: parsed frontmatter metadata plus the full markdown
 *  body that use_skill returns into the model's context. */
export interface Skill {
  /** Stable identifier the model passes to use_skill (frontmatter `name`). */
  name: string;
  /** One-line summary shown in list_skills and the progressive-disclosure block. */
  description: string;
  /** The skill's instructions — the markdown after the frontmatter. Loaded on
   *  demand (never dumped into the system prompt). */
  body: string;
  /** Which agents this skill is scoped to (frontmatter `agents`, e.g. `[review]`
   *  or `[coding]`). A store lists/serves a skill only to an agent in this set. */
  agents: string[];
  /** Provenance (frontmatter `source`) — where the skill was authored/fetched;
   *  for a vendored skill, the upstream file URL at the pinned commit. */
  source?: string;
  /** Vendoring provenance (frontmatter `upstream`, written by `skills:sync`):
   *  the upstream repo, the commit the body was fetched at, and the file's path
   *  there. Absent on a skill that was not vendored through the manifest. */
  upstream?: SkillUpstream;
}

export interface SkillUpstream {
  repo: string;
  commit: string;
  path: string;
  /** sha-256 (hex) of the vendored body as written by the sync — the offline
   *  drift check recomputes it, so a hand-edited body is caught without a
   *  network call. */
  bodySha256: string;
}

/** The name+description pair surfaced to an agent (list_skills result + the
 *  progressive-disclosure prompt block). Bodies load on demand, so the metadata
 *  is deliberately body-free. */
export interface SkillMeta {
  name: string;
  description: string;
}

/** The boundary the core depends on (AGENTS.md invariant 2: ≥2 implementations,
 *  core sees the interface). PR1 ships `BundledSkillStore` (seeded from the
 *  `skills/` dir) and `InMemorySkillStore` (tests/dev); the durable DO-backed
 *  upload store is PR2, behind this same interface — the core never changes. */
export interface SkillStore {
  /** Skills visible to `agent`, scoped by each skill's `agents` set. Name +
   *  description only (bodies load via `get`/use_skill). */
  list(agent: string): SkillMeta[];
  /** The full skill by name, or undefined if unknown. Scope enforcement (an
   *  agent may only load its own skills) is applied by the use_skill tool, which
   *  has the caller's agent name; the store lookup itself is scope-agnostic. */
  get(name: string): Skill | undefined;
}
