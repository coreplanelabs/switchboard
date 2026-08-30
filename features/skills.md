# Skill loading

Agents can list and load **skills** — reusable methodologies (spec-driven development, code review, TDD, …) — on demand at run time. Rather than baking a methodology into an agent's system prompt, Switchboard exposes the calling agent's scoped skills as a short name+description list in-prompt (**progressive disclosure**) and lets the model pull the full instructions into its context only when it needs them, via the `use_skill` tool.

This supersedes the closed [#98](https://github.com/coreplanelabs/switchboard/issues/98) (don't bake methodology into prompts — load it as a skill) and tracks [#100](https://github.com/coreplanelabs/switchboard/issues/100).

This is delivered in stages. **PR1 (this spec) ships the seam + two stores + the seeded bundled skills + the load path.** User-uploaded skills backed by a durable store are tracked below as `[gap]` (PR2).

- **Code**: `src/skills/` (`types.ts`, `frontmatter.ts`, `stores.ts`, `index.ts`), tools in `src/tools/skills.ts`, wired into `src/tools/workspace.ts` (TOOLSETS + `ToolContext`) and `src/core/dispatcher.ts` (progressive-disclosure block + tool context); bundled skills under `skills/<slug>/SKILL.md`; production stores wired in `src/index.ts` and `src/cli.ts`.
- **Docs**: [AGENTS.md invariants 2 (≥2 impls, core sees the interface), 4 (namespacing), 7 (no hardcoded models)](../AGENTS.md), [#100](https://github.com/coreplanelabs/switchboard/issues/100).
- **Attribution**: seeded skills are fetched verbatim from [addyosmani/agent-skills](https://github.com/addyosmani/agent-skills) (the frontmatter gains only `agents` scoping + a `source` link; the body is unchanged).
- **Tests**: `src/skills/skills.test.ts`, `src/tools/skills.test.ts`, `src/core/dispatcher.test.ts`.
- **Receipts**: https://github.com/coreplanelabs/switchboard/issues/239

## Behavior (PR1 — seam + load path)

1. **The seam.** The core depends only on the `SkillStore` interface — `list(agent): SkillMeta[]` (name+description, scoped to that agent) and `get(name): Skill | undefined` (the full skill incl. body) — never a concrete store (AGENTS.md invariant 2). Two implementations ship (invariant 2): `BundledSkillStore` (loads seeded skills from a `skills/` dir at startup) and `InMemorySkillStore` (tests/dev; also the serving engine `BundledSkillStore` composes over its loaded set). The durable DO-backed upload store is PR2, behind this same interface.
2. **Skill shape + frontmatter.** A `Skill` is `{ name, description, body, agents, source? }`. A bundled skill is a `SKILL.md` file: a `---`-fenced YAML frontmatter block (`name`, `description`, `agents` — a non-empty string array — and optional `source`) followed by the markdown body. `parseSkillMarkdown` parses it with the repo's `yaml` dependency; a missing frontmatter block or a missing/mistyped required field **throws** (a malformed bundled skill is a build bug to surface, not silently drop). The parsed `body` is the markdown *after* the frontmatter.
3. **Bundled loading.** `loadBundledSkills(dir)` reads every `<dir>/<slug>/SKILL.md`. A directory with no `SKILL.md` is skipped; a **missing `dir` yields `[]`** (the feature offers no skills rather than crashing the bot); a malformed `SKILL.md` throws with the offending path.
4. **Per-agent scoping.** Every skill declares the agents it belongs to in frontmatter `agents`. `list(agent)` returns only skills whose `agents` set includes that agent — the review agent's list excludes coding skills and vice-versa. `get(name)` is scope-agnostic; scope is enforced by the `use_skill` tool, which has the caller's agent name.
5. **Seeded skills.** Review: `code-review-and-quality`, `security-and-hardening`, `performance-optimization`. Coding: `spec-driven-development`, `incremental-implementation`, `test-driven-development`, `doubt-driven-development`.
6. **Tools (read-only).** `list_skills` returns the calling agent's scoped skills (name + description). `use_skill(name)` returns that skill's full body as the tool result (→ into the model's context), with the source appended as a footer. Both add only text to context — they never touch the workspace — so they are in **both** the `readonly` (review) and `full` (coding) toolsets. When no store is on the `ToolContext` (most unit tests), both report themselves unavailable rather than throwing. `use_skill` refuses a skill outside the calling agent's scope, and an unknown name, pointing the agent at what it *can* load.
7. **Progressive disclosure.** In `dispatch()`, when a `SkillStore` is on `CoreDeps`, the dispatcher appends the calling agent's scoped skill name+description list — plus a short instruction to load the relevant one with `use_skill` before working — **after** the agent's own instructions (it is guidance about the agent's tools, not advisory context like the memory block, which rides on the front). **Bodies are never dumped into the prompt** — they load on demand. An agent with no scoped skills (general, research) gets no block, and with no store on `CoreDeps` no block is added at all — the request is unchanged in both cases. Each agent's identity and invariants are preserved: the review agent stays read-only and still defers PR posting to the system ([#79](https://github.com/coreplanelabs/switchboard/issues/79)), because the block is *appended* to the unchanged agent prompt.
8. **Production wiring.** `src/index.ts` (all channels) and `src/cli.ts` construct a `BundledSkillStore(DEFAULT_SKILLS_DIR)` (`./skills`, overridable with `SWITCHBOARD_SKILLS_DIR`) and pass it on `CoreDeps`. The `skills/` dir is copied into the container image (`Dockerfile`). Bundled skills re-load from disk on restart, so no durable in-memory state is introduced (AGENTS.md invariant 6).

## Roadmap (gaps)

- `[gap]` ([#255](https://github.com/coreplanelabs/switchboard/issues/255)) **PR2 — user-uploaded skills.** A durable DO-backed `SkillStore` (mirroring the resident/memory remote-plane pattern) plus an upload path, behind the unchanged `SkillStore` interface — the core does not change.
- **Deferred (later):** per-scope (repo/channel) skills; skill versioning; `skill list`/`skill add`/`skill remove` chat commands; skill enable/disable per agent via config.

## Validation criteria

| Criterion | Proof |
|---|---|
| `parseSkillMarkdown` parses name/description/agents/source and strips the frontmatter from the body; `source` optional | `[unit]` `src/skills/skills.test.ts::parseSkillMarkdown` |
| Malformed frontmatter (missing block, missing/empty `name`/`description`/`agents`) throws | `[unit]` `src/skills/skills.test.ts::parseSkillMarkdown` |
| `InMemorySkillStore.list` scopes by agent (review list excludes coding skills and vice-versa); returns name+description only | `[unit]` `src/skills/skills.test.ts::InMemorySkillStore scoping` |
| `get` returns the full skill including its body, scope-agnostically; undefined for unknown | `[unit]` `src/skills/skills.test.ts::InMemorySkillStore scoping` |
| `BundledSkillStore` reads every `<slug>/SKILL.md`, parses + scopes; missing dir → `[]`; malformed file throws with its path | `[unit]` `src/skills/skills.test.ts::BundledSkillStore (loads from a skills/ dir)` |
| `skillGuidanceBlock`: review's block lists the review skill's description and NOT a coding skill; undefined for an agent with no scoped skills; never includes bodies | `[unit]` `src/skills/skills.test.ts::skillGuidanceBlock (progressive disclosure)` |
| `list_skills` returns the calling agent's scoped metadata; unavailable-graceful with no store | `[unit]` `src/tools/skills.test.ts::list_skills tool` |
| `use_skill` returns the requested skill's full body into the tool result; refuses out-of-scope and unknown names; unavailable-graceful with no store | `[unit]` `src/tools/skills.test.ts::use_skill tool` |
| Both skill tools are in the coding (full) and review (readonly) toolsets, not web/none | `[unit]` `src/tools/skills.test.ts::skill toolset wiring` |
| A review run's system prompt gains the review skill list (excluding coding skills); general (no scoped skills) is byte-identical with or without a store; no store → no block | `[unit]` `src/core/dispatcher.test.ts::skill loading / progressive disclosure (#100)` |
| The store reaches the tool context: `use_skill` in a run returns the body into the next model turn | `[unit]` `src/core/dispatcher.test.ts::skill loading / progressive disclosure (#100) > passes the store to the tool context` |
| Review invariants intact under progressive disclosure (read-only; defers PR posting, #79) | `[unit]` `src/agents/registry.test.ts::review post-step: prompts defer posting to the system (issue #69)` |
| PR2 durable user-uploaded skill store | `[gap]` ([#255](https://github.com/coreplanelabs/switchboard/issues/255)) not built (see roadmap) |
